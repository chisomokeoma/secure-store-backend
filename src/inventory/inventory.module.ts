import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryLedgerService } from './inventory-ledger.service';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryReconService } from './inventory.recon';

/**
 * Phase 2 — the inventory ledger core. Withdrawals/Loans/Trades (Phases 3–5)
 * import this and call the primitives; they no longer touch Receipt directly.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    InventoryLedgerService,
    InventoryQueryService,
    InventoryReconService,
  ],
  exports: [
    InventoryLedgerService,
    InventoryQueryService,
    InventoryReconService,
  ],
})
export class InventoryModule {}
