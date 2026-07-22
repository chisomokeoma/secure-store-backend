import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SecurityModule } from '../security/security.module';
import { CommodityPricesModule } from '../commodity-prices/commodity-prices.module';
import { FinancierModule } from '../financier/financier.module';
import { PledgesService } from './pledges.service';
import { PledgesMeController } from './pledges.me.controller';
import { PledgesFinancierController } from './pledges.financier.controller';
import { PledgesCleanupService } from './pledges.cleanup.service';

/**
 * Collateral pledges — client submit, financier accept/reject, TTL cron.
 *
 * Imports:
 *   - InventoryModule       → ledger hold/release + transitionPledgeToLien
 *   - SecurityModule        → OTP request + consume for 2FA gates
 *   - CommodityPricesModule → automatic valuation (Q2)
 *   - FinancierModule       → DEFAULT_PLEDGE_TTL_DAYS constant
 *   - NotificationsModule   → in-app + email notifications
 *
 * Exports PledgesService so downstream modules (Phase 5 release requests,
 * Phase 6 admin force-release) can reuse the encumbrance query without
 * a circular dep on the controllers.
 */
@Module({
  imports: [
    PrismaModule,
    InventoryModule,
    NotificationsModule,
    SecurityModule,
    CommodityPricesModule,
    FinancierModule,
  ],
  controllers: [PledgesMeController, PledgesFinancierController],
  providers: [PledgesService, PledgesCleanupService],
  exports: [PledgesService],
})
export class PledgesModule {}
