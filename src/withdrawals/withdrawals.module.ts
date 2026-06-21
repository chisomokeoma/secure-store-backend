import { Module } from '@nestjs/common';
import { WithdrawalsController } from './withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawalsCleanupService } from './withdrawals.cleanup.service';
import { InventoryModule } from '../inventory/inventory.module';
import { StorageFeesModule } from '../storage-fees/storage-fees.module';

@Module({
  imports: [InventoryModule, StorageFeesModule],
  controllers: [WithdrawalsController],
  // WithdrawalsCleanupService is providered here (not exported) — it's a
  // background-only consumer of Prisma + Notifications, runs on its own
  // schedule, never injected by another service. Listing it in providers
  // is enough for Nest to instantiate it on boot and for @nestjs/schedule
  // to discover the @Cron decorator.
  providers: [WithdrawalsService, WithdrawalsCleanupService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
