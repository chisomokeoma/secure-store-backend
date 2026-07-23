import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommodityPricesModule } from '../commodity-prices/commodity-prices.module';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';

/**
 * Global-Admin tenant management. EmailModule + NotificationsModule are
 * @Global so they inject without listing here. CommodityPricesModule
 * provides the price lookup used for TenantDetail's storedValue /
 * lienedValue rollups.
 */
@Module({
  imports: [PrismaModule, CommodityPricesModule],
  controllers: [AdminTenantsController],
  providers: [AdminTenantsService],
  exports: [AdminTenantsService],
})
export class AdminTenantsModule {}
