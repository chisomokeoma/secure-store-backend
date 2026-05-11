import { Module } from '@nestjs/common';
import { AdminConfigController } from './controllers/admin-config.controller';
import { AdminWarehouseController } from './controllers/admin-warehouse.controller';
import { AdminClientController } from './controllers/admin-client.controller';
import { AdminReportController } from './controllers/admin-report.controller';
import { AdminReceiptController } from './controllers/admin-receipt.controller';
import { AdminWithdrawalController } from './controllers/admin-withdrawal.controller';
import { AdminActivityController } from './controllers/admin-activity.controller';
import { AdminTransactionsController } from './controllers/admin-transactions.controller';
import { AdminConfigService } from './services/admin-config.service';
import { AdminWarehouseService } from './services/admin-warehouse.service';
import { AdminClientService } from './services/admin-client.service';
import { AdminReportService } from './services/admin-report.service';
import { AdminReceiptService } from './services/admin-receipt.service';
import { AdminWithdrawalService } from './services/admin-withdrawal.service';
import { AdminActivityService } from './services/admin-activity.service';
import { AdminTransactionsService } from './services/admin-transactions.service';

@Module({
  controllers: [
    AdminConfigController,
    AdminWarehouseController,
    AdminClientController,
    AdminReportController,
    AdminReceiptController,
    AdminWithdrawalController,
    AdminActivityController,
    AdminTransactionsController,
  ],
  providers: [
    AdminConfigService,
    AdminWarehouseService,
    AdminClientService,
    AdminReportService,
    AdminReceiptService,
    AdminWithdrawalService,
    AdminActivityService,
    AdminTransactionsService,
  ],
  exports: [AdminActivityService],
})
export class AdminModule {}
