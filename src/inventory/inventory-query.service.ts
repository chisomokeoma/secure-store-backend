import { Injectable } from '@nestjs/common';
import { Prisma, TxnType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  deriveGroup,
  D,
  HELD_STATUSES,
  ReceiptGroup,
  ReceiptNotFoundException,
  statusesForGroup,
} from './inventory.types';

@Injectable()
export class InventoryQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * User-facing balance — computed, never stored. Per commodity:
   * Available = Σ ACTIVE & APPROVED; Locked = Σ HELD_*; Total = sum.
   */
  async getBalance(tenantId: string, clientId: string) {
    const [available, locked, commodities] = await Promise.all([
      this.prisma.receipt.groupBy({
        by: ['commodityId'],
        where: {
          tenantId,
          clientId,
          status: 'ACTIVE',
          approvalStatus: 'APPROVED',
        },
        _sum: { quantity: true },
      }),
      this.prisma.receipt.groupBy({
        by: ['commodityId'],
        where: { tenantId, clientId, status: { in: HELD_STATUSES } },
        _sum: { quantity: true },
      }),
      this.prisma.commodity.findMany({
        where: { tenantId },
        select: { id: true, name: true, unitOfMeasure: true },
      }),
    ]);

    const cmap = new Map(commodities.map((c) => [c.id, c]));
    const acc = new Map<
      string,
      { available: Prisma.Decimal; locked: Prisma.Decimal }
    >();
    const ensure = (id: string) => {
      if (!acc.has(id)) acc.set(id, { available: D(0), locked: D(0) });
      return acc.get(id)!;
    };
    for (const a of available)
      ensure(a.commodityId).available = a._sum.quantity ?? D(0);
    for (const l of locked)
      ensure(l.commodityId).locked = l._sum.quantity ?? D(0);

    return [...acc.entries()].map(([commodityId, v]) => ({
      commodityId,
      commodity: cmap.get(commodityId)?.name ?? null,
      unit: cmap.get(commodityId)?.unitOfMeasure ?? null,
      available: v.available.toString(),
      locked: v.locked.toString(),
      total: v.available.plus(v.locked).toString(),
    }));
  }

  async listReceipts(
    tenantId: string,
    opts: {
      group?: ReceiptGroup;
      clientId?: string;
      warehouseIds?: string[];
      page?: number;
      limit?: number;
      search?: string;
    } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 20));
    const where: Prisma.ReceiptWhereInput = { tenantId };
    if (opts.clientId) where.clientId = opts.clientId;
    if (opts.warehouseIds) where.warehouseId = { in: opts.warehouseIds };
    if (opts.group) where.status = { in: statusesForGroup(opts.group) };
    if (opts.search) {
      where.OR = [
        { receiptNumber: { contains: opts.search, mode: 'insensitive' } },
        { commodity: { name: { contains: opts.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        include: {
          commodity: { select: { name: true, unitOfMeasure: true } },
          warehouse: { select: { name: true } },
          childReceipts: { select: { id: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.receipt.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        receiptNumber: r.receiptNumber,
        status: r.status,
        approvalStatus: r.approvalStatus,
        grade: r.grade,
        group: deriveGroup(r),
        isParent: r.isParent,
        supersededAt: r.supersededAt,
        childReceiptIds: r.childReceipts.map((c) => c.id),
        commodity: r.commodity.name,
        unit: r.commodity.unitOfMeasure,
        warehouse: r.warehouse.name,
        quantity: r.quantity.toString(),
        rootReceiptId: r.rootReceiptId,
        parentReceiptId: r.parentReceiptId,
        createdAt: r.createdAt,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  /** Breadcrumb root → … → node via a single recursive CTE. */
  private async pathToRoot(id: string) {
    return this.prisma.$queryRawUnsafe<
      { id: string; receipt_number: string; status: string; depth: number }[]
    >(
      `WITH RECURSIVE anc AS (
         SELECT id, receipt_number, status, parent_receipt_id, 0 AS depth
           FROM receipts WHERE id = $1
         UNION ALL
         SELECT r.id, r.receipt_number, r.status, r.parent_receipt_id, a.depth + 1
           FROM receipts r JOIN anc a ON r.id = a.parent_receipt_id
       )
       SELECT id, receipt_number, status, depth FROM anc ORDER BY depth DESC`,
      id,
    );
  }

  /** Active storage-fee policy with fallback (warehouse+commodity → warehouse → commodity → tenant default), soft (null if none). */
  private async resolveStorageFeePolicy(
    tenantId: string,
    warehouseId: string,
    commodityId: string,
  ) {
    const cands = [
      { warehouseId, commodityId },
      { warehouseId, commodityId: null },
      { warehouseId: null, commodityId },
      { warehouseId: null, commodityId: null },
    ];
    for (const c of cands) {
      const p = await this.prisma.storageFeePolicy.findFirst({
        where: { tenantId, isActive: true, ...c },
        orderBy: { createdAt: 'desc' },
      });
      if (p) return p;
    }
    return null;
  }

  async getReceiptDetail(tenantId: string, id: string) {
    const r = await this.prisma.receipt.findFirst({
      where: { id, tenantId },
      include: {
        commodity: { select: { name: true, unitOfMeasure: true } },
        warehouse: { select: { name: true, location: true } },
        client: { select: { id: true, firstName: true, lastName: true } },
        // Approver — surfaced on the printable/emailable receipt so the
        // document records who admitted the inventory.
        approvedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            managerCode: true,
            profilePhotoUrl: true,
          },
        },
        childReceipts: {
          select: { id: true, receiptNumber: true, status: true, quantity: true },
        },
        sourceEvent: {
          include: {
            actor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                managerCode: true,
                profilePhotoUrl: true,
              },
            },
          },
        },
      },
    });
    if (!r) throw new ReceiptNotFoundException(id);

    const [path, events, storageFeePolicy] = await Promise.all([
      this.pathToRoot(id),
      this.prisma.inventoryEvent.findMany({
        where: { OR: [{ fromReceiptId: id }, { createdReceipts: { some: { id } } }] },
        orderBy: { occurredAt: 'asc' },
      }),
      this.resolveStorageFeePolicy(tenantId, r.warehouseId, r.commodityId),
    ]);

    return {
      id: r.id,
      receiptNumber: r.receiptNumber,
      status: r.status,
      approvalStatus: r.approvalStatus,
      group: deriveGroup(r),
      isParent: r.isParent,
      supersededAt: r.supersededAt,
      quantity: r.quantity.toString(),
      commodity: r.commodity.name,
      unit: r.commodity.unitOfMeasure,
      // ── Printable / emailable receipt fields ─────────────────────────────
      // Everything below this comment exists specifically because the FE
      // renders a "print this receipt" / "email this receipt" view and the
      // physical document needs to record the canonical facts of the
      // deposit: when the goods arrived, when the receipt expires (if at
      // all), what grade the commodity was admitted at, when an admin
      // signed off, and who that admin was. Nullable across the board
      // because legacy / seed rows may not have all of these.
      dateOfDeposit: r.dateOfDeposit,
      expiryDate: r.expiryDate,
      grade: r.grade,
      computedGrade: r.computedGrade,
      approvedAt: r.approvedAt,
      approvedBy: r.approvedBy
        ? {
            id: r.approvedBy.id,
            name: `${r.approvedBy.firstName} ${r.approvedBy.lastName}`,
            managerCode: r.approvedBy.managerCode,
            profilePhotoUrl: r.approvedBy.profilePhotoUrl ?? null,
          }
        : null,
      warehouse: { name: r.warehouse.name, location: r.warehouse.location },
      owner: r.client,
      provenance: {
        rootReceiptId: r.rootReceiptId,
        parentReceiptId: r.parentReceiptId,
        pathToRoot: path.map((p) => ({
          id: p.id,
          receiptNumber: p.receipt_number,
          status: p.status,
        })),
      },
      origin: {
        sourceTxnType: r.sourceTxnType,
        sourceTxnId: r.sourceTxnId,
        sourceEvent: r.sourceEvent
          ? { id: r.sourceEvent.id, eventType: r.sourceEvent.eventType }
          : null,
      },
      // The warehouse manager who created/deposited this receipt (from the
      // genesis event's actor). Null for legacy/seeded receipts with no actor.
      manager: r.sourceEvent?.actor
        ? {
            id: r.sourceEvent.actor.id,
            name: `${r.sourceEvent.actor.firstName} ${r.sourceEvent.actor.lastName}`,
            managerCode: r.sourceEvent.actor.managerCode,
            profilePhotoUrl: r.sourceEvent.actor.profilePhotoUrl ?? null,
          }
        : null,
      // Active storage-fee policy that will apply to this receipt.
      storageFeePolicy: storageFeePolicy
        ? {
            id: storageFeePolicy.id,
            feeType: storageFeePolicy.feeType,
            rate: storageFeePolicy.rate,
            billingFrequency: storageFeePolicy.billingFrequency,
            gracePeriodDays: storageFeePolicy.gracePeriodDays,
            latePenaltyPct: storageFeePolicy.latePenaltyPct,
            currency: storageFeePolicy.currency,
            scope: storageFeePolicy.warehouseId
              ? storageFeePolicy.commodityId
                ? 'warehouse+commodity'
                : 'warehouse'
              : storageFeePolicy.commodityId
              ? 'commodity'
              : 'tenant-default',
          }
        : null,
      descendants: r.childReceipts.map((c) => ({
        id: c.id,
        receiptNumber: c.receiptNumber,
        status: c.status,
        quantity: c.quantity.toString(),
      })),
      timeline: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        quantity: e.quantity.toString(),
        txnType: e.txnType,
        txnId: e.txnId,
        occurredAt: e.occurredAt,
        metadata: e.metadata,
      })),
    };
  }

  async getTransactionDetail(
    tenantId: string,
    txnType: TxnType,
    txnId: string,
  ) {
    const events = await this.prisma.inventoryEvent.findMany({
      where: { tenantId, txnType, txnId },
      orderBy: { occurredAt: 'asc' },
      include: {
        fromReceipt: { select: { id: true, receiptNumber: true, status: true } },
        createdReceipts: {
          select: { id: true, receiptNumber: true, status: true, quantity: true },
        },
      },
    });
    if (events.length === 0) {
      throw new ReceiptNotFoundException(`${txnType}:${txnId}`);
    }

    const created = events.flatMap((e) => e.createdReceipts);
    const held = created.find((c) =>
      (HELD_STATUSES as string[]).includes(c.status),
    );
    const remainder = created.find((c) => c.status === 'ACTIVE');
    const terminal = created.find((c) =>
      ['WITHDRAWN', 'TRADED_OUT', 'SEIZED'].includes(c.status),
    );

    return {
      txnType,
      txnId,
      rootReceiptId: events[0].rootReceiptId,
      actedOn: events[0].fromReceipt,
      created: {
        held: held ?? null,
        remainder: remainder ?? null,
        terminal: terminal ?? null,
      },
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        quantity: e.quantity.toString(),
        occurredAt: e.occurredAt,
        reversalOfEventId: e.reversalOfEventId,
        metadata: e.metadata,
      })),
    };
  }
}
