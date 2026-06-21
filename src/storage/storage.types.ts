import { Readable } from 'node:stream';

/**
 * The contract every storage backend implements. Today there's only one
 * implementation — LocalDiskStorageProvider, writing files to a directory
 * on the host filesystem — but the abstraction is here so adding S3 / R2 /
 * Spaces later is "drop in a second class and swap the provider binding
 * in storage.module.ts." No call site has to change.
 *
 * Object keys are forward-slash-separated relative paths like
 * `tenants/<tenantId>/clients/<clientId>/documents/<uuid>.<ext>`. The
 * provider is responsible for translating that to its own addressing —
 * local disk uses it as a relative path under STORAGE_LOCAL_DIR; S3 would
 * use it as the S3 object key verbatim.
 */
export interface StoragePutInput {
  /** The raw file content. multer hands us a Buffer; we pass it through. */
  buffer: Buffer;
  /** The pre-computed object key the service decided on. */
  key: string;
  /** MIME type as reported by the FE / validated against the whitelist. */
  contentType: string;
}

export interface StoragePutResult {
  key: string;
  size: number;
  contentType: string;
  storedAt: Date;
}

export interface StorageGetResult {
  stream: Readable;
  size: number;
  contentType: string;
}

export interface StorageProvider {
  /** Persist the bytes under `key`. Overwrites if the key already exists. */
  put(input: StoragePutInput): Promise<StoragePutResult>;

  /**
   * Returns a stream of the bytes under `key`, plus metadata. Throws
   * StorageNotFoundError when the key isn't present.
   */
  get(key: string): Promise<StorageGetResult>;

  /** Removes the object. No-op if it didn't exist. */
  delete(key: string): Promise<void>;

  /** True if the key exists; mostly used to validate before we persist a URL. */
  exists(key: string): Promise<boolean>;
}

export class StorageNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`Storage object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

/**
 * Classification of what's being uploaded. Drives per-kind mime / size
 * validation and shapes the object key so files cluster sensibly on disk
 * (`profile-photos/...`, `client-documents/...`, etc.).
 */
export type StorageKind =
  | 'PROFILE_PHOTO'
  | 'ID_DOCUMENT'
  | 'CLIENT_DOCUMENT'
  | 'WAREHOUSE_PHOTO'
  | 'OTHER';

/** Per-kind upload constraints — single source of truth. */
export interface StorageKindConfig {
  maxBytes: number;
  allowedMimeTypes: readonly string[];
  /** Path prefix under which keys for this kind live. */
  pathPrefix: string;
}

export const STORAGE_KIND_CONFIG: Record<StorageKind, StorageKindConfig> = {
  PROFILE_PHOTO: {
    maxBytes: 5 * 1024 * 1024, // 5 MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    pathPrefix: 'profile-photos',
  },
  ID_DOCUMENT: {
    maxBytes: 10 * 1024 * 1024, // 10 MB
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ],
    pathPrefix: 'id-documents',
  },
  CLIENT_DOCUMENT: {
    // Org docs (CAC certs, board resolutions, TIN certs, utility bills)
    // are typically PDFs but FE/scanner pipelines also produce images.
    maxBytes: 15 * 1024 * 1024, // 15 MB
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ],
    pathPrefix: 'client-documents',
  },
  WAREHOUSE_PHOTO: {
    maxBytes: 8 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    pathPrefix: 'warehouse-photos',
  },
  OTHER: {
    maxBytes: 10 * 1024 * 1024,
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ],
    pathPrefix: 'misc',
  },
};

/** DI token used by StorageModule.providers + StorageService injection. */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
