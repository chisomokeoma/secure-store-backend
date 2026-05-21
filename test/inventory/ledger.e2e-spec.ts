/**
 * Phase 2 ledger — DB-backed correctness suite.
 *
 * Requires a reachable Postgres (the Neon BRANCH). Run with:
 *   npm run test:inventory:e2e
 *
 * Self-contained: does NOT import AppModule (which is mid-refactor). Each run
 * uses a fresh random tenant, so runs are independent and need no cleanup for
 * correctness; afterAll does a best-effort soft delete (branch is disposable).
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { InventoryLedgerService } from '../../src/inventory/inventory-ledger.service';
import { InventoryReconService } from '../../src/inventory/inventory.recon';

jest.setTimeout(180_000);

const prisma = new PrismaService();
const ledger = new InventoryLedgerService(prisma);
const recon = new InventoryReconService(prisma);

interface Fixtures {
  tenantId: string;
  clientId: string;
  financierId: string;
  commodityId: string;
  warehouseId: string;
}

async function mkFixtures(): Promise<Fixtures> {
  const u = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({
    data: { name: `t-${u}`, slug: `t-${u}` },
  });
  const client = await prisma.user.create({
    data: {
      email: `client-${u}@test.local`,
      password: 'x',
      firstName: 'Cli',
      lastName: 'Ent',
      tenantId: tenant.id,
    },
  });
  const financier = await prisma.user.create({
    data: {
      email: `fin-${u}@test.local`,
      password: 'x',
      firstName: 'Fin',
      lastName: 'Ancier',
      tenantId: tenant.id,
    },
  });
  const commodity = await prisma.commodity.create({
    data: { name: `Maize-${u}`, unitOfMeasure: 'METRIC_TON', tenantId: tenant.id },
  });
  const warehouse = await prisma.warehouse.create({
    data: { name: `WH-${u}`, location: 'Test', tenantId: tenant.id },
  });
  return {
    tenantId: tenant.id,
    clientId: client.id,
    financierId: financier.id,
    commodityId: commodity.id,
    warehouseId: warehouse.id,
  };
}

async function depositApproved(f: Fixtures, qty: string) {
  const root = await ledger.deposit({
    tenantId: f.tenantId,
    clientId: f.clientId,
    commodityId: f.commodityId,
    warehouseId: f.warehouseId,
    quantity: qty,
    dateOfDeposit: new Date(),
    idempotencyKey: `dep:${randomUUID()}`,
  });
  await ledger.approveReceipt({
    tenantId: f.tenantId,
    receiptId: root.id,
    actorUserId: f.clientId,
    idempotencyKey: `apr:${root.id}`,
  });
  return prisma.receipt.findUniqueOrThrow({ where: { id: root.id } });
}

let f: Fixtures;
beforeAll(async () => {
  await prisma.$connect();
  f = await mkFixtures();
});
afterAll(async () => {
  try {
    await prisma.$executeRawUnsafe(
      'DELETE FROM inventory_events WHERE tenant_id = $1',
      f.tenantId,
    );
  } catch {
    /* disposable branch — best effort */
  }
  await prisma.$disconnect();
});

describe('lifecycle: deposit → approve → hold → approveHold → consume', () => {
  it('splits 100 into held 40 + remainder 60 and stays reconciled', async () => {
    const root = await depositApproved(f, '100');

    const { source, held, remainder } = await ledger.hold({
      tenantId: f.tenantId,
      sourceReceiptId: root.id,
      quantity: '40',
      heldStatus: 'HELD_WITHDRAWAL',
      txnType: 'WITHDRAWAL',
      txnId: randomUUID(),
      idempotencyKey: `hold:${randomUUID()}`,
    });

    expect(held.quantity.toString()).toBe('40');
    expect(held.status).toBe('HELD_WITHDRAWAL');
    expect(held.approvalStatus).toBe('PENDING');
    expect(remainder).not.toBeNull();
    expect(remainder!.quantity.toString()).toBe('60');
    expect(remainder!.status).toBe('ACTIVE');
    expect(remainder!.rootReceiptId).toBe(root.id);

    const split = await prisma.receipt.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(split.status).toBe('SPLIT');
    expect(split.isParent).toBe(true);

    let r = await recon.reconcileRoot(root.id);
    expect(r.balanced).toBe(true);

    await ledger.approveHold({
      tenantId: f.tenantId,
      heldReceiptId: held.id,
      actorUserId: f.clientId,
      idempotencyKey: `aph:${held.id}`,
    });
    await ledger.consume({
      tenantId: f.tenantId,
      heldReceiptId: held.id,
      actorUserId: f.clientId,
      idempotencyKey: `con:${held.id}`,
    });

    const consumed = await prisma.receipt.findUniqueOrThrow({
      where: { id: held.id },
    });
    expect(consumed.status).toBe('WITHDRAWN');

    r = await recon.reconcileRoot(root.id);
    expect(r.balanced).toBe(true);
    expect((await recon.replayVerify(root.id)).ok).toBe(true);
  });

  it('release returns a held node to ACTIVE, still reconciled', async () => {
    const root = await depositApproved(f, '50');
    const { held } = await ledger.hold({
      tenantId: f.tenantId,
      sourceReceiptId: root.id,
      quantity: '50',
      heldStatus: 'HELD_TRADE',
      txnType: 'TRADE',
      txnId: randomUUID(),
      idempotencyKey: `hold:${randomUUID()}`,
    });
    await ledger.release({
      tenantId: f.tenantId,
      heldReceiptId: held.id,
      actorUserId: f.clientId,
      idempotencyKey: `rel:${held.id}`,
    });
    const back = await prisma.receipt.findUniqueOrThrow({
      where: { id: held.id },
    });
    expect(back.status).toBe('ACTIVE');
    expect(back.approvalStatus).toBe('APPROVED');
    expect((await recon.reconcileRoot(root.id)).balanced).toBe(true);
  });

  it('partial seize: financier gets seized portion, client keeps remainder', async () => {
    const root = await depositApproved(f, '200');
    const { held } = await ledger.hold({
      tenantId: f.tenantId,
      sourceReceiptId: root.id,
      quantity: '200',
      heldStatus: 'HELD_LOAN',
      txnType: 'LOAN',
      txnId: randomUUID(),
      idempotencyKey: `hold:${randomUUID()}`,
    });
    const { seized, remainder } = await ledger.seize({
      tenantId: f.tenantId,
      heldLoanReceiptId: held.id,
      financierUserId: f.financierId,
      idempotencyKey: `sz:${held.id}`,
      partialQuantity: '120',
    });
    expect(seized.status).toBe('SEIZED');
    expect(seized.clientId).toBe(f.financierId);
    expect(seized.quantity.toString()).toBe('120');
    expect(remainder!.quantity.toString()).toBe('80');
    expect(remainder!.clientId).toBe(f.clientId);
    expect(remainder!.status).toBe('ACTIVE');
    expect((await recon.reconcileRoot(root.id)).balanced).toBe(true);
  });
});

describe('idempotency', () => {
  it('same key twice → same held node, one event, reconciled', async () => {
    const root = await depositApproved(f, '100');
    const key = `hold:${randomUUID()}`;
    const args = {
      tenantId: f.tenantId,
      sourceReceiptId: root.id,
      quantity: '30',
      heldStatus: 'HELD_WITHDRAWAL' as const,
      txnType: 'WITHDRAWAL' as const,
      txnId: randomUUID(),
      idempotencyKey: key,
    };
    const a = await ledger.hold(args);
    const b = await ledger.hold(args);
    expect(b.held.id).toBe(a.held.id);

    const events = await prisma.inventoryEvent.count({
      where: { idempotencyKey: key },
    });
    expect(events).toBe(1);
    expect((await recon.reconcileRoot(root.id)).balanced).toBe(true);
  });
});

describe('concurrency — no oversell under contention', () => {
  it('8 parallel holds of 70 on a 100 leaf: exactly one wins', async () => {
    const root = await depositApproved(f, '100');

    const attempts = Array.from({ length: 8 }, () =>
      ledger.hold({
        tenantId: f.tenantId,
        sourceReceiptId: root.id,
        quantity: '70',
        heldStatus: 'HELD_WITHDRAWAL',
        txnType: 'WITHDRAWAL',
        txnId: randomUUID(),
        idempotencyKey: `hold:${randomUUID()}`, // distinct → genuine race
      }),
    );
    const settled = await Promise.allSettled(attempts);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const failed = settled.filter((s) => s.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(7);

    const r = await recon.reconcileRoot(root.id);
    expect(r.balanced).toBe(true);

    const children = await prisma.receipt.findMany({
      where: { parentReceiptId: root.id },
    });
    const held = children.filter((c) => c.status === 'HELD_WITHDRAWAL');
    const rem = children.filter((c) => c.status === 'ACTIVE');
    expect(held).toHaveLength(1);
    expect(held[0].quantity.toString()).toBe('70');
    expect(rem).toHaveLength(1);
    expect(rem[0].quantity.toString()).toBe('30');
  });
});

describe('property — invariant holds across a random op sequence', () => {
  it('reconciles after every step', async () => {
    const root = await depositApproved(f, '1000');
    // tiny seeded LCG for determinism
    let seed = 1234567;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    const activeLeaves: string[] = [root.id];
    const heldLeaves: string[] = [];

    for (let i = 0; i < 14; i++) {
      if (activeLeaves.length && rnd() < 0.6) {
        const idx = Math.floor(rnd() * activeLeaves.length);
        const leafId = activeLeaves[idx];
        const leaf = await prisma.receipt.findUniqueOrThrow({
          where: { id: leafId },
        });
        const q = leaf.quantity;
        const take = q
          .times(Math.max(0.1, Math.min(0.9, rnd())).toFixed(4))
          .toDecimalPlaces(3);
        if (take.lte(0) || take.gt(q)) continue;
        const { held, remainder } = await ledger.hold({
          tenantId: f.tenantId,
          sourceReceiptId: leafId,
          quantity: take.toString(),
          heldStatus: 'HELD_WITHDRAWAL',
          txnType: 'WITHDRAWAL',
          txnId: randomUUID(),
          idempotencyKey: `hold:${randomUUID()}`,
        });
        activeLeaves.splice(idx, 1);
        if (remainder) activeLeaves.push(remainder.id);
        heldLeaves.push(held.id);
      } else if (heldLeaves.length) {
        const idx = Math.floor(rnd() * heldLeaves.length);
        const hId = heldLeaves.splice(idx, 1)[0];
        if (rnd() < 0.5) {
          await ledger.consume({
            tenantId: f.tenantId,
            heldReceiptId: hId,
            actorUserId: f.clientId,
            idempotencyKey: `con:${hId}`,
          });
        } else {
          await ledger.release({
            tenantId: f.tenantId,
            heldReceiptId: hId,
            actorUserId: f.clientId,
            idempotencyKey: `rel:${hId}`,
          });
          activeLeaves.push(hId);
        }
      }

      const r = await recon.reconcileRoot(root.id);
      expect(r.balanced).toBe(true);
    }

    expect((await recon.replayVerify(root.id)).ok).toBe(true);
    expect((await recon.verifyAll(f.tenantId)).ok).toBe(true);
  });
});
