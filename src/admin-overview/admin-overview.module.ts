import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommodityPricesModule } from '../commodity-prices/commodity-prices.module';
import { AdminOverviewController } from './admin-overview.controller';
import { AdminOverviewService } from './admin-overview.service';

/**
 * Global-Admin platform-wide read module. Powers the GA Dashboard,
 * Network Warehouses, and System Activity screens. CommodityPricesModule
 * provides current-price lookup for storedValue / lienedValue rollups.
 */
@Module({
  imports: [PrismaModule, CommodityPricesModule],
  controllers: [AdminOverviewController],
  providers: [AdminOverviewService],
  exports: [AdminOverviewService],
})
export class AdminOverviewModule {}
