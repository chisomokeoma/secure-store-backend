import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommodityPricesModule } from '../commodity-prices/commodity-prices.module';
import { FinancierSelfController } from './financier-self.controller';
import { FinancierSelfService } from './financier-self.service';

/**
 * Financier-facing module. Serves self profile, settings, and dashboard.
 * The dashboard aggregate (Phase 6) needs current commodity prices to
 * compute `totalLienedValue` and per-warehouse / per-commodity exposure.
 */
@Module({
  imports: [PrismaModule, CommodityPricesModule],
  controllers: [FinancierSelfController],
  providers: [FinancierSelfService],
  exports: [FinancierSelfService],
})
export class FinancierModule {}
