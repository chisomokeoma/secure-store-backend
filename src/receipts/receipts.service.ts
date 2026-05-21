import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReceiptStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryQueryService } from '../inventory/inventory-query.service';
import {
  statusesForGroup,
  deriveGroup,
  HELD_STATUSES,
} from '../inventory/inventory.types';

// The four UI tabs on the client's Receipt Management page:
// - ALL       → everything except SPLIT internal nodes
// - ACTIVE    → status = ACTIVE
// - LIENED    → PENDING_APPROVAL + HELD_WITHDRAWAL + HELD_LOAN + HELD_TRADE
//               (i.e. a request is in flight against the receipt or it's
//                awaiting tenant-admin approval)
// - CANCELLED → terminal states + closed (WITHDRAWN, TRADED_OUT, SEIZED,
//               EXPIRED, CANCELLED). SPLIT internals never surface here.

@Injectable()
export class ReceiptsService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryQueryService,
  ) {}

  async getReceipts(
    tenantId: string,
    filters: {
      status?: string;
      page?: string;
      limit?: string;
      search?: string;
    },
    forClientId?: string,
  ) {
    const page = parseInt(filters.page || '1', 10);
    const limit = parseInt(filters.limit || '20', 10);
    const skip = (page - 1) * limit;

    const where: Prisma.ReceiptWhereInput = {
      tenantId,
      // SPLIT internal nodes are superseded parents — never user-facing.
      status: { notIn: [ReceiptStatus.SPLIT] },
    };
    if (forClientId) where.clientId = forClientId;

    // Status filter: accepts the four UI tab keys (ACTIVE/LIENED/PLEDGE/CANCELLED)
    // OR a raw ReceiptStatus value for fine-grained filtering.
    const s = (filters.status ?? '').toUpperCase();
    if (s && s !== 'ALL') {
      if (s === 'ACTIVE') where.status = { in: statusesForGroup('ACTIVE') };
      else if (s === 'CANCELLED')
        where.status = { in: statusesForGroup('CANCELLED') };
      else if (s === 'LIENED' || s === 'PLEDGE')
        where.status = { in: statusesForGroup('LIENED') };
      else if ((ReceiptStatus as any)[s])
        where.status = s as ReceiptStatus;
    }

    if (filters.search) {
      where.OR = [
        { receiptNumber: { contains: filters.search, mode: 'insensitive' } },
        {
          commodity: {
            name: { contains: filters.search, mode: 'insensitive' },
          },
        },
      ];
    }

    const [receipts, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        include: {
          commodity: { select: { name: true, unitOfMeasure: true } },
          warehouse: { select: { id: true, name: true, code: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.receipt.count({ where }),
    ]);

    // For LIENED rows the user wants to see WHY they're liened — i.e. the
    // request that's holding them and what state that request is in. One
    // batched lookup per transaction type keeps this off the N+1 path.
    const heldIds = receipts
      .filter((r) => HELD_STATUSES.includes(r.status))
      .map((r) => r.id);
    const requestByReceipt = heldIds.length
      ? await this.loadHeldRequests(tenantId, heldIds)
      : new Map<string, RequestInfo>();

    const data = receipts.map((r) => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      commodityName: r.commodity.name,
      commodityUnit: r.commodity.unitOfMeasure,
      warehouseName: r.warehouse.name,
      warehouseId: r.warehouse.id,
      quantity: Number(r.quantity),
      quantityAvailable: r.status === ReceiptStatus.ACTIVE ? Number(r.quantity) : 0,
      status: r.status,
      approvalStatus: r.approvalStatus,
      group: deriveGroup(r),
      grade: r.grade,
      depositDate: r.dateOfDeposit,
      createdAt: r.createdAt,
      // Only populated when the receipt is HELD_* — tells the FE what
      // request is holding the receipt and its current state.
      request: requestByReceipt.get(r.id) ?? null,
    }));

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Stats endpoint returns the tab badges + the legacy fields the older UI
   * still reads. SPLIT internal nodes are excluded from `total` and every
   * bucket so the four tab badges sum to `total`.
   */
  async getReceiptStats(tenantId: string, forClientId?: string) {
    const cs: Prisma.ReceiptWhereInput = forClientId
      ? { clientId: forClientId }
      : {};
    const notSplit: Prisma.ReceiptWhereInput = {
      status: { notIn: [ReceiptStatus.SPLIT] },
    };

    const [total, active, liened, cancelled, totalPledged, totalWithdrawn] =
      await Promise.all([
        this.prisma.receipt.count({ where: { tenantId, ...notSplit, ...cs } }),
        this.prisma.receipt.count({
          where: {
            tenantId,
            status: { in: statusesForGroup('ACTIVE') },
            ...cs,
          },
        }),
        this.prisma.receipt.count({
          where: {
            tenantId,
            status: { in: statusesForGroup('LIENED') },
            ...cs,
          },
        }),
        this.prisma.receipt.count({
          where: {
            tenantId,
            status: {
              in: statusesForGroup('CANCELLED').filter(
                (s) => s !== ReceiptStatus.SPLIT,
              ),
            },
            ...cs,
          },
        }),
        // legacy fields the existing UI still reads:
        this.prisma.receipt.count({
          where: { tenantId, status: ReceiptStatus.HELD_LOAN, ...cs },
        }),
        this.prisma.receipt.count({
          where: { tenantId, status: ReceiptStatus.WITHDRAWN, ...cs },
        }),
      ]);

    return {
      // New tab counts (the four chips drive off these)
      total,
      byGroup: { active, liened, cancelled },
      // Legacy aliases kept until the FE migrates fully
      totalIssued: total,
      totalActive: active,
      totalPledged,
      totalWithdrawn,
    };
  }

  /**
   * Rich detail for the modal — delegates to InventoryQueryService so the
   * client sees the same provenance / lineage / timeline that the tenant
   * admin sees on the equivalent admin view. Scoping is done HERE (the
   * inventory query is tenant-scoped only) so a client can't fetch
   * someone else's receipt by id.
   */
  async getReceiptDetail(tenantId: string, id: string, forClientId?: string) {
    // Authorisation gate: if the caller is a CLIENT, the receipt must be
    // theirs. Decoupled from the data fetch so a 404 is returned both for
    // "doesn't exist" and "exists but not yours" — no enumeration.
    const ownership = await this.prisma.receipt.findFirst({
      where: {
        id,
        tenantId,
        ...(forClientId ? { clientId: forClientId } : {}),
      },
      select: { id: true },
    });
    if (!ownership) throw new NotFoundException('Receipt not found');

    const detail = await this.inventory.getReceiptDetail(tenantId, id);

    // Attach the active request (if any) so the modal can tell the user
    // exactly what's holding the receipt and what state that request is in.
    const request =
      HELD_STATUSES.includes(detail.status as ReceiptStatus)
        ? (await this.loadHeldRequests(tenantId, [id])).get(id) ?? null
        : null;

    return { ...detail, request };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * For a set of HELD_* receipts, look up the withdrawal/loan/trade currently
   * holding each. One query per type, scoped by tenant. Returns a map keyed
   * by the held receipt id.
   */
  private async loadHeldRequests(
    tenantId: string,
    receiptIds: string[],
  ): Promise<Map<string, RequestInfo>> {
    const [withdrawals, loans, trades] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where: { tenantId, receiptId: { in: receiptIds } },
        select: {
          id: true,
          receiptId: true,
          reference: true,
          status: true,
          quantity: true,
          totalFee: true,
          createdAt: true,
        },
      }),
      this.prisma.loan.findMany({
        where: { tenantId, receiptId: { in: receiptIds } },
        select: {
          id: true,
          receiptId: true,
          reference: true,
          status: true,
          amount: true,
          createdAt: true,
        },
      }),
      this.prisma.trade.findMany({
        where: { tenantId, receiptId: { in: receiptIds } },
        select: {
          id: true,
          receiptId: true,
          reference: true,
          status: true,
          quantity: true,
          totalPrice: true,
          createdAt: true,
        },
      }),
    ]);

    const map = new Map<string, RequestInfo>();
    for (const w of withdrawals) {
      map.set(w.receiptId, {
        kind: 'WITHDRAWAL',
        id: w.id,
        reference: w.reference,
        status: w.status,
        quantity: w.quantity,
        amount: w.totalFee,
        requestedAt: w.createdAt,
      });
    }
    for (const l of loans) {
      map.set(l.receiptId, {
        kind: 'LOAN',
        id: l.id,
        reference: l.reference,
        status: l.status,
        quantity: null,
        amount: l.amount,
        requestedAt: l.createdAt,
      });
    }
    for (const t of trades) {
      map.set(t.receiptId, {
        kind: 'TRADE',
        id: t.id,
        reference: t.reference,
        status: t.status,
        quantity: t.quantity,
        amount: t.totalPrice,
        requestedAt: t.createdAt,
      });
    }
    return map;
  }
}

export interface RequestInfo {
  kind: 'WITHDRAWAL' | 'LOAN' | 'TRADE';
  id: string;
  reference: string;
  status: string;
  quantity: number | null;
  amount: number;
  requestedAt: Date;
}
