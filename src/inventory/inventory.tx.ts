import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type Tx = Prisma.TransactionClient;

/**
 * Postgres serialization failure (40001) or deadlock (40P01) — safe to retry
 * the whole transaction. The pg driver adapter surfaces these as wrapped
 * Prisma errors, so we match on the code/message defensively.
 */
function isRetryableTxError(e: unknown): boolean {
  const s = JSON.stringify(
    e instanceof Error ? { m: e.message, ...(e as any) } : e,
  ).toLowerCase();
  return (
    s.includes('40001') ||
    s.includes('40p01') ||
    s.includes('could not serialize') ||
    s.includes('deadlock detected')
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` in a SERIALIZABLE transaction, retrying (with small backoff) on
 * serialization/deadlock failures. This is the correctness guarantee behind
 * every ledger mutation; the explicit row lock (see lockReceiptForUpdate)
 * makes contention fail fast instead of retry-storming.
 */
export async function withSerializableTx<T>(
  prisma: PrismaService,
  fn: (tx: Tx) => Promise<T>,
  opts: { retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  let attempt = 0;
  for (;;) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
        maxWait: 5_000,
      });
    } catch (e) {
      if (attempt < retries && isRetryableTxError(e)) {
        attempt += 1;
        await sleep(25 * attempt + Math.floor(Math.random() * 25));
        continue;
      }
      throw e;
    }
  }
}

/**
 * Pessimistic row lock on a single receipt within `tx`. Returns the locked
 * row id, or null if it does not exist (or wrong tenant). Prisma has no
 * native FOR UPDATE, so this is a raw statement; callers re-read via Prisma.
 */
export async function lockReceiptForUpdate(
  tx: Tx,
  id: string,
  tenantId: string,
): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    'SELECT id FROM receipts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    id,
    tenantId,
  );
  return rows.length > 0;
}

/**
 * Receipt-number helpers. Children get the next free `-A/-B/.../-AA` suffix
 * under their lineage base (mirrors the pre-refactor scheme; the Phase 1
 * backfill used the distinct `-RCN` suffix so there is no collision).
 */
export function baseReceiptNumber(parentNumber: string): string {
  return parentNumber.replace(/-[A-Z]+$/, '');
}

export function nextSuffix(existing: string[]): string {
  if (existing.length === 0) return 'A';
  const sorted = [...existing].sort((a, b) =>
    a.length === b.length ? a.localeCompare(b) : a.length - b.length,
  );
  const last = sorted[sorted.length - 1];
  if (last.length === 1 && last !== 'Z') {
    return String.fromCharCode(last.charCodeAt(0) + 1);
  }
  if (last === 'Z') return 'AA';
  const chars = last.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== 'Z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = 'A';
  }
  return 'A' + chars.join('');
}

export async function existingChildSuffixes(
  tx: Tx,
  base: string,
): Promise<string[]> {
  const rows = await tx.receipt.findMany({
    where: { receiptNumber: { startsWith: `${base}-` } },
    select: { receiptNumber: true },
  });
  return rows
    .map((r) => r.receiptNumber.slice(base.length + 1))
    .filter((s) => /^[A-Z]+$/.test(s));
}
