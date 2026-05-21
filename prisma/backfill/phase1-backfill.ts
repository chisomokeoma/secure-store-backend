/**
 * Phase 1 (3b) — idempotent backfill.
 *
 * Run AFTER migration 3a, BEFORE migration 3c:
 *   npm run phase1:backfill && npm run phase1:verify
 *
 * Safe to re-run: every step is guarded (only writes what is missing/wrong).
 *
 *   A. Structural — set root_receipt_id (recursive), promote split parents.
 *   B. Genesis — one DEPOSIT InventoryEvent per root; link source_event_id.
 *   C. Reconcile — for every root where Σ leaves ≠ root.quantity, attach ONE
 *      explicit synthetic terminal child + ledger event so the invariant holds
 *      by construction (matched legacy withdrawal → CONSUMED, else the §5C
 *      LEGACY_RECONCILIATION opening-balance adjustment). Negative gaps abort.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL as string });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const D = (v: unknown) => new Prisma.Decimal(v as Prisma.Decimal.Value);

async function stepA_structural() {
  // A1 — root_receipt_id for every node (idempotent: only rows that differ).
  const a1 = await prisma.$executeRawUnsafe(`
    WITH RECURSIVE chain AS (
      SELECT id, parent_receipt_id, id AS root_id
        FROM receipts WHERE parent_receipt_id IS NULL
      UNION ALL
      SELECT r.id, r.parent_receipt_id, c.root_id
        FROM receipts r JOIN chain c ON r.parent_receipt_id = c.id
    )
    UPDATE receipts SET root_receipt_id = chain.root_id
    FROM chain
    WHERE receipts.id = chain.id
      AND receipts.root_receipt_id IS DISTINCT FROM chain.root_id;
  `);

  // A2 — any node with children is a superseded SPLIT parent.
  const a2 = await prisma.$executeRawUnsafe(`
    UPDATE receipts p
       SET is_parent = true,
           status = 'SPLIT',
           superseded_at = COALESCE(p.superseded_at, p.updated_at)
     WHERE EXISTS (SELECT 1 FROM receipts c WHERE c.parent_receipt_id = p.id)
       AND (p.is_parent = false OR p.status <> 'SPLIT');
  `);
  console.log(`  A: root_receipt_id set on ${a1} row(s); ${a2} split parent(s) promoted`);
}

async function stepB_genesis() {
  const ins = await prisma.$executeRawUnsafe(`
    INSERT INTO inventory_events
      (id, tenant_id, root_receipt_id, from_receipt_id, event_type, txn_type,
       quantity, idempotency_key, metadata, occurred_at)
    SELECT gen_random_uuid(), r.tenant_id, r.id, r.id, 'DEPOSIT', 'DEPOSIT',
           r.quantity, 'backfill:deposit:' || r.id,
           jsonb_build_object('backfill', true), r.created_at
      FROM receipts r
     WHERE r.parent_receipt_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM inventory_events e
          WHERE e.idempotency_key = 'backfill:deposit:' || r.id);
  `);
  const link = await prisma.$executeRawUnsafe(`
    UPDATE receipts r
       SET source_event_id = e.id
      FROM inventory_events e
     WHERE e.idempotency_key = 'backfill:deposit:' || r.id
       AND r.parent_receipt_id IS NULL
       AND r.source_event_id IS DISTINCT FROM e.id;
  `);
  console.log(`  B: ${ins} genesis DEPOSIT event(s) created; ${link} root(s) linked`);
}

interface GapRow { root_id: string; root_qty: string; leaf_sum: string }

async function stepC_reconcile() {
  const gaps = await prisma.$queryRawUnsafe<GapRow[]>(`
    WITH RECURSIVE tree AS (
      SELECT id, root_receipt_id, parent_receipt_id, quantity, is_parent
        FROM receipts WHERE parent_receipt_id IS NULL
      UNION ALL
      SELECT r.id, r.root_receipt_id, r.parent_receipt_id, r.quantity, r.is_parent
        FROM receipts r JOIN tree t ON r.parent_receipt_id = t.id
    )
    SELECT t.root_receipt_id AS root_id,
           rt.quantity::text AS root_qty,
           COALESCE(SUM(t.quantity) FILTER (WHERE t.is_parent = false), 0)::text AS leaf_sum
      FROM tree t
      JOIN receipts rt ON rt.id = t.root_receipt_id
     GROUP BY t.root_receipt_id, rt.quantity;
  `);

  const negatives: string[] = [];
  let matched = 0;
  let adjusted = 0;

  for (const g of gaps) {
    const gap = D(g.root_qty).minus(D(g.leaf_sum));
    if (gap.isZero()) continue;
    if (gap.isNegative()) {
      negatives.push(`${g.root_id} (root ${g.root_qty} < leaves ${g.leaf_sum})`);
      continue;
    }

    const idemKey = `backfill:recon:${g.root_id}`;
    const exists = await prisma.inventoryEvent.findUnique({
      where: { idempotencyKey: idemKey },
      select: { id: true },
    });
    if (exists) continue; // already reconciled on a prior run

    const root = await prisma.receipt.findUniqueOrThrow({ where: { id: g.root_id } });

    // Attribute the gap to a legacy COMPLETED withdrawal of the same quantity
    // anywhere in this tree, if one exists; otherwise it is an opening-balance
    // adjustment (§5C).
    const match = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT w.id FROM withdrawals w
         JOIN receipts r ON r.id = w.receipt_id
        WHERE r.root_receipt_id = $1
          AND w.status = 'COMPLETED'
          AND ABS(w.quantity - $2::numeric) < 0.0005
        ORDER BY w.created_at
        LIMIT 1;`,
      g.root_id,
      gap.toString(),
    );
    const w = match[0];

    await prisma.$transaction(async (tx) => {
      const event = await tx.inventoryEvent.create({
        data: {
          tenantId: root.tenantId,
          rootReceiptId: root.id,
          fromReceiptId: root.id,
          eventType: w ? 'CONSUMED' : 'LEGACY_RECONCILIATION',
          txnType: w ? 'WITHDRAWAL' : 'ADJUSTMENT',
          txnId: w?.id ?? null,
          quantity: gap,
          idempotencyKey: idemKey,
          metadata: {
            backfill: true,
            reason: w
              ? 'legacy completed withdrawal reflected as terminal node'
              : 'opening-balance adjustment: unattributable legacy gap',
            matchedWithdrawalId: w?.id ?? null,
          },
          occurredAt: root.createdAt,
        },
      });

      const child = await tx.receipt.create({
        data: {
          receiptNumber: `${root.receiptNumber}-RCN`,
          status: w ? 'WITHDRAWN' : 'CANCELLED',
          tenantId: root.tenantId,
          commodityId: root.commodityId,
          quantity: gap,
          grade: root.grade,
          warehouseId: root.warehouseId,
          clientId: root.clientId,
          approvalStatus: 'APPROVED',
          parentReceiptId: root.id,
          rootReceiptId: root.id,
          isParent: false,
          sourceTxnType: w ? 'WITHDRAWAL' : 'ADJUSTMENT',
          sourceTxnId: w?.id ?? null,
          sourceEventId: event.id,
          dateOfDeposit: root.dateOfDeposit,
          expiryDate: root.expiryDate,
        },
      });

      await tx.receipt.update({
        where: { id: root.id },
        data: {
          isParent: true,
          status: 'SPLIT',
          supersededAt: root.supersededAt ?? root.updatedAt,
        },
      });

      void child;
    });

    if (w) matched++;
    else adjusted++;
  }

  console.log(
    `  C: ${matched} gap(s) matched to legacy withdrawals; ${adjusted} opening-balance adjustment(s)`,
  );
  if (negatives.length) {
    throw new Error(
      `ABORT: ${negatives.length} root(s) have leaves > root (over-allocation, cannot be ` +
        `safely fabricated). Investigate manually:\n  - ${negatives.join('\n  - ')}`,
    );
  }
}

async function main() {
  console.log('Phase 1 backfill starting...');
  await stepA_structural();
  await stepB_genesis();
  await stepC_reconcile();
  console.log('Phase 1 backfill completed. Now run: npm run phase1:verify');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
