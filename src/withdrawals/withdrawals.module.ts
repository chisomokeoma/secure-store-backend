import { Module } from '@nestjs/common';
import { WithdrawalsController } from './withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';
import { InventoryModule } from '../inventory/inventory.module';
import { StorageFeesModule } from '../storage-fees/storage-fees.module';

@Module({
  imports: [InventoryModule, StorageFeesModule],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
