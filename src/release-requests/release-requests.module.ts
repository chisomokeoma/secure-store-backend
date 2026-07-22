import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SecurityModule } from '../security/security.module';
import { ReleaseRequestsService } from './release-requests.service';
import { ReleaseRequestsMeController } from './release-requests.me.controller';
import { ReleaseRequestsFinancierController } from './release-requests.financier.controller';

/**
 * Client submits release requests; financier approves atomically
 * (all-or-nothing) or rejects. Ledger primitive `releasePartial` handles
 * the HELD_LIEN split for partial releases.
 */
@Module({
  imports: [
    PrismaModule,
    InventoryModule,
    NotificationsModule,
    SecurityModule,
  ],
  controllers: [
    ReleaseRequestsMeController,
    ReleaseRequestsFinancierController,
  ],
  providers: [ReleaseRequestsService],
  exports: [ReleaseRequestsService],
})
export class ReleaseRequestsModule {}
