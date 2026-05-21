import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { TxnType, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryQueryService } from '../inventory/inventory-query.service';
import { statusesForGroup } from '../inventory/inventory.types';
import * as bcrypt from 'bcrypt';

@Injectable()
export class MeService {
  constructor(
    private prisma: PrismaService,
    private query: InventoryQueryService,
  ) {}

  // ── transactions (client-scoped: own deposits/withdrawals/loans/trades) ──

  private async collectMyTransactions(
    tenantId: string,
    userId: string,
    opts: { fromDate?: Date; toDate?: Date } = {},
  ) {
    const { fromDate, toDate } = opts;
    const dateFilter =
      fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {};

    const [deposits, withdrawals, loans, trades] = await Promise.all([
      this.prisma.receipt.findMany({
        where: {
          tenantId,
          clientId: userId,
          parentReceiptId: null,
          ...dateFilter,
        },
        include: { commodity: { select: { name: true, unitOfMeasure: true } } },
      }),
      this.prisma.withdrawal.findMany({
        where: { tenantId, clientId: userId, ...dateFilter },
        include: { receipt: { include: { commodity: true } } },
      }),
      this.prisma.loan.findMany({
        where: { tenantId, clientId: userId, ...dateFilter },
        include: {
          receipt: { include: { commodity: true } },
          financier: { select: { name: true } },
        },
      }),
      this.prisma.trade.findMany({
        where: {
          tenantId,
          OR: [{ sellerId: userId }, { buyerId: userId }],
          ...dateFilter,
        },
        include: { receipt: { include: { commodity: true } } },
      }),
    ]);

    return [
      ...deposits.map((r) => ({
        id: r.id,
        type: 'DEPOSIT' as const,
        reference: r.receiptNumber,
        status: r.status,
        commodity: r.commodity.name,
        unit: r.commodity.unitOfMeasure,
        quantity: Number(r.quantity),
        receiptId: r.id,
        receiptNumber: r.receiptNumber,
        warehouseId: r.warehouseId,
        date: r.createdAt,
      })),
      ...withdrawals.map((w) => ({
        id: w.id,
        type: 'WITHDRAWAL' as const,
        reference: w.reference,
        status: w.status,
        commodity: w.receipt.commodity.name,
        unit: w.receipt.commodity.unitOfMeasure,
        quantity: w.quantity,
        receiptId: w.receiptId,
        receiptNumber: w.receipt.receiptNumber,
        warehouseId: w.receipt.warehouseId,
        date: w.createdAt,
      })),
      ...loans.map((l) => ({
        id: l.id,
        type: 'LOAN' as const,
        reference: l.reference,
        status: l.status,
        commodity: l.receipt.commodity.name,
        unit: l.receipt.commodity.unitOfMeasure,
        quantity: Number(l.receipt.quantity),
        receiptId: l.receiptId,
        receiptNumber: l.receipt.receiptNumber,
        warehouseId: l.receipt.warehouseId,
        counterparty: l.financier.name,
        date: l.createdAt,
      })),
      ...trades.map((t) => ({
        id: t.id,
        type: 'TRADE' as const,
        reference: t.reference,
        status: t.status,
        commodity: t.receipt.commodity.name,
        unit: t.receipt.commodity.unitOfMeasure,
        quantity: t.quantity,
        receiptId: t.receiptId,
        receiptNumber: t.receipt.receiptNumber,
        warehouseId: t.receipt.warehouseId,
        counterparty: t.sellerId === userId ? 'SELL' : 'BUY',
        date: t.createdAt,
      })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  async listTransactions(
    tenantId: string,
    userId: string,
    opts: {
      type?: string;
      from?: string;
      to?: string;
      search?: string;
      page?: string;
      limit?: string;
    },
  ) {
    let items = await this.collectMyTransactions(tenantId, userId, {
      fromDate: opts.from ? new Date(opts.from) : undefined,
      toDate: opts.to ? new Date(opts.to) : undefined,
    });

    const want = (opts.type ?? '').toUpperCase();
    const norm = want === 'PLEDGE' ? 'LOAN' : want;
    if (norm) items = items.filter((i) => i.type === norm);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      items = items.filter(
        (i) =>
          i.reference.toLowerCase().includes(q) ||
          i.commodity.toLowerCase().includes(q),
      );
    }

    const page = Math.max(1, parseInt(opts.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit || '20', 10)));
    const total = items.length;
    return {
      data: items.slice((page - 1) * limit, page * limit),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async getTransactionDetail(
    tenantId: string,
    userId: string,
    type: string,
    id: string,
  ) {
    const t = type.toUpperCase() === 'PLEDGE' ? 'LOAN' : type.toUpperCase();

    if (t === 'DEPOSIT') {
      const r = await this.prisma.receipt.findFirst({
        where: { id, tenantId, clientId: userId },
        select: { id: true },
      });
      if (!r) throw new NotFoundException('Transaction not found');
      return {
        type: 'DEPOSIT',
        ...(await this.query.getReceiptDetail(tenantId, id)),
      };
    }

    if (t === 'WITHDRAWAL') {
      const w = await this.prisma.withdrawal.findFirst({
        where: { id, tenantId, clientId: userId },
        include: {
          receipt: { include: { commodity: true, warehouse: true } },
        },
      });
      if (!w) throw new NotFoundException('Transaction not found');
      return {
        type: 'WITHDRAWAL',
        record: w,
        receiptLineage: await this.query
          .getReceiptDetail(tenantId, w.receiptId)
          .catch(() => null),
        ledgerTrail: await this.query
          .getTransactionDetail(tenantId, TxnType.WITHDRAWAL, w.id)
          .catch(() => null),
      };
    }

    if (t === 'LOAN') {
      const l = await this.prisma.loan.findFirst({
        where: { id, tenantId, clientId: userId },
        include: {
          receipt: { include: { commodity: true, warehouse: true } },
          financier: { select: { id: true, name: true } },
        },
      });
      if (!l) throw new NotFoundException('Transaction not found');
      return {
        type: 'LOAN',
        record: l,
        receiptLineage: await this.query
          .getReceiptDetail(tenantId, l.receiptId)
          .catch(() => null),
        ledgerTrail: await this.query
          .getTransactionDetail(tenantId, TxnType.LOAN, l.id)
          .catch(() => null),
      };
    }

    if (t === 'TRADE') {
      const tr = await this.prisma.trade.findFirst({
        where: {
          id,
          tenantId,
          OR: [{ sellerId: userId }, { buyerId: userId }],
        },
        include: {
          receipt: { include: { commodity: true, warehouse: true } },
          seller: { select: { id: true, firstName: true, lastName: true } },
          buyer: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      if (!tr) throw new NotFoundException('Transaction not found');
      return {
        type: 'TRADE',
        record: tr,
        receiptLineage: await this.query
          .getReceiptDetail(tenantId, tr.receiptId)
          .catch(() => null),
        ledgerTrail: await this.query
          .getTransactionDetail(tenantId, TxnType.TRADE, tr.id)
          .catch(() => null),
      };
    }

    throw new BadRequestException(`Unknown transaction type: ${type}`);
  }

  // ── transaction-report stats (client-scoped) ─────────────────────────────

  async getTransactionStats(tenantId: string, userId: string) {
    const [deposits, withdrawals, loans, trades, dispatches] =
      await Promise.all([
        this.prisma.receipt.count({
          where: { tenantId, clientId: userId, parentReceiptId: null },
        }),
        this.prisma.withdrawal.count({
          where: { tenantId, clientId: userId },
        }),
        this.prisma.loan.count({ where: { tenantId, clientId: userId } }),
        this.prisma.trade.count({
          where: {
            tenantId,
            OR: [{ sellerId: userId }, { buyerId: userId }],
          },
        }),
        this.prisma.withdrawal.count({
          where: {
            tenantId,
            clientId: userId,
            status: WithdrawalStatus.COMPLETED,
          },
        }),
      ]);
    return {
      totalTransactions: deposits + withdrawals + loans + trades,
      withdrawals,
      deposits,
      pledges: loans,
      dispatches,
    };
  }

  /**
   * Client dashboard summary — same shape as the WM/TA dashboards
   * (totalCommodity is a per-unit + per-commodity breakdown, deltas are live),
   * but scoped to the logged-in client's OWN receipts/transactions rather than
   * by warehouse.
   */
  async getDashboard(tenantId: string, userId: string) {
    const twoMo = new Date();
    twoMo.setMonth(twoMo.getMonth() - 2);
    const liened = statusesForGroup('LIENED');
    const pendingW = [
      WithdrawalStatus.PENDING_PAYMENT,
      WithdrawalStatus.PAID_PENDING_APPROVAL,
    ];

    const [
      totalReceipts,
      totalReceiptsDelta,
      activeByCommodity,
      activeByCommodityDelta,
      underLien,
      lienDelta,
      pendingWithdrawal,
      pendingWithdrawalDelta,
      statusActive,
      statusLiened,
      statusCancelled,
      commodities,
      recentDeposits,
      recentWithdrawals,
      recentLoans,
      recentTrades,
    ] = await Promise.all([
      this.prisma.receipt.count({ where: { tenantId, clientId: userId } }),
      this.prisma.receipt.count({
        where: { tenantId, clientId: userId, createdAt: { gte: twoMo } },
      }),
      this.prisma.receipt.groupBy({
        by: ['commodityId'],
        where: { tenantId, clientId: userId, status: 'ACTIVE' },
        _sum: { quantity: true },
      }),
      this.prisma.receipt.groupBy({
        by: ['commodityId'],
        where: {
          tenantId,
          clientId: userId,
          status: 'ACTIVE',
          createdAt: { gte: twoMo },
        },
        _sum: { quantity: true },
      }),
      this.prisma.receipt.count({
        where: { tenantId, clientId: userId, status: { in: liened } },
      }),
      this.prisma.receipt.count({
        where: {
          tenantId,
          clientId: userId,
          status: { in: liened },
          createdAt: { gte: twoMo },
        },
      }),
      this.prisma.withdrawal.count({
        where: { tenantId, clientId: userId, status: { in: pendingW } },
      }),
      this.prisma.withdrawal.count({
        where: {
          tenantId,
          clientId: userId,
          status: { in: pendingW },
          createdAt: { gte: twoMo },
        },
      }),
      this.prisma.receipt.count({
        where: {
          tenantId,
          clientId: userId,
          status: { in: statusesForGroup('ACTIVE') },
        },
      }),
      this.prisma.receipt.count({
        where: { tenantId, clientId: userId, status: { in: liened } },
      }),
      this.prisma.receipt.count({
        where: {
          tenantId,
          clientId: userId,
          status: { in: statusesForGroup('CANCELLED') },
        },
      }),
      this.prisma.commodity.findMany({
        where: { tenantId },
        select: { id: true, name: true, unitOfMeasure: true },
      }),
      this.prisma.receipt.findMany({
        where: { tenantId, clientId: userId, parentReceiptId: null },
        include: { commodity: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      this.prisma.withdrawal.findMany({
        where: { tenantId, clientId: userId },
        include: { receipt: { include: { commodity: true } } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      this.prisma.loan.findMany({
        where: { tenantId, clientId: userId },
        include: { receipt: { include: { commodity: true } } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      this.prisma.trade.findMany({
        where: {
          tenantId,
          OR: [{ sellerId: userId }, { buyerId: userId }],
        },
        include: { receipt: { include: { commodity: true } } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
    ]);

    const [
      activeReceipts,
      activeReceiptsDelta,
      totalPledged,
      totalPledgedDelta,
      sysDeposits,
      sysWithdrawals,
    ] = await Promise.all([
      this.prisma.receipt.count({
        where: {
          tenantId,
          clientId: userId,
          status: 'ACTIVE',
          approvalStatus: 'APPROVED',
          isParent: false,
        },
      }),
      this.prisma.receipt.count({
        where: {
          tenantId,
          clientId: userId,
          status: 'ACTIVE',
          approvalStatus: 'APPROVED',
          isParent: false,
          createdAt: { gte: twoMo },
        },
      }),
      this.prisma.receipt.count({
        where: { tenantId, clientId: userId, status: 'HELD_LOAN' },
      }),
      this.prisma.receipt.count({
        where: {
          tenantId,
          clientId: userId,
          status: 'HELD_LOAN',
          createdAt: { gte: twoMo },
        },
      }),
      this.prisma.receipt.count({
        where: { tenantId, clientId: userId, parentReceiptId: null },
      }),
      this.prisma.withdrawal.count({
        where: { tenantId, clientId: userId },
      }),
    ]);

    const commById = new Map(commodities.map((c) => [c.id, c]));
    const sumByUnit = (
      rows: { commodityId: string; _sum: { quantity: any } }[],
    ) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const c = commById.get(r.commodityId);
        if (!c) continue;
        m.set(
          c.unitOfMeasure,
          (m.get(c.unitOfMeasure) ?? 0) + Number(r._sum.quantity ?? 0),
        );
      }
      return [...m.entries()].map(([unit, quantity]) => ({ unit, quantity }));
    };
    const byCommodity = activeByCommodity.flatMap((g) => {
      const c = commById.get(g.commodityId);
      return c
        ? [
            {
              commodityId: c.id,
              name: c.name,
              unit: c.unitOfMeasure,
              quantity: Number(g._sum.quantity ?? 0),
            },
          ]
        : [];
    });

    const recent = [
      ...recentDeposits.map((r) => ({
        id: r.id,
        type: 'DEPOSIT' as const,
        reference: r.receiptNumber,
        status: r.status,
        commodity: r.commodity.name,
        quantity: Number(r.quantity),
        receiptId: r.id,
        receiptNumber: r.receiptNumber,
        date: r.createdAt,
      })),
      ...recentWithdrawals.map((w) => ({
        id: w.id,
        type: 'WITHDRAWAL' as const,
        reference: w.reference,
        status: w.status,
        commodity: w.receipt.commodity.name,
        quantity: w.quantity,
        receiptId: w.receiptId,
        receiptNumber: w.receipt.receiptNumber,
        date: w.createdAt,
      })),
      ...recentLoans.map((l) => ({
        id: l.id,
        type: 'LOAN' as const,
        reference: l.reference,
        status: l.status,
        commodity: l.receipt.commodity.name,
        quantity: Number(l.receipt.quantity),
        receiptId: l.receiptId,
        receiptNumber: l.receipt.receiptNumber,
        date: l.createdAt,
      })),
      ...recentTrades.map((t) => ({
        id: t.id,
        type: 'TRADE' as const,
        reference: t.reference,
        status: t.status,
        commodity: t.receipt.commodity.name,
        quantity: t.quantity,
        receiptId: t.receiptId,
        receiptNumber: t.receipt.receiptNumber,
        date: t.createdAt,
      })),
    ]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 8);

    return {
      cards: {
        totalReceipts: {
          value: totalReceipts,
          deltaLast2Months: totalReceiptsDelta,
        },
        activeReceipts: {
          value: activeReceipts,
          deltaLast2Months: activeReceiptsDelta,
        },
        totalCommodity: {
          byUnit: sumByUnit(activeByCommodity),
          byCommodity,
          deltaByUnit: sumByUnit(activeByCommodityDelta),
        },
        underLien: { value: underLien, deltaLast2Months: lienDelta },
        totalPledged: {
          value: totalPledged,
          deltaLast2Months: totalPledgedDelta,
        },
        pendingWithdrawal: {
          value: pendingWithdrawal,
          deltaLast2Months: pendingWithdrawalDelta,
        },
        // Currency value is not yet computable (no price source per commodity);
        // returned as 0 so the card renders without inventing a number.
        totalValueNgn: { value: 0, deltaLast2Months: 0, currency: 'NGN' },
      },
      systemStatus: {
        totalDeposits: sysDeposits,
        totalWithdrawals: sysWithdrawals,
      },
      receiptStatusOverview: {
        active: statusActive,
        liened: statusLiened,
        cancelled: statusCancelled,
      },
      storageDistribution: activeByCommodity.flatMap((g) => {
        const c = commById.get(g.commodityId);
        return c
          ? [
              {
                commodity: c.name,
                unit: c.unitOfMeasure,
                quantity: Number(g._sum.quantity ?? 0),
              },
            ]
          : [];
      }),
      recentActivities: recent,
    };
  }

  async getProfile(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        middleName: true,
        phoneNumber: true,
        gender: true,
        dateOfBirth: true,
        residentialAddress: true,
        contactEmail: true,
        profilePhotoUrl: true,
        managerCode: true,
        status: true,
        permissions: true,
        notificationPrefs: true,
        createdAt: true,
        roles: { include: { role: { select: { name: true } } } },
      },
    });
  }

  // ── inventory selection (warehouse → commodity → receipt cascade) ────────

  /** Distinct warehouses where the client holds eligible (ACTIVE+APPROVED) inventory. */
  async getInventoryWarehouses(tenantId: string, userId: string) {
    const groups = await this.prisma.receipt.groupBy({
      by: ['warehouseId'],
      where: {
        tenantId,
        clientId: userId,
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        isParent: false,
      },
      _count: { _all: true },
    });
    if (!groups.length) return [];
    const warehouses = await this.prisma.warehouse.findMany({
      where: { id: { in: groups.map((g) => g.warehouseId) } },
      select: { id: true, name: true, location: true, code: true },
    });
    const countById = new Map(groups.map((g) => [g.warehouseId, g._count._all]));
    return warehouses.map((w) => ({
      ...w,
      eligibleReceiptCount: countById.get(w.id) ?? 0,
    }));
  }

  /** Distinct commodities the client holds (eligible) in the chosen warehouse. */
  async getInventoryCommodities(
    tenantId: string,
    userId: string,
    warehouseId: string,
  ) {
    const groups = await this.prisma.receipt.groupBy({
      by: ['commodityId'],
      where: {
        tenantId,
        clientId: userId,
        warehouseId,
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        isParent: false,
      },
      _sum: { quantity: true },
      _count: { _all: true },
    });
    if (!groups.length) return [];
    const commodities = await this.prisma.commodity.findMany({
      where: { id: { in: groups.map((g) => g.commodityId) } },
      select: { id: true, name: true, unitOfMeasure: true, code: true },
    });
    const byId = new Map(commodities.map((c) => [c.id, c]));
    return groups.flatMap((g) => {
      const c = byId.get(g.commodityId);
      return c
        ? [
            {
              id: c.id,
              name: c.name,
              code: c.code,
              unit: c.unitOfMeasure,
              eligibleQuantity: Number(g._sum.quantity ?? 0),
              eligibleReceiptCount: g._count._all,
            },
          ]
        : [];
    });
  }

  // ── activity trend (powers the 1Y/6M/3M/1M chart) ────────────────────────

  async getActivityTrend(
    tenantId: string,
    userId: string,
    range: '7d' | '1m' | '3m' | '6m' | '1y',
  ) {
    const startDate = new Date();
    switch (range) {
      case '7d': startDate.setDate(startDate.getDate() - 7); break;
      case '1m': startDate.setMonth(startDate.getMonth() - 1); break;
      case '3m': startDate.setMonth(startDate.getMonth() - 3); break;
      case '6m': startDate.setMonth(startDate.getMonth() - 6); break;
      case '1y': default: startDate.setFullYear(startDate.getFullYear() - 1);
    }

    const [deposits, withdrawals, loans, trades] = await Promise.all([
      this.prisma.receipt.findMany({
        where: {
          tenantId,
          clientId: userId,
          parentReceiptId: null,
          createdAt: { gte: startDate },
        },
        select: { createdAt: true },
      }),
      this.prisma.withdrawal.findMany({
        where: { tenantId, clientId: userId, createdAt: { gte: startDate } },
        select: { createdAt: true },
      }),
      this.prisma.loan.findMany({
        where: { tenantId, clientId: userId, createdAt: { gte: startDate } },
        select: { createdAt: true },
      }),
      this.prisma.trade.findMany({
        where: {
          tenantId,
          OR: [{ sellerId: userId }, { buyerId: userId }],
          createdAt: { gte: startDate },
        },
        select: { createdAt: true },
      }),
    ]);

    // Day-level bucket for shorter ranges, month-level for >= 3m.
    const monthlyish = range === '3m' || range === '6m' || range === '1y';
    const key = (d: Date) =>
      monthlyish
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        : d.toISOString().split('T')[0];

    const map = new Map<
      string,
      { bucket: string; deposits: number; withdrawals: number; loans: number; trades: number }
    >();
    const bump = (d: Date, field: 'deposits' | 'withdrawals' | 'loans' | 'trades') => {
      const k = key(d);
      if (!map.has(k))
        map.set(k, { bucket: k, deposits: 0, withdrawals: 0, loans: 0, trades: 0 });
      map.get(k)![field] += 1;
    };
    for (const r of deposits) bump(r.createdAt, 'deposits');
    for (const w of withdrawals) bump(w.createdAt, 'withdrawals');
    for (const l of loans) bump(l.createdAt, 'loans');
    for (const t of trades) bump(t.createdAt, 'trades');

    const series = [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
    const total = series.reduce(
      (n, s) => n + s.deposits + s.withdrawals + s.loans + s.trades,
      0,
    );
    return { range, granularity: monthlyish ? 'month' : 'day', total, series };
  }

  async updateProfile(
    userId: string,
    dto: {
      firstName?: string;
      lastName?: string;
      middleName?: string;
      phoneNumber?: string;
      contactEmail?: string;
      profilePhotoUrl?: string;
    },
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        middleName: true,
        phoneNumber: true,
        contactEmail: true,
        profilePhotoUrl: true,
        updatedAt: true,
      },
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    if (!currentPassword || !newPassword) {
      throw new BadRequestException(
        'currentPassword and newPassword are required',
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    if (newPassword === currentPassword) {
      throw new BadRequestException(
        'New password must be different from the current password',
      );
    }

    // Minimum 8 chars, uppercase, lowercase, digit
    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    if (!strongPassword.test(newPassword)) {
      throw new BadRequestException(
        'New password must be at least 8 characters with at least one uppercase letter, one lowercase letter, and one digit',
      );
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashed },
    });

    return { message: 'Password changed successfully' };
  }

  async updateNotificationPrefs(
    userId: string,
    prefs: { email?: boolean; sms?: boolean; inApp?: boolean },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const current = (user.notificationPrefs as Record<string, boolean>) ?? {};
    const updated = { ...current, ...prefs };

    return this.prisma.user.update({
      where: { id: userId },
      data: { notificationPrefs: updated },
      select: { id: true, notificationPrefs: true },
    });
  }
}
