import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { D } from './inventory.types';

export interface RootReconResult {
  rootReceiptId: string;
  rootQuantity: string;
  leafSum: string;
  balanced: boolean;
  gap: string;
}

@Injectable()
export class InventoryReconService {
  constructor(private readonly prisma: PrismaService) {}

  /** Σ leaves vs root.quantity for a single tree (Decimal-exact). */
  async reconcileRoot(rootReceiptId: string): Promise<RootReconResult> {
    const rows = await this.prisma.$queryRawUnsafe<
      { root_qty: string; leaf_sum: string }[]
    >(
      `WITH RECURSIVE tree AS (
         SELECT id, root_receipt_id, parent_receipt_id, quantity, is_parent
           FROM receipts WHERE id = $1
         UNION ALL
         SELECT r.id, r.root_receipt_id, r.parent_receipt_id, r.quantity, r.is_parent
           FROM receipts r JOIN tree t ON r.parent_receipt_id = t.id
       )
       SELECT (SELECT quantity::text FROM receipts WHERE id = $1) AS root_qty,
              COALESCE(SUM(quantity) FILTER (WHERE is_parent = false), 0)::text AS leaf_sum
         FROM tree`,
      rootReceiptId,
    );
    const rootQty = D(rows[0]?.root_qty ?? 0);
    const leafSum = D(rows[0]?.leaf_sum ?? 0);
    const gap = rootQty.minus(leafSum);
    return {
      rootReceiptId,
      rootQuantity: rootQty.toString(),
      leafSum: leafSum.toString(),
      balanced: gap.isZero(),
      gap: gap.toString(),
    };
  }

  /**
   * Replay-verify a tree: the genesis DEPOSIT event must anchor the root
   * quantity, and every internal node must equal Σ(direct children) — by
   * induction this proves the whole tree conserves mass.
   */
  async replayVerify(
    rootReceiptId: string,
  ): Promise<{ ok: boolean; reasons: string[] }> {
    const reasons: string[] = [];

    const genesis = await this.prisma.inventoryEvent.findFirst({
      where: { rootReceiptId, eventType: 'DEPOSIT' },
    });
    const root = await this.prisma.receipt.findUnique({
      where: { id: rootReceiptId },
    });
    if (!root) return { ok: false, reasons: [`root ${rootReceiptId} missing`] };
    if (!genesis || !genesis.quantity.equals(root.quantity)) {
      reasons.push('genesis DEPOSIT event missing or quantity mismatch');
    }

    const bad = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM receipts WHERE id = $1
         UNION ALL
         SELECT r.id FROM receipts r JOIN tree t ON r.parent_receipt_id = t.id
       )
       SELECT p.id FROM receipts p
         JOIN receipts c ON c.parent_receipt_id = p.id
        WHERE p.is_parent = true AND p.id IN (SELECT id FROM tree)
        GROUP BY p.id, p.quantity
       HAVING p.quantity <> COALESCE(SUM(c.quantity), 0)`,
      rootReceiptId,
    );
    if (bad.length)
      reasons.push(`${bad.length} parent(s) violate mass conservation`);

    return { ok: reasons.length === 0, reasons };
  }

  /**
   * Whole-DB (or per-tenant) gate — the recurring audit job and the Phase 1
   * Definition-of-Done check, expressed as a service.
   */
  async verifyAll(
    tenantId?: string,
  ): Promise<{ ok: boolean; failures: string[] }> {
    const failures: string[] = [];
    const scope = tenantId ? `AND tenant_id = '${tenantId}'` : '';

    const nullRoots = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM receipts WHERE root_receipt_id IS NULL ${scope}`,
    );
    if (Number(nullRoots[0].n) > 0)
      failures.push(`${nullRoots[0].n} receipt(s) with NULL root_receipt_id`);

    const badParents = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM (
         SELECT p.id FROM receipts p
           JOIN receipts c ON c.parent_receipt_id = p.id
          WHERE p.is_parent = true ${scope ? `AND p.tenant_id = '${tenantId}'` : ''}
          GROUP BY p.id, p.quantity
         HAVING p.quantity <> COALESCE(SUM(c.quantity), 0)
       ) x`,
    );
    if (Number(badParents[0].n) > 0)
      failures.push(
        `${badParents[0].n} parent(s) violate mass conservation`,
      );

    return { ok: failures.length === 0, failures };
  }
}
