import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  InventoryEvent,
  InventoryEventType,
  Prisma,
  Receipt,
  TxnType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  baseReceiptNumber,
  existingChildSuffixes,
  lockReceiptForUpdate,
  nextSuffix,
  Tx,
  withSerializableTx,
} from './inventory.tx';
import {
  D,
  HeldStatus,
  HoldResult,
  HELD_STATUSES,
  InsufficientQuantityException,
  InvalidStateTransitionException,
  ReceiptNode,
  ReceiptNotFoundException,
  ReceiptNotTransactableException,
  SeizeResult,
} from './inventory.types';

interface ActorCtx {
  tenantId: string;
  actorUserId?: string;
  idempotencyKey: string;
}

@Injectable()
export class InventoryLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Idempotency wrapper. Prior event (by key) → reconstruct, mutate nothing.
  // The @unique constraint is the hard backstop under concurrency.
  // -------------------------------------------------------------------------
  private async runIdempotent<T>(
    key: string,
    reconstruct: (e: InventoryEvent) => Promise<T>,
    work: () => Promise<T>,
  ): Promise<T> {
    const prior = await this.prisma.inventoryEvent.findUnique({
      where: { idempotencyKey: key },
    });
    if (prior) return reconstruct(prior);
    try {
      return await work();
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const ev = await this.prisma.inventoryEvent.findUnique({
          where: { idempotencyKey: key },
        });
        if (ev) return reconstruct(ev);
      }
      throw e;
    }
  }

  private async loadOrThrow(
    tx: Tx,
    id: string,
    tenantId: string,
  ): Promise<Receipt> {
    const r = await tx.receipt.findFirst({ where: { id, tenantId } });
    if (!r) throw new ReceiptNotFoundException(id);
    return r;
  }

  private byEvent = async (e: InventoryEvent): Promise<Receipt[]> =>
    this.prisma.receipt.findMany({ where: { sourceEventId: e.id } });

  private affected = async (e: InventoryEvent): Promise<Receipt> =>
    this.loadOrThrow(
      this.prisma as unknown as Tx,
      e.fromReceiptId as string,
      e.tenantId,
    );

  /** Split a locked source into a primary child + optional ACTIVE remainder. */
  private async partition(
    tx: Tx,
    source: Receipt,
    primaryQty: Prisma.Decimal,
    primary: {
      status: Receipt['status'];
      approvalStatus: Receipt['approvalStatus'];
      clientId: string;
      sourceTxnType: TxnType | null;
      sourceTxnId: string | null;
    },
    eventId: string,
  ): Promise<{ primary: Receipt; remainder: Receipt | null }> {
    const base = baseReceiptNumber(source.receiptNumber);
    const taken = await existingChildSuffixes(tx, base);

    const primarySuffix = nextSuffix(taken);
    const primaryRow = await tx.receipt.create({
      data: {
        receiptNumber: `${base}-${primarySuffix}`,
        status: primary.status,
        tenantId: source.tenantId,
        commodityId: source.commodityId,
        quantity: primaryQty,
        grade: source.grade,
        warehouseId: source.warehouseId,
        clientId: primary.clientId,
        approvalStatus: primary.approvalStatus,
        parentReceiptId: source.id,
        rootReceiptId: source.rootReceiptId,
        sourceTxnType: primary.sourceTxnType,
        sourceTxnId: primary.sourceTxnId,
        sourceEventId: eventId,
        dateOfDeposit: source.dateOfDeposit,
        expiryDate: source.expiryDate,
      },
    });

    let remainder: Receipt | null = null;
    const remQty = source.quantity.minus(primaryQty);
    if (remQty.gt(0)) {
      const remSuffix = nextSuffix([...taken, primarySuffix]);
      remainder = await tx.receipt.create({
        data: {
          receiptNumber: `${base}-${remSuffix}`,
          status: 'ACTIVE',
          tenantId: source.tenantId,
          commodityId: source.commodityId,
          quantity: remQty,
          grade: source.grade,
          warehouseId: source.warehouseId,
          clientId: source.clientId,
          approvalStatus: 'APPROVED',
          parentReceiptId: source.id,
          rootReceiptId: source.rootReceiptId,
          sourceEventId: eventId,
          dateOfDeposit: source.dateOfDeposit,
          expiryDate: source.expiryDate,
        },
      });
    }

    await tx.receipt.update({
      where: { id: source.id },
      data: { status: 'SPLIT', isParent: true, supersededAt: new Date() },
    });

    return { primary: primaryRow, remainder };
  }

  private event(
    tx: Tx,
    data: {
      tenantId: string;
      rootReceiptId: string;
      fromReceiptId: string;
      eventType: InventoryEventType;
      quantity: Prisma.Decimal;
      txnType?: TxnType | null;
      txnId?: string | null;
      actorUserId?: string | null;
      idempotencyKey: string;
      reversalOfEventId?: string | null;
      metadata?: Prisma.InputJsonValue;
    },
  ) {
    return tx.inventoryEvent.create({
      data: {
        id: randomUUID(),
        tenantId: data.tenantId,
        rootReceiptId: data.rootReceiptId,
        fromReceiptId: data.fromReceiptId,
        eventType: data.eventType,
        txnType: data.txnType ?? null,
        txnId: data.txnId ?? null,
        quantity: data.quantity,
        actorUserId: data.actorUserId ?? null,
        idempotencyKey: data.idempotencyKey,
        reversalOfEventId: data.reversalOfEventId ?? null,
        metadata: data.metadata,
      },
    });
  }

  // -------------------------------------------------------------------------
  // deposit — mint a root (manager-created, awaiting approval)
  // -------------------------------------------------------------------------
  async deposit(input: {
    tenantId: string;
    clientId: string;
    commodityId: string;
    warehouseId: string;
    quantity: Prisma.Decimal.Value;
    grade?: string | null;
    dateOfDeposit: Date;
    expiryDate?: Date | null;
    receiptNumber?: string;
    actorUserId?: string;
    idempotencyKey: string;
    gradingScores?: Prisma.InputJsonValue;
  }): Promise<ReceiptNode> {
    const qty = D(input.quantity);
    if (qty.lte(0)) {
      throw new InsufficientQuantityException(qty.toString(), '0');
    }
    return this.runIdempotent(
      input.idempotencyKey,
      async (e) => this.affected(e),
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          const id = randomUUID();
          const number =
            input.receiptNumber ??
            `WR-${new Date().getFullYear()}-${id.slice(0, 8).toUpperCase()}`;

          const root = await tx.receipt.create({
            data: {
              id,
              receiptNumber: number,
              status: 'PENDING_APPROVAL',
              tenantId: input.tenantId,
              commodityId: input.commodityId,
              quantity: qty,
              grade: input.grade ?? null,
              warehouseId: input.warehouseId,
              clientId: input.clientId,
              approvalStatus: 'PENDING',
              gradingScores: input.gradingScores,
              parentReceiptId: null,
              rootReceiptId: id,
              sourceTxnType: 'DEPOSIT',
              dateOfDeposit: input.dateOfDeposit,
              expiryDate: input.expiryDate ?? null,
            },
          });

          const ev = await this.event(tx, {
            tenantId: input.tenantId,
            rootReceiptId: id,
            fromReceiptId: id,
            eventType: 'DEPOSIT',
            quantity: qty,
            txnType: 'DEPOSIT',
            actorUserId: input.actorUserId,
            idempotencyKey: input.idempotencyKey,
          });

          return tx.receipt.update({
            where: { id },
            data: { sourceEventId: ev.id },
          });
        }),
    );
  }

  // -------------------------------------------------------------------------
  // deposit approval lifecycle (status-only on the root)
  // -------------------------------------------------------------------------
  async approveReceipt(args: {
    tenantId: string;
    receiptId: string;
    actorUserId: string;
    idempotencyKey: string;
    computedGrade?: string;
    gradingScores?: Prisma.InputJsonValue;
  }): Promise<ReceiptNode> {
    return this.runIdempotent(
      args.idempotencyKey,
      (e) => this.affected(e),
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          await lockReceiptForUpdate(tx, args.receiptId, args.tenantId);
          const r = await this.loadOrThrow(tx, args.receiptId, args.tenantId);
          if (r.status !== 'PENDING_APPROVAL') {
            throw new InvalidStateTransitionException(
              `Receipt ${r.id} is not PENDING_APPROVAL (status=${r.status})`,
            );
          }
          await this.event(tx, {
            tenantId: args.tenantId,
            rootReceiptId: r.rootReceiptId,
            fromReceiptId: r.id,
            eventType: 'APPROVED',
            quantity: r.quantity,
            txnType: 'DEPOSIT',
            actorUserId: args.actorUserId,
            idempotencyKey: args.idempotencyKey,
          });
          return tx.receipt.update({
            where: { id: r.id },
            data: {
              status: 'ACTIVE',
              approvalStatus: 'APPROVED',
              approvedById: args.actorUserId,
              approvedAt: new Date(),
              computedGrade: args.computedGrade ?? r.computedGrade,
              gradingScores: args.gradingScores ?? r.gradingScores ?? undefined,
            },
          });
        }),
    );
  }

  async rejectReceipt(args: {
    tenantId: string;
    receiptId: string;
    actorUserId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<ReceiptNode> {
    return this.runIdempotent(
      args.idempotencyKey,
      (e) => this.affected(e),
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          await lockReceiptForUpdate(tx, args.receiptId, args.tenantId);
          const r = await this.loadOrThrow(tx, args.receiptId, args.tenantId);
          if (r.status !== 'PENDING_APPROVAL') {
            throw new InvalidStateTransitionException(
              `Receipt ${r.id} is not PENDING_APPROVAL (status=${r.status})`,
            );
          }
          await this.event(tx, {
            tenantId: args.tenantId,
            rootReceiptId: r.rootReceiptId,
            fromReceiptId: r.id,
            eventType: 'REJECTED',
            quantity: r.quantity,
            txnType: 'DEPOSIT',
            actorUserId: args.actorUserId,
            idempotencyKey: args.idempotencyKey,
            metadata: { reason: args.reason },
          });
          return tx.receipt.update({
            where: { id: r.id },
            data: {
              status: 'CANCELLED',
              approvalStatus: 'REJECTED',
              rejectionReason: args.reason,
              approvedById: args.actorUserId,
              approvedAt: new Date(),
            },
          });
        }),
    );
  }

  // -------------------------------------------------------------------------
  // hold — the request-time partition (only contended path)
  // -------------------------------------------------------------------------
  async hold(input: {
    tenantId: string;
    sourceReceiptId: string;
    quantity: Prisma.Decimal.Value;
    heldStatus: HeldStatus;
    txnType: TxnType;
    txnId: string;
    actorUserId?: string;
    idempotencyKey: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<HoldResult> {
    const qty = D(input.quantity);
    return this.runIdempotent(
      input.idempotencyKey,
      async (e) => {
        const kids = await this.byEvent(e);
        const held = kids.find((k) =>
          (HELD_STATUSES as string[]).includes(k.status),
        );
        const remainder =
          kids.find((k) => k.status === 'ACTIVE') ?? null;
        return {
          source: await this.affected(e),
          held: held as Receipt,
          remainder,
        };
      },
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          await lockReceiptForUpdate(
            tx,
            input.sourceReceiptId,
            input.tenantId,
          );
          const src = await this.loadOrThrow(
            tx,
            input.sourceReceiptId,
            input.tenantId,
          );
          if (src.status !== 'ACTIVE' || src.approvalStatus !== 'APPROVED') {
            throw new ReceiptNotTransactableException(
              src.id,
              src.status,
              src.approvalStatus,
            );
          }
          if (src.isParent) {
            throw new ReceiptNotTransactableException(
              src.id,
              'SPLIT',
              src.approvalStatus,
            );
          }
          if (qty.lte(0)) {
            throw new InsufficientQuantityException(qty.toString(), '0');
          }
          if (qty.gt(src.quantity)) {
            throw new InsufficientQuantityException(
              qty.toString(),
              src.quantity.toString(),
            );
          }

          const ev = await this.event(tx, {
            tenantId: input.tenantId,
            rootReceiptId: src.rootReceiptId,
            fromReceiptId: src.id,
            eventType: 'HOLD_PLACED',
            quantity: qty,
            txnType: input.txnType,
            txnId: input.txnId,
            actorUserId: input.actorUserId,
            idempotencyKey: input.idempotencyKey,
            metadata: input.metadata,
          });

          const { primary, remainder } = await this.partition(
            tx,
            src,
            qty,
            {
              status: input.heldStatus,
              approvalStatus: 'PENDING',
              clientId: src.clientId,
              sourceTxnType: input.txnType,
              sourceTxnId: input.txnId,
            },
            ev.id,
          );

          return {
            source: { ...src, status: 'SPLIT', isParent: true },
            held: primary,
            remainder,
          };
        }),
    );
  }

  // -------------------------------------------------------------------------
  // status-only transitions on a held node
  // -------------------------------------------------------------------------
  private assertHeld(r: Receipt): void {
    if (!(HELD_STATUSES as string[]).includes(r.status)) {
      throw new InvalidStateTransitionException(
        `Receipt ${r.id} is not held (status=${r.status})`,
      );
    }
  }

  async approveHold(args: ActorCtx & { heldReceiptId: string }): Promise<ReceiptNode> {
    return this.runIdempotent(
      args.idempotencyKey,
      (e) => this.affected(e),
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          await lockReceiptForUpdate(tx, args.heldReceiptId, args.tenantId);
          const r = await this.loadOrThrow(tx, args.heldReceiptId, args.tenantId);
          this.assertHeld(r);
          if (r.approvalStatus !== 'PENDING') {
            throw new InvalidStateTransitionException(
              `Hold ${r.id} is not awaiting approval (approval=${r.approvalStatus})`,
            );
          }
          await this.event(tx, {
            tenantId: args.tenantId,
            rootReceiptId: r.rootReceiptId,
            fromReceiptId: r.id,
            eventType: 'APPROVED',
            quantity: r.quantity,
            txnType: r.sourceTxnType,
            txnId: r.sourceTxnId,
            actorUserId: args.actorUserId,
            idempotencyKey: args.idempotencyKey,
          });
          return tx.receipt.update({
            where: { id: r.id },
            data: {
              approvalStatus: 'APPROVED',
              approvedById: args.actorUserId,
              approvedAt: new Date(),
            },
          });
        }),
    );
  }

  async release(
    args: ActorCtx & { heldReceiptId: string; reason?: string },
  ): Promise<ReceiptNode> {
    return this.runIdempotent(
      args.idempotencyKey,
      (e) => this.affected(e),
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          await lockReceiptForUpdate(tx, args.heldReceiptId, args.tenantId);
          const r = await this.loadOrThrow(tx, args.heldReceiptId, args.tenantId);
          this.assertHeld(r);
          await this.event(tx, {
            tenantId: args.tenantId,
            rootReceiptId: r.rootReceiptId,
            fromReceiptId: r.id,
            eventType: 'HOLD_RELEASED',
            quantity: r.quantity,
            txnType: r.sourceTxnType,
            txnId: r.sourceTxnId,
            actorUserId: args.actorUserId,
            idempotencyKey: args.idempotencyKey,
            reversalOfEventId: r.sourceEventId,
            metadata: args.reason ? { reason: args.reason } : undefined,
          });
          return tx.receipt.update({
            where: { id: r.id },
            data: { status: 'ACTIVE', approvalStatus: 'APPROVED' },
          });
        }),
    );
  }

  async consume(args: ActorCtx & { heldReceiptId: string }): Promise<ReceiptNode> {
    return this.runIdempotent(
      args.idempotencyKey,
      (e) => this.affected(e),
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          await lockReceiptForUpdate(tx, args.heldReceiptId, args.tenantId);
          const r = await this.loadOrThrow(tx, args.heldReceiptId, args.tenantId);
          this.assertHeld(r);
          await this.event(tx, {
            tenantId: args.tenantId,
            rootReceiptId: r.rootReceiptId,
            fromReceiptId: r.id,
            eventType: 'CONSUMED',
            quantity: r.quantity,
            txnType: r.sourceTxnType,
            txnId: r.sourceTxnId,
            actorUserId: args.actorUserId,
            idempotencyKey: args.idempotencyKey,
          });
          return tx.receipt.update({
            where: { id: r.id },
            data: { status: 'WITHDRAWN' },
          });
        }),
    );
  }

  // -------------------------------------------------------------------------
  // seize — loan default. FULL = status-only + ownership; PARTIAL = split.
  // -------------------------------------------------------------------------
  async seize(input: {
    tenantId: string;
    heldLoanReceiptId: string;
    financierUserId: string;
    actorUserId?: string;
    idempotencyKey: string;
    partialQuantity?: Prisma.Decimal.Value;
  }): Promise<SeizeResult> {
    return this.runIdempotent(
      input.idempotencyKey,
      async (e) => {
        const kids = await this.byEvent(e);
        if (kids.length) {
          return {
            seized: kids.find((k) => k.status === 'SEIZED') as Receipt,
            remainder: kids.find((k) => k.status === 'ACTIVE') ?? null,
          };
        }
        return { seized: await this.affected(e), remainder: null };
      },
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          await lockReceiptForUpdate(
            tx,
            input.heldLoanReceiptId,
            input.tenantId,
          );
          const r = await this.loadOrThrow(
            tx,
            input.heldLoanReceiptId,
            input.tenantId,
          );
          if (r.status !== 'HELD_LOAN') {
            throw new InvalidStateTransitionException(
              `Receipt ${r.id} is not HELD_LOAN (status=${r.status})`,
            );
          }

          const ev = await this.event(tx, {
            tenantId: input.tenantId,
            rootReceiptId: r.rootReceiptId,
            fromReceiptId: r.id,
            eventType: 'SEIZED',
            quantity: r.quantity,
            txnType: 'LOAN',
            txnId: r.sourceTxnId,
            actorUserId: input.actorUserId,
            idempotencyKey: input.idempotencyKey,
            metadata: { financierUserId: input.financierUserId },
          });

          if (input.partialQuantity !== undefined) {
            const pq = D(input.partialQuantity);
            if (pq.lte(0) || pq.gte(r.quantity)) {
              throw new InsufficientQuantityException(
                pq.toString(),
                r.quantity.toString(),
              );
            }
            const { primary, remainder } = await this.partition(
              tx,
              r,
              pq,
              {
                status: 'SEIZED',
                approvalStatus: 'APPROVED',
                clientId: input.financierUserId,
                sourceTxnType: 'LOAN',
                sourceTxnId: r.sourceTxnId,
              },
              ev.id,
            );
            return { seized: primary, remainder };
          }

          const seized = await tx.receipt.update({
            where: { id: r.id },
            data: { status: 'SEIZED', clientId: input.financierUserId },
          });
          return { seized, remainder: null };
        }),
    );
  }

  // -------------------------------------------------------------------------
  // transferOwnership — clientId change, lineage/root preserved
  // -------------------------------------------------------------------------
  async transferOwnership(args: {
    tenantId: string;
    receiptId: string;
    newOwnerId: string;
    txnType: TxnType;
    txnId: string;
    actorUserId?: string;
    idempotencyKey: string;
  }): Promise<ReceiptNode> {
    return this.runIdempotent(
      args.idempotencyKey,
      (e) => this.affected(e),
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          await lockReceiptForUpdate(tx, args.receiptId, args.tenantId);
          const r = await this.loadOrThrow(tx, args.receiptId, args.tenantId);
          await this.event(tx, {
            tenantId: args.tenantId,
            rootReceiptId: r.rootReceiptId,
            fromReceiptId: r.id,
            eventType: 'OWNERSHIP_TRANSFERRED',
            quantity: r.quantity,
            txnType: args.txnType,
            txnId: args.txnId,
            actorUserId: args.actorUserId,
            idempotencyKey: args.idempotencyKey,
            metadata: { from: r.clientId, to: args.newOwnerId },
          });
          return tx.receipt.update({
            where: { id: r.id },
            data: { clientId: args.newOwnerId },
          });
        }),
    );
  }

  // -------------------------------------------------------------------------
  // transferAndRelease — atomic "settle a held receipt to a new owner".
  // One serializable txn, one row lock, both ledger events, one row update.
  // Replaces the two-step transferOwnership + release pattern used by trade
  // settlement so there is no window where ownership has moved but the hold
  // is still active (or vice-versa).
  // -------------------------------------------------------------------------
  async transferAndRelease(args: {
    tenantId: string;
    heldReceiptId: string;
    newOwnerId: string;
    txnType: TxnType;
    txnId: string;
    actorUserId?: string;
    idempotencyKey: string;
    /**
     * Optional caller work, run inside the same serializable txn after the
     * receipt mutation. If it throws, the entire txn rolls back — ledger
     * events, receipt update, and the caller's work all unwind together.
     * Not re-run on idempotent replay (the prior commit already executed it
     * atomically alongside the ledger mutation).
     */
    withinTx?: (tx: Tx, receipt: Receipt) => Promise<void>;
  }): Promise<ReceiptNode> {
    return this.runIdempotent(
      args.idempotencyKey,
      (e) => this.affected(e),
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          await lockReceiptForUpdate(tx, args.heldReceiptId, args.tenantId);
          const r = await this.loadOrThrow(tx, args.heldReceiptId, args.tenantId);
          this.assertHeld(r);

          await this.event(tx, {
            tenantId: args.tenantId,
            rootReceiptId: r.rootReceiptId,
            fromReceiptId: r.id,
            eventType: 'OWNERSHIP_TRANSFERRED',
            quantity: r.quantity,
            txnType: args.txnType,
            txnId: args.txnId,
            actorUserId: args.actorUserId,
            idempotencyKey: args.idempotencyKey,
            metadata: { from: r.clientId, to: args.newOwnerId },
          });
          await this.event(tx, {
            tenantId: args.tenantId,
            rootReceiptId: r.rootReceiptId,
            fromReceiptId: r.id,
            eventType: 'HOLD_RELEASED',
            quantity: r.quantity,
            txnType: args.txnType,
            txnId: args.txnId,
            actorUserId: args.actorUserId,
            idempotencyKey: `${args.idempotencyKey}:release`,
            reversalOfEventId: r.sourceEventId,
          });

          const updated = await tx.receipt.update({
            where: { id: r.id },
            data: {
              clientId: args.newOwnerId,
              status: 'ACTIVE',
              approvalStatus: 'APPROVED',
            },
          });
          if (args.withinTx) await args.withinTx(tx, updated);
          return updated;
        }),
    );
  }

  // -------------------------------------------------------------------------
  // expire — only ACTIVE leaves; held nodes are exempt
  // -------------------------------------------------------------------------
  async expire(args: ActorCtx & { receiptId: string }): Promise<ReceiptNode> {
    return this.runIdempotent(
      args.idempotencyKey,
      (e) => this.affected(e),
      () =>
        withSerializableTx(this.prisma, async (tx) => {
          await lockReceiptForUpdate(tx, args.receiptId, args.tenantId);
          const r = await this.loadOrThrow(tx, args.receiptId, args.tenantId);
          if (r.status !== 'ACTIVE') {
            throw new InvalidStateTransitionException(
              `Only ACTIVE leaves expire (receipt ${r.id} status=${r.status})`,
            );
          }
          await this.event(tx, {
            tenantId: args.tenantId,
            rootReceiptId: r.rootReceiptId,
            fromReceiptId: r.id,
            eventType: 'EXPIRED',
            quantity: r.quantity,
            actorUserId: args.actorUserId,
            idempotencyKey: args.idempotencyKey,
          });
          return tx.receipt.update({
            where: { id: r.id },
            data: { status: 'EXPIRED' },
          });
        }),
    );
  }
}
