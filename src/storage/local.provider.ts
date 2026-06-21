import { Injectable, Logger } from '@nestjs/common';
import { promises as fs, createReadStream } from 'node:fs';
import * as path from 'node:path';
import {
  StorageProvider,
  StoragePutInput,
  StoragePutResult,
  StorageGetResult,
  StorageNotFoundError,
} from './storage.types';

/**
 * Disk-backed StorageProvider. Files are written under STORAGE_LOCAL_DIR
 * (defaults to ./uploads at the project root). The directory layout mirrors
 * the object key 1:1, which makes manual inspection trivial during dev:
 *
 *   ./uploads/profile-photos/<uuid>.jpg
 *   ./uploads/client-documents/<tenantId>/<clientId>/<uuid>.pdf
 *
 * Why a directory and not a single flat folder: tens of thousands of files
 * in one directory is fine on ext4/APFS but a pain to ls / scp / inspect.
 * The per-kind subfolder also makes "drop in S3 later" zero-effort because
 * the key format is identical.
 *
 * NOT FOR PROD. Disk on a Render/Railway-style ephemeral container is
 * wiped on every deploy. When you're ready, build an S3Provider that
 * implements the same interface and swap the binding in storage.module.ts.
 * No call site changes.
 */
@Injectable()
export class LocalDiskStorageProvider implements StorageProvider {
  private readonly log = new Logger(LocalDiskStorageProvider.name);
  private readonly rootDir: string;

  constructor() {
    this.rootDir = path.resolve(
      process.cwd(),
      process.env.STORAGE_LOCAL_DIR ?? './uploads',
    );
  }

  async put(input: StoragePutInput): Promise<StoragePutResult> {
    const fullPath = this.resolveKey(input.key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, input.buffer);
    this.log.debug(
      `put: key=${input.key} size=${input.buffer.length} contentType=${input.contentType}`,
    );
    return {
      key: input.key,
      size: input.buffer.length,
      contentType: input.contentType,
      storedAt: new Date(),
    };
  }

  async get(key: string): Promise<StorageGetResult> {
    const fullPath = this.resolveKey(key);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(fullPath);
    } catch (err: any) {
      if (err?.code === 'ENOENT') throw new StorageNotFoundError(key);
      throw err;
    }
    return {
      stream: createReadStream(fullPath),
      size: stat.size,
      // We don't persist contentType on disk (no extended attributes in a
      // cross-platform way), so we infer at read time. Real cloud providers
      // remember this; the StorageService records it on the entity row
      // alongside the URL when the upload happens, which is the authoritative
      // record. This return value is best-effort.
      contentType: this.inferContentType(key),
    };
  }

  async delete(key: string): Promise<void> {
    const fullPath = this.resolveKey(key);
    try {
      await fs.unlink(fullPath);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Translate an object key to an absolute path on disk. Crucially, we
   * sanitise against `..` so a malicious or malformed key can't escape
   * the rootDir — defence in depth on top of the key construction in
   * StorageService (which produces UUIDs, never user-controlled segments).
   */
  private resolveKey(key: string): string {
    const safe = path.posix
      .normalize(key)
      .replace(/^(?:\.{2}\/)+/, '')
      .replace(/^\/+/, '');
    const full = path.resolve(this.rootDir, safe);
    if (!full.startsWith(this.rootDir + path.sep) && full !== this.rootDir) {
      throw new Error(`Key resolves outside the storage root: ${key}`);
    }
    return full;
  }

  /**
   * Best-effort MIME inference from the file extension. The set is small
   * on purpose — it matches the `allowedMimeTypes` we validate at upload
   * time, so we'll never serve up something we wouldn't accept.
   */
  private inferContentType(key: string): string {
    const ext = path.posix.extname(key).toLowerCase();
    switch (ext) {
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.png':
        return 'image/png';
      case '.webp':
        return 'image/webp';
      case '.gif':
        return 'image/gif';
      case '.pdf':
        return 'application/pdf';
      default:
        return 'application/octet-stream';
    }
  }
}
