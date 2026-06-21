import {
  BadRequestException,
  Inject,
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  STORAGE_KIND_CONFIG,
  STORAGE_PROVIDER,
} from './storage.types';
import type {
  StorageGetResult,
  StorageKind,
  StorageProvider,
} from './storage.types';

export interface UploadInput {
  file: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  };
  kind: StorageKind;
  ownerScope: OwnerScope;
}

/**
 * Who the file belongs to. The combination is encoded into the object key
 * so files cluster sensibly (and so a cleanup pass for a deleted client
 * can match the prefix). Not strictly access-controlled here — that's
 * controlled at the controller layer — but it's the audit breadcrumb on
 * the key itself.
 */
export interface OwnerScope {
  tenantId: string;
  /** User who initiated the upload (the actor on the JWT). */
  uploaderUserId: string;
  /** Subject — whose record this file is being attached to. */
  subjectUserId?: string;
}

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  contentType: string;
  storedAt: Date;
  originalName: string;
}

/**
 * Front door for storage. Every caller (controller, service) goes through
 * this class; no one talks to the provider directly. That single seam is
 * what makes the eventual S3/R2 swap a one-line change in storage.module.ts.
 *
 * Responsibilities:
 *   - Validate uploads against the per-kind whitelist (mime + size).
 *   - Mint the object key (collision-proof UUIDs + a sensible directory
 *     structure that mirrors the cloud convention).
 *   - Delegate to whichever StorageProvider is bound.
 *   - Build the FE-friendly URL the controller layer returns to the FE.
 */
@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  async upload(input: UploadInput): Promise<UploadResult> {
    const cfg = STORAGE_KIND_CONFIG[input.kind];
    if (!cfg) {
      throw new BadRequestException(`Unknown upload kind: ${input.kind}`);
    }

    if (!cfg.allowedMimeTypes.includes(input.file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `Files of type "${input.file.mimetype}" are not allowed for ${input.kind}. ` +
          `Allowed: ${cfg.allowedMimeTypes.join(', ')}.`,
      );
    }
    if (input.file.size > cfg.maxBytes) {
      throw new PayloadTooLargeException(
        `File is ${input.file.size} bytes; the limit for ${input.kind} is ${cfg.maxBytes} bytes.`,
      );
    }
    if (input.file.size === 0) {
      throw new BadRequestException('Refusing to store an empty file.');
    }

    const key = this.buildKey(input);
    const result = await this.provider.put({
      buffer: input.file.buffer,
      key,
      contentType: input.file.mimetype,
    });

    return {
      key: result.key,
      url: this.toPublicUrl(result.key),
      size: result.size,
      contentType: result.contentType,
      storedAt: result.storedAt,
      originalName: input.file.originalname,
    };
  }

  get(key: string): Promise<StorageGetResult> {
    return this.provider.get(key);
  }

  delete(key: string): Promise<void> {
    return this.provider.delete(key);
  }

  exists(key: string): Promise<boolean> {
    return this.provider.exists(key);
  }

  /**
   * Turn an object key into the URL the FE uses to fetch the file. Kept
   * here (not in the controller) so future hash-based / signed URL schemes
   * have one place to add their logic.
   *
   * `STORAGE_PUBLIC_BASE_URL` defaults to the dev value — set it explicitly
   * to your API origin in any deployed environment.
   */
  toPublicUrl(key: string): string {
    return `${this.publicBaseUrl()}/files/${key}`;
  }

  /**
   * True if `url` looks like one we ourselves issued via `toPublicUrl`.
   * No I/O — pure string check. Used as the cheap first gate before the
   * existence check in `assertOwnedUrls`.
   */
  isOwnedUrl(url: string): boolean {
    if (typeof url !== 'string' || !url) return false;
    return url.startsWith(`${this.publicBaseUrl()}/files/`);
  }

  /**
   * Reverse of `toPublicUrl`. Returns the object key, or null if `url`
   * isn't one of ours. Centralised so the prefix logic lives in one place
   * — same reason we put `toPublicUrl` here.
   */
  extractKey(url: string): string | null {
    if (!this.isOwnedUrl(url)) return null;
    return url.slice(`${this.publicBaseUrl()}/files/`.length);
  }

  /**
   * Reject any URL we didn't issue ourselves. Optionally also confirm the
   * underlying object actually exists in storage (default: yes — catches
   * "FE forgot to call /storage/upload first" mistakes immediately rather
   * than letting a broken URL persist into a ClientDocument row).
   *
   * Empty / nullish entries in the input are silently skipped so callers
   * can pass optional fields without filtering first.
   */
  async assertOwnedUrls(
    urls: ReadonlyArray<string | null | undefined>,
    opts: { verifyExists?: boolean } = {},
  ): Promise<void> {
    const verifyExists = opts.verifyExists !== false;
    const owned = urls.filter(
      (u): u is string => typeof u === 'string' && u.length > 0,
    );
    for (const url of owned) {
      if (!this.isOwnedUrl(url)) {
        throw new BadRequestException(
          `File URL is not recognised by the storage service. ` +
            `Upload files via POST /storage/upload and pass the returned URL back. ` +
            `(Offending URL: ${url})`,
        );
      }
      if (verifyExists) {
        const key = this.extractKey(url)!;
        if (!(await this.exists(key))) {
          throw new BadRequestException(
            `File URL points to a missing object — upload may have failed or expired. (Key: ${key})`,
          );
        }
      }
    }
  }

  private publicBaseUrl(): string {
    return (
      process.env.STORAGE_PUBLIC_BASE_URL ??
      'http://localhost:3010/store/v1'
    ).replace(/\/+$/, '');
  }

  /**
   * Object key shape:
   *   <pathPrefix>/<tenantId>/[<subjectUserId>/]<yyyy-mm>/<uuid>.<ext>
   *
   * The yyyy-mm bucket keeps directory listings manageable on disk and
   * matches how most teams shard cloud bucket prefixes. The UUID makes
   * collisions impossible regardless of how many uploads run in parallel.
   */
  private buildKey(input: UploadInput): string {
    const cfg = STORAGE_KIND_CONFIG[input.kind];
    const ext = this.pickExtension(input.file.originalname, input.file.mimetype);
    const yyyymm = new Date().toISOString().slice(0, 7);
    const parts: string[] = [
      cfg.pathPrefix,
      input.ownerScope.tenantId,
      ...(input.ownerScope.subjectUserId ? [input.ownerScope.subjectUserId] : []),
      yyyymm,
      `${randomUUID()}${ext}`,
    ];
    return parts.join('/');
  }

  private pickExtension(originalName: string, mimetype: string): string {
    // Prefer the original extension when it's sane; otherwise fall back to
    // a mime-derived one. Never trust the original blindly — strip leading
    // dots beyond the first, drop anything path-y.
    const fromName = path.posix.extname(originalName).toLowerCase();
    if (/^\.[a-z0-9]{1,6}$/.test(fromName)) return fromName;
    switch (mimetype) {
      case 'image/jpeg':
        return '.jpg';
      case 'image/png':
        return '.png';
      case 'image/webp':
        return '.webp';
      case 'image/gif':
        return '.gif';
      case 'application/pdf':
        return '.pdf';
      default:
        return '';
    }
  }
}
