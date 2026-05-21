/**
 * Read-only DB diagnosis (no psql needed). Run from a connected environment:
 *   npm run phase1:diagnose
 *
 * Tells us conclusively which migration scenario we are in:
 *   - whether _prisma_migrations exists and what it records
 *   - whether the app schema (receipts/users/...) already exists
 *   - shape of `receipts` (old vs already-Phase-1) and the ReceiptStatus enum
 * Nothing is written. Uses raw pg (Prisma client may not match the live DB).
 */
import { Pool } from 'pg';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL as string });

async function q(sql: string, params: any[] = []): Promise<any[]> {
  try {
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (e: any) {
    return [{ __error: e.message }];
  }
}

async function main() {
  console.log('=== DATABASE DIAGNOSIS ===\n');

  const mig = await q(
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`,
  );
  const hasMig = mig[0]?.exists === true;
  console.log(`_prisma_migrations table exists: ${hasMig}`);
  if (hasMig) {
    const rows = await q(
      `SELECT migration_name, finished_at, rolled_back_at
         FROM _prisma_migrations ORDER BY started_at`,
    );
    console.log(`_prisma_migrations rows (${rows.length}):`);
    for (const r of rows)
      console.log(
        `  - ${r.migration_name} | finished=${r.finished_at ?? 'NULL'} | rolledback=${r.rolled_back_at ?? 'NULL'}`,
      );
  }

  console.log('\n--- public tables ---');
  const tables = await q(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
      ORDER BY table_name`,
  );
  console.log(tables.map((t) => t.table_name).join(', ') || '(none)');

  const key = ['receipts', 'users', 'inventory_events', 'withdrawals'];
  console.log('\n--- key tables present ---');
  for (const t of key) {
    const exists = tables.some((x) => x.table_name === t);
    let count = '';
    if (exists) {
      const c = await q(`SELECT COUNT(*)::text AS n FROM "${t}"`);
      count = ` (rows: ${c[0]?.n ?? c[0]?.__error ?? '?'})`;
    }
    console.log(`  ${t}: ${exists ? 'YES' : 'NO'}${count}`);
  }

  if (tables.some((x) => x.table_name === 'receipts')) {
    console.log('\n--- receipts columns (old vs phase1) ---');
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='receipts' ORDER BY column_name`,
    );
    const names = cols.map((c) => c.column_name);
    console.log(`  has quantity_available (OLD): ${names.includes('quantity_available')}`);
    console.log(`  has root_receipt_id (PHASE1): ${names.includes('root_receipt_id')}`);
  }

  const enumVals = await q(
    `SELECT e.enumlabel FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'ReceiptStatus' ORDER BY e.enumsortorder`,
  );
  console.log('\n--- ReceiptStatus enum values ---');
  console.log(
    enumVals[0]?.__error
      ? `  (none / ${enumVals[0].__error})`
      : '  ' + enumVals.map((v) => v.enumlabel).join(', '),
  );

  console.log('\n=== END ===');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
