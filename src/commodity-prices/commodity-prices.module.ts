import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommodityPricesService } from './commodity-prices.service';

/**
 * Reference-price lookup + write module. Exported for use by
 * PledgesService (valuation lookup at pledge time). Later phases will
 * add an admin controller for the price-management screen.
 */
@Module({
  imports: [PrismaModule],
  providers: [CommodityPricesService],
  exports: [CommodityPricesService],
})
export class CommodityPricesModule {}
