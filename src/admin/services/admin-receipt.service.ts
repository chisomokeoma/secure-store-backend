import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryLedgerService } from '../../inventory/inventory-ledger.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { ReceiptStatus, WithdrawalStatus } from '@prisma/client';
import {
  statusesForGroup,
  deriveGroup,
  HELD_STATUSES,
} from '../../inventory/inventory.types';

// A withdrawal is considered "paid" once the client (or admin) has clicked
// `confirm-payment`. The TA's approve button should be enabled at this point
// (or later), not before.
const PAID_STATES: WithdrawalStatus[] = [
  WithdrawalStatus.PAID_PENDING_APPROVAL,
  WithdrawalStatus.APPROVED,
  WithdrawalStatus.COMPLETED,
];

export interface ReceiptRequestInfo {
  kind: 'WITHDRAWAL' | 'LOAN' | 'TRADE';
  id: string;
  reference: string;
  status: string;
  quantity: number | null;
  amount: number;
  requestedAt: Date;
  // Withdrawal-only flag derived from status — true once the client has
  // confirmed payment. Drives the FE's "Approve withdrawal" button state.
  paymentConfirmed?: boolean;
}

@Injectable()
export class AdminReceiptService {
  constructor(
    private prisma: PrismaService,
    private ledger: InventoryLedgerService,
    private notifications: NotificationsService,
  ) {}

  /** Active storage-fee policy with fallback chain; null if none configured. */
  private async resolvePolicy(
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

  /**
   * For a set of HELD_* receipts, look up the withdrawal/loan/trade currently
   * holding each. One indexed query per type, scoped by tenant. Returns a
   * map keyed by held-receipt id; receipts without a matching request fall
   * through with `null` on the response.
   */
  private async loadHeldRequests(
    tenantId: string,
    receiptIds: string[],
  ): Promise<Map<string, ReceiptRequestInfo>> {
    if (!receiptIds.length) return new Map();
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

    const map = new Map<string, ReceiptRequestInfo>();
    for (const w of withdrawals) {
      map.set(w.receiptId, {
        kind: 'WITHDRAWAL',
        id: w.id,
        reference: w.reference,
        status: w.status,
        quantity: w.quantity,
        amount: w.totalFee,
        requestedAt: w.createdAt,
        paymentConfirmed: PAID_STATES.includes(w.status),
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

  /** Project a Receipt row + sourceEvent.actor + resolved policy into the shape the UI consumes. */
  private async enrich(tenantId: string, r: any) {
    const policy = await this.resolvePolicy(
      tenantId,
      r.warehouseId,
      r.commodityId,
    );
    return {
      ...r,
      manager: r.sourceEvent?.actor
        ? {
            id: r.sourceEvent.actor.id,
            name: `${r.sourceEvent.actor.firstName} ${r.sourceEvent.actor.lastName}`,
            managerCode: r.sourceEvent.actor.managerCode,
          }
        : null,
      storageFeePolicy: policy
        ? {
            id: policy.id,
            feeType: policy.feeType,
            rate: policy.rate,
            billingFrequency: policy.billingFrequency,
            gracePeriodDays: policy.gracePeriodDays,
            latePenaltyPct: policy.latePenaltyPct,
            currency: policy.currency,
            scope: policy.warehouseId
              ? policy.commodityId
                ? 'warehouse+commodity'
                : 'warehouse'
              : policy.commodityId
              ? 'commodity'
              : 'tenant-default',
          }
        : null,
    };
  }

  // ─── LIST (full filters per spec §3.4) ────────────────────────────────────

  async getReceipts(
    tenantId: string,
    query: {
      status?: string;
      warehouseId?: string;
      approvalStatus?: string;
      clientId?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const skip = (page - 1) * limit;

    // Default: hide SPLIT internal nodes — they're superseded parents, not
    // user-facing receipts. Status filter accepts either the group contract
    // ('ACTIVE'|'LIENED'|'PLEDGE'|'CANCELLED') or a raw ReceiptStatus value.
    const where: any = {
      tenantId,
      status: { notIn: [ReceiptStatus.SPLIT] },
    };
    const s = (query.status ?? '').toUpperCase();
    if (s === 'ACTIVE')
      where.status = { in: statusesForGroup('ACTIVE') };
    else if (s === 'CANCELLED')
      where.status = { in: statusesForGroup('CANCELLED') };
    else if (s === 'LIENED' || s === 'PLEDGE')
      where.status = { in: statusesForGroup('LIENED') };
    else if (s && (ReceiptStatus as any)[s])
      where.status = s as ReceiptStatus;
    if (query.approvalStatus) where.approvalStatus = query.approvalStatus;
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.clientId) where.clientId = query.clientId;

    const [receipts, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          commodity: { select: { id: true, name: true, unitOfMeasure: true } },
          warehouse: { select: { id: true, name: true, code: true } },
          client: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          approvedBy: { select: { id: true, firstName: true, lastName: true } },
          sourceEvent: {
            include: {
              actor: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  managerCode: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.receipt.count({ where }),
    ]);

    // Batch-load the request holding each HELD_* receipt so the FE can
    // route the Approve action to the right endpoint (withdrawals/loans)
    // and gate it on `paymentConfirmed` for withdrawals.
    const heldIds = receipts
      .filter((r) => HELD_STATUSES.includes(r.status))
      .map((r) => r.id);
    const requestByReceipt = await this.loadHeldRequests(tenantId, heldIds);

    const data = await Promise.all(
      receipts.map(async (r) => ({
        ...(await this.enrich(tenantId, r)),
        group: deriveGroup(r),
        request: requestByReceipt.get(r.id) ?? null,
      })),
    );
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── DETAIL ────────────────────────────────────────────────────────────────

  async getReceiptById(tenantId: string, receiptId: string) {
    const receipt = await this.prisma.receipt.findFirst({
      where: { id: receiptId, tenantId },
      include: {
        commodity: true,
        warehouse: true,
        client: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        approvedBy: { select: { id: true, firstName: true, lastName: true } },
        withdrawals: true,
        loans: true,
        sourceEvent: {
          include: {
            actor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                managerCode: true,
              },
            },
          },
        },
      },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    const enriched = await this.enrich(tenantId, receipt);
    const request = HELD_STATUSES.includes(receipt.status)
      ? (await this.loadHeldRequests(tenantId, [receipt.id])).get(receipt.id) ??
        null
      : null;
    return { ...enriched, group: deriveGroup(receipt), request };
  }

  // ─── PENDING APPROVALS ─────────────────────────────────────────────────────

  async getPendingApprovals(tenantId: string) {
    const receipts = await this.prisma.receipt.findMany({
      where: { tenantId, approvalStatus: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        commodity: { select: { id: true, name: true, unitOfMeasure: true } },
        warehouse: { select: { id: true, name: true, code: true } },
        client: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        sourceEvent: {
          include: {
            actor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                managerCode: true,
              },
            },
          },
        },
      },
    });
    const heldIds = receipts
      .filter((r) => HELD_STATUSES.includes(r.status))
      .map((r) => r.id);
    const requestByReceipt = await this.loadHeldRequests(tenantId, heldIds);
    return Promise.all(
      receipts.map(async (r) => ({
        ...(await this.enrich(tenantId, r)),
        group: deriveGroup(r),
        request: requestByReceipt.get(r.id) ?? null,
      })),
    );
  }

  // ─── APPROVE ───────────────────────────────────────────────────────────────

  async approveReceipt(
    tenantId: string,
    receiptId: string,
    adminId: string,
    _dto: { notes?: string },
  ) {
    // Goes through the ledger so the APPROVED event is recorded and the tree
    // node transitions PENDING_APPROVAL → ACTIVE consistently.
    const result = await this.ledger.approveReceipt({
      tenantId,
      receiptId,
      actorUserId: adminId,
      idempotencyKey: `RECEIPT:${receiptId}:approve`,
    });

    const ctx = await this.prisma.receipt.findUnique({
      where: { id: receiptId },
      select: {
        receiptNumber: true,
        warehouseId: true,
        quantity: true,
        clientId: true,
        commodity: { select: { name: true, unitOfMeasure: true } },
        sourceEvent: { select: { actorUserId: true } },
      },
    });
    if (ctx) {
      const summary = `${ctx.receiptNumber}: ${Number(ctx.quantity)} ${ctx.commodity.unitOfMeasure} of ${ctx.commodity.name}`;
      // Client: their deposit is now live.
      void this.notifications.notifyUser(ctx.clientId, {
        tenantId,
        type: 'DEPOSIT_APPROVED',
        title: 'Deposit approved',
        body: `${summary} — your receipt is now active.`,
        relatedEntityType: 'receipt',
        relatedEntityId: receiptId,
      });
      // Filing manager: their submission cleared.
      if (ctx.sourceEvent?.actorUserId) {
        void this.notifications.notifyUser(ctx.sourceEvent.actorUserId, {
          tenantId,
          type: 'DEPOSIT_APPROVED',
          title: 'Deposit you filed was approved',
          body: summary,
          relatedEntityType: 'receipt',
          relatedEntityId: receiptId,
        });
      }
    }

    return result;
  }

  // ─── REJECT ────────────────────────────────────────────────────────────────

  async rejectReceipt(
    tenantId: string,
    receiptId: string,
    adminId: string,
    rejectionReason: string,
  ) {
    if (!rejectionReason?.trim()) {
      throw new BadRequestException('rejectionReason is required');
    }
    const result = await this.ledger.rejectReceipt({
      tenantId,
      receiptId,
      actorUserId: adminId,
      reason: rejectionReason,
      idempotencyKey: `RECEIPT:${receiptId}:reject`,
    });

    const ctx = await this.prisma.receipt.findUnique({
      where: { id: receiptId },
      select: {
        receiptNumber: true,
        clientId: true,
        commodity: { select: { name: true } },
        sourceEvent: { select: { actorUserId: true } },
      },
    });
    if (ctx) {
      const body = `${ctx.receiptNumber} (${ctx.commodity.name}) was rejected. Reason: ${rejectionReason}`;
      void this.notifications.notifyUser(ctx.clientId, {
        tenantId,
        type: 'DEPOSIT_REJECTED',
        title: 'Deposit rejected',
        body,
        relatedEntityType: 'receipt',
        relatedEntityId: receiptId,
        data: { reason: rejectionReason },
      });
      if (ctx.sourceEvent?.actorUserId) {
        void this.notifications.notifyUser(ctx.sourceEvent.actorUserId, {
          tenantId,
          type: 'DEPOSIT_REJECTED',
          title: 'Deposit you filed was rejected',
          body,
          relatedEntityType: 'receipt',
          relatedEntityId: receiptId,
          data: { reason: rejectionReason },
        });
      }
    }

    return result;
  }
}
