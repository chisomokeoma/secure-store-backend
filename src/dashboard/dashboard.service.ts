import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WarehouseManagerService } from '../warehouse-manager/warehouse-manager.service';
import {
  ReceiptStatus,
  WithdrawalStatus,
  LoanStatus,
  TradeStatus,
} from '@prisma/client';
import { ActivityType, RecentActivityDto } from './dto/dashboard.dto';

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private wm: WarehouseManagerService,
  ) {}

  /**
   * Tenant-admin dashboard summary. Delegates to the WM dashboard so admins
   * and managers share a single source of truth for the cards / overview /
   * distribution. Admins (whScope = null) get the full tenant view; managers
   * get their warehouse-scoped view.
   */
  async getSummary(tenantId: string) {
    return this.wm.getDashboard(tenantId);
  }

  // The original tenant-admin summary impl, kept under a different name in
  // case anything still depends on its exact shape during integration.
  private async _legacyGetSummary(tenantId: string) {
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    const [
      warehouses,
      warehousesDelta,
      clients,
      clientsDelta,
      commodityResult,
      commodityDeltaResult,
      pendingRequests,
      pendingRequestsDelta,
    ] = await Promise.all([
      // --- Totals ---
      this.prisma.warehouse.count({ where: { tenantId } }),
      this.prisma.warehouse.count({
        where: { tenantId, createdAt: { gte: twoMonthsAgo } },
      }),
      this.prisma.user.count({
        where: {
          tenantId,
          roles: { some: { role: { name: 'CLIENT' } } },
        },
      }),
      this.prisma.user.count({
        where: {
          tenantId,
          roles: { some: { role: { name: 'CLIENT' } } },
          createdAt: { gte: twoMonthsAgo },
        },
      }),
      this.prisma.receipt.aggregate({
        where: { tenantId, status: { in: ['ACTIVE', 'HELD_LOAN', 'HELD_TRADE'] } },
        _sum: { quantity: true },
      }),
      // --- Deltas ---
      this.prisma.receipt.aggregate({
        where: {
          tenantId,
          status: { in: ['ACTIVE', 'HELD_LOAN', 'HELD_TRADE'] },
          createdAt: { gte: twoMonthsAgo },
        },
        _sum: { quantity: true },
      }),
      this.prisma.withdrawal.count({
        where: { tenantId, status: WithdrawalStatus.PAID_PENDING_APPROVAL },
      }),
      this.prisma.withdrawal.count({
        where: {
          tenantId,
          status: WithdrawalStatus.PAID_PENDING_APPROVAL,
          createdAt: { gte: twoMonthsAgo },
        },
      }),
    ]);

    return {
      totalWarehouses: warehouses,
      warehousesDelta,
      totalClients: clients,
      clientsDelta,
      totalCommodity: commodityResult._sum?.quantity ?? 0,
      commodityDelta: commodityDeltaResult._sum?.quantity ?? 0,
      pendingRequests,
      pendingRequestsDelta,
    };
  }

  /**
   * Commodity breakdown for the dashboard chart.
   *
   * Scoping: when `forClientId` is set (caller is acting as CLIENT), the
   * breakdown reflects ONLY that client's holdings. Otherwise (admin / WM /
   * unscoped), the breakdown is tenant-wide. This is the load-bearing fix
   * for the leak where a new client like Prosper Jaja was seeing other
   * clients' Maize/Rice totals on his empty dashboard.
   *
   * In-warehouse set: ACTIVE + every HELD_* status (including
   * HELD_WITHDRAWAL, which the old impl was missing — a withdrawal in
   * flight is still inventory the warehouse is holding, just earmarked).
   */
  async getCommodityBreakdown(tenantId: string, forClientId?: string) {
    const breakdown = await this.prisma.receipt.groupBy({
      by: ['commodityId'],
      where: {
        tenantId,
        ...(forClientId ? { clientId: forClientId } : {}),
        status: {
          in: [
            'ACTIVE',
            'HELD_WITHDRAWAL',
            'HELD_LOAN',
            'HELD_TRADE',
          ],
        },
      },
      _sum: { quantity: true },
    });

    const commodities = await this.prisma.commodity.findMany({
      where: { id: { in: breakdown.map((b) => b.commodityId) } },
    });

    return breakdown.map((b) => ({
      name: commodities.find((c) => c.id === b.commodityId)?.name || 'Unknown',
      quantity: b._sum?.quantity ?? 0,
    }));
  }

  /**
   * Activity trend chart. Same scoping rule as commodity-breakdown:
   *   CLIENT  → only their own deposits + withdrawals
   *   admin / WM / unscoped → tenant-wide
   *
   * Deposit data filters to root receipts (parentReceiptId: null) so SPLIT
   * internal nodes don't double-count — a withdrawal that splits the parent
   * mints a child receipt, and counting that child as a "deposit" would
   * inflate the trend.
   */
  async getActivityTrend(
    tenantId: string,
    range: '7d' | '1m' | '6m' | '1y',
    forClientId?: string,
  ) {
    const now = new Date();
    const startDate = new Date();
    switch (range) {
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '1m':
        startDate.setMonth(now.getMonth() - 1);
        break;
      case '6m':
        startDate.setMonth(now.getMonth() - 6);
        break;
      case '1y':
        startDate.setFullYear(now.getFullYear() - 1);
        break;
    }

    const [receipts, withdrawals] = await Promise.all([
      this.prisma.receipt.findMany({
        where: {
          tenantId,
          ...(forClientId ? { clientId: forClientId } : {}),
          parentReceiptId: null,
          createdAt: { gte: startDate },
        },
        select: { createdAt: true, quantity: true },
      }),
      this.prisma.withdrawal.findMany({
        where: {
          tenantId,
          ...(forClientId ? { clientId: forClientId } : {}),
          createdAt: { gte: startDate },
        },
        select: { createdAt: true, quantity: true },
      }),
    ]);

    // Simple day-based aggregation
    const dataMap = new Map<
      string,
      { deposits: number; withdrawals: number }
    >();

    receipts.forEach((r) => {
      const date = r.createdAt.toISOString().split('T')[0];
      const entry = dataMap.get(date) || { deposits: 0, withdrawals: 0 };
      entry.deposits += Number(r.quantity);
      dataMap.set(date, entry);
    });

    withdrawals.forEach((w) => {
      const date = w.createdAt.toISOString().split('T')[0];
      const entry = dataMap.get(date) || { deposits: 0, withdrawals: 0 };
      entry.withdrawals += w.quantity;
      dataMap.set(date, entry);
    });

    return Array.from(dataMap.entries())
      .map(([date, counts]) => ({
        date,
        ...counts,
        activityCount: counts.deposits + counts.withdrawals,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Recent activities feed. Same scoping: CLIENT sees only their own;
   * everyone else sees tenant-wide. Trades match on either sellerId OR
   * buyerId so a client sees trades they're a party to in either role.
   * Receipts filter to root deposits so SPLIT internal nodes don't show
   * up as fresh activity to the user.
   */
  async getRecentActivities(
    tenantId: string,
    forClientId?: string,
  ): Promise<RecentActivityDto[]> {
    const [receipts, withdrawals, loans, trades] = await Promise.all([
      this.prisma.receipt.findMany({
        where: {
          tenantId,
          ...(forClientId ? { clientId: forClientId } : {}),
          parentReceiptId: null,
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { commodity: true },
      }),
      this.prisma.withdrawal.findMany({
        where: {
          tenantId,
          ...(forClientId ? { clientId: forClientId } : {}),
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { receipt: { include: { commodity: true } } },
      }),
      this.prisma.loan.findMany({
        where: {
          tenantId,
          ...(forClientId ? { clientId: forClientId } : {}),
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.trade.findMany({
        where: {
          tenantId,
          // Trades have two parties — sellerId and buyerId. A client sees
          // trades they're either side of.
          ...(forClientId
            ? { OR: [{ sellerId: forClientId }, { buyerId: forClientId }] }
            : {}),
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { receipt: { include: { commodity: true } } },
      }),
    ]);

    const activities: RecentActivityDto[] = [];

    receipts.forEach((r) =>
      activities.push({
        id: r.id,
        type: ActivityType.DEPOSIT,
        title: 'New Deposit',
        description: `New deposit: ${r.quantity} ${r.commodity.name}`,
        timestamp: r.createdAt,
        status: r.status,
        reference: r.receiptNumber,
      }),
    );

    withdrawals.forEach((w) =>
      activities.push({
        id: w.id,
        type: ActivityType.WITHDRAWAL,
        title: 'Withdrawal Request',
        description: `Withdrawal of ${w.quantity} ${w.receipt.commodity.name} requested`,
        timestamp: w.createdAt,
        status: w.status,
        reference: w.reference,
      }),
    );

    loans.forEach((l) =>
      activities.push({
        id: l.id,
        type: ActivityType.LOAN,
        title: 'Loan Approved',
        description: `Loan of ${l.amount} ${l.currency} approved`,
        timestamp: l.createdAt,
        status: l.status,
        reference: l.reference,
      }),
    );

    trades.forEach((t) =>
      activities.push({
        id: t.id,
        type: ActivityType.TRADE,
        title: 'Trade Settled',
        description: `Trade for ${t.quantity} ${t.receipt.commodity.name} completed`,
        timestamp: t.createdAt,
        status: t.status,
        reference: t.reference,
      }),
    );

    return activities
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 10);
  }

  // --- Phase 3.2: Drill-downs ---

  async getClientDrilldown(tenantId: string, clientId: string) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, tenantId },
    });
    if (!client) throw new NotFoundException('Client not found');

    const [stock, loans, activities] = await Promise.all([
      this.prisma.receipt.aggregate({
        where: {
          tenantId,
          clientId,
          status: { in: ['ACTIVE', 'HELD_LOAN', 'HELD_TRADE'] },
        },
        _sum: { quantity: true },
      }),
      this.prisma.loan.findMany({
        where: { tenantId, clientId, status: LoanStatus.ACTIVE },
      }),
      this.prisma.receipt.findMany({
        where: { tenantId, clientId },
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { commodity: true },
      }),
    ]);

    return {
      client: {
        id: client.id,
        name: `${client.firstName} ${client.lastName}`,
        email: client.email,
      },
      summary: {
        totalStock: stock._sum?.quantity ?? 0,
        activeLoansCount: loans.length,
        totalLoanAmount: loans.reduce((sum, l) => sum + l.amount, 0),
      },
      recentReceipts: activities.map((r) => ({
        id: r.id,
        number: r.receiptNumber,
        commodity: r.commodity.name,
        quantity: r.quantity,
        status: r.status,
        date: r.createdAt,
      })),
    };
  }

  async getCommodityDrilldown(tenantId: string, commodityId: string) {
    const commodity = await this.prisma.commodity.findFirst({
      where: { id: commodityId, tenantId },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');

    const [stockByWarehouse, stockByGrade] = await Promise.all([
      this.prisma.receipt.groupBy({
        by: ['warehouseId'],
        where: {
          tenantId,
          commodityId,
          status: { in: ['ACTIVE', 'HELD_LOAN', 'HELD_TRADE'] },
        },
        _sum: { quantity: true },
      }),
      this.prisma.receipt.groupBy({
        by: ['grade'],
        where: {
          tenantId,
          commodityId,
          status: { in: ['ACTIVE', 'HELD_LOAN', 'HELD_TRADE'] },
        },
        _sum: { quantity: true },
      }),
    ]);

    const warehouses = await this.prisma.warehouse.findMany({
      where: { id: { in: stockByWarehouse.map((s) => s.warehouseId) } },
    });

    return {
      commodity: {
        id: commodity.id,
        name: commodity.name,
        unit: commodity.unitOfMeasure,
      },
      distributionByWarehouse: stockByWarehouse.map((s) => ({
        warehouse:
          warehouses.find((w) => w.id === s.warehouseId)?.name || 'Unknown',
        quantity: s._sum?.quantity ?? 0,
      })),
      distributionByGrade: stockByGrade.map((s) => ({
        grade: s.grade || 'Ungraded',
        quantity: s._sum?.quantity ?? 0,
      })),
    };
  }
}
