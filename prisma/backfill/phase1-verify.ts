/**
 * Phase 1 verification gate (Definition of Done).
 *
 *   npm run phase1:verify
 *
 * Read-only. Exits non-zero if ANY check fails. Run on a Neon branch loaded
 * with a copy of production data, AFTER phase1:backfill, BEFORE migration 3c.
 *
 * Checks:
 *   1. No receipt has a NULL root_receipt_id.
 *   2. Mass conservation: every parent.quantity == Σ(direct children.quantity).
 *      (By induction this proves Σ leaves == root for every tree.)
 *   3. Cross-check: Σ leaves under each root == root.quantity.
 *   4. Every root has a genesis DEPOSIT event, linked via source_event_id,
 *      with event.quantity == root.quantity (replay anchor).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL as string });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function q<T>(sql: string): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql);
}

async function main() {
  const failures: string[] = [];

  const nullRoots = await q<{ n: bigint }>(
    `SELECT COUNT(*)::bigint AS n FROM receipts WHERE root_receipt_id IS NULL;`,
  );
  if (Number(nullRoots[0].n) > 0)
    failures.push(`(1) ${nullRoots[0].n} receipt(s) with NULL root_receipt_id`);

  const badParents = await q<{ id: string; quantity: string; child_sum: string }>(`
    SELECT p.id, p.quantity::text, COALESCE(SUM(c.quantity), 0)::text AS child_sum
      FROM receipts p
      JOIN receipts c ON c.parent_receipt_id = p.id
     WHERE p.is_parent = true
     GROUP BY p.id, p.quantity
    HAVING p.quantity <> COALESCE(SUM(c.quantity), 0);
  `);
  if (badParents.length)
    failures.push(
      `(2) ${badParents.length} parent(s) violate mass conservation, e.g. ` +
        badParents
          .slice(0, 5)
          .map((b) => `${b.id} qty=${b.quantity} children=${b.child_sum}`)
          .join('; '),
    );

  const badRoots = await q<{ root_id: string; root_qty: string; leaf_sum: string }>(`
    WITH RECURSIVE tree AS (
      SELECT id, root_receipt_id, parent_receipt_id, quantity, is_parent
        FROM receipts WHERE parent_receipt_id IS NULL
      UNION ALL
      SELECT r.id, r.root_receipt_id, r.parent_receipt_id, r.quantity, r.is_parent
        FROM receipts r JOIN tree t ON r.parent_receipt_id = t.id
    )
    SELECT t.root_receipt_id AS root_id, rt.quantity::text AS root_qty,
           COALESCE(SUM(t.quantity) FILTER (WHERE t.is_parent = false), 0)::text AS leaf_sum
      FROM tree t JOIN receipts rt ON rt.id = t.root_receipt_id
     GROUP BY t.root_receipt_id, rt.quantity
    HAVING rt.quantity <> COALESCE(SUM(t.quantity) FILTER (WHERE t.is_parent = false), 0);
  `);
  if (badRoots.length)
    failures.push(
      `(3) ${badRoots.length} root(s) where Σ leaves ≠ root.quantity, e.g. ` +
        badRoots
          .slice(0, 5)
          .map((b) => `${b.root_id} root=${b.root_qty} leaves=${b.leaf_sum}`)
          .join('; '),
    );

  const badGenesis = await q<{ n: bigint }>(`
    SELECT COUNT(*)::bigint AS n
      FROM receipts r
     WHERE r.parent_receipt_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM inventory_events e
          WHERE e.id = r.source_event_id
            AND e.event_type = 'DEPOSIT'
            AND e.quantity = r.quantity);
  `);
  if (Number(badGenesis[0].n) > 0)
    failures.push(
      `(4) ${badGenesis[0].n} root(s) missing a linked genesis DEPOSIT event with matching quantity`,
    );

  if (failures.length) {
    console.error('PHASE 1 VERIFICATION FAILED:');
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('PHASE 1 VERIFICATION PASSED ✓  — tree reconciles; safe to apply migration 3c.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
