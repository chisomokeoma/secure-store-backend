import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryModule } from '../inventory/inventory.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { LoansModule } from '../loans/loans.module';
import { TradesModule } from '../trades/trades.module';
import { StorageFeesModule } from '../storage-fees/storage-fees.module';
import { WarehouseManagerController } from './warehouse-manager.controller';
import { WarehouseManagerService } from './warehouse-manager.service';
import { WarehouseScopeService } from './warehouse-scope.service';

@Module({
  imports: [
    PrismaModule,
    InventoryModule,
    WithdrawalsModule,
    LoansModule,
    TradesModule,
    StorageFeesModule,
  ],
  controllers: [WarehouseManagerController],
  providers: [WarehouseManagerService, WarehouseScopeService],
  exports: [WarehouseManagerService],
})
export class WarehouseManagerModule {}
