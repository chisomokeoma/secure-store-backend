import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommodityPricesModule } from '../commodity-prices/commodity-prices.module';
import { LiensService } from './liens.service';
import { LiensFinancierController } from './liens.financier.controller';

/**
 * Read-side lien portfolio module. Writes happen through PledgesService
 * (on accept) and — later — ReleaseRequestsService (on approval).
 */
@Module({
  imports: [PrismaModule, CommodityPricesModule],
  controllers: [LiensFinancierController],
  providers: [LiensService],
  exports: [LiensService],
})
export class LiensModule {}
