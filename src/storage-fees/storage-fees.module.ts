import { Module } from '@nestjs/common';
import { StorageFeesController } from './storage-fees.controller';
import { StorageFeesService } from './storage-fees.service';

@Module({
  controllers: [StorageFeesController],
  providers: [StorageFeesService],
  exports: [StorageFeesService],
})
export class StorageFeesModule {}
