import { Module } from '@nestjs/common';
import { WarehouseManagerModule } from '../warehouse-manager/warehouse-manager.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [WarehouseManagerModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
