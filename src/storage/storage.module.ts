import { Global, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { LocalDiskStorageProvider } from './local.provider';
import { STORAGE_PROVIDER } from './storage.types';

/**
 * @Global so every domain service that already takes a file URL on a DTO
 * (ClientProfile.profilePhotoUrl, ClientDocument.url, etc.) can just inject
 * StorageService without that module having to import StorageModule. Same
 * pattern as NotificationsModule + EmailModule.
 *
 * The provider binding is the single seam for swapping backends. To move
 * to S3 / R2 / Spaces later:
 *
 *   1. Add `s3.provider.ts` implementing StorageProvider against the AWS SDK.
 *   2. Change `useClass: LocalDiskStorageProvider` below to either:
 *        - useClass: S3StorageProvider (always cloud), or
 *        - useFactory: (cfg) => cfg === 's3' ? new S3StorageProvider(...) : new LocalDiskStorageProvider()
 *      so STORAGE_PROVIDER env-toggle picks at boot.
 *   3. No call site changes anywhere else.
 *
 * Multer is configured with memoryStorage + a 25 MB hard ceiling. We use
 * memory storage so StorageService gets a Buffer (consistent across all
 * providers — disk + cloud). 25 MB is the OUTER ceiling; per-kind limits
 * inside StorageService are tighter and that's what users will hit first.
 */
@Global()
@Module({
  imports: [
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  ],
  controllers: [StorageController],
  providers: [
    StorageService,
    {
      provide: STORAGE_PROVIDER,
      useClass: LocalDiskStorageProvider,
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
