import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommodityPricesModule } from '../commodity-prices/commodity-prices.module';
import { WarehouseLinksService } from './warehouse-links.service';
import { FinancierWarehousesController } from './financier-warehouses.controller';
import { AdminWarehouseLinksController } from './admin-warehouse-links.controller';

/**
 * Warehouse-onboarding lifecycle. One service, two controllers:
 *   - FinancierWarehousesController (/financier/warehouses/*, /financier/warehouse-links/*)
 *   - AdminWarehouseLinksController (/admin/warehouse-links/*)
 *
 * The service is exported so Phase 4's pledge-creation logic can quickly
 * verify "does this financier have an ACTIVE link to this warehouse?"
 * without duplicating the query.
 */
@Module({
  imports: [PrismaModule, NotificationsModule, CommodityPricesModule],
  controllers: [
    FinancierWarehousesController,
    AdminWarehouseLinksController,
  ],
  providers: [WarehouseLinksService],
  exports: [WarehouseLinksService],
})
export class WarehouseLinksModule {}
