import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CommodityPricesService } from '../commodity-prices/commodity-prices.service';
import {
  FinancierOrgStatus,
  LienStatus,
  Prisma,
  TenantStatus,
} from '@prisma/client';
import { sumInMt } from '../common/unit-conversion';

/**
 * Global Admin platform-wide aggregations. Powers three FE surfaces:
 *   • Dashboard KPI tiles + activity area chart + stored-value ranking
 *   • Network warehouses table (cross-tenant)
 *   • System activity feed
 *
 * Every method here reads across ALL tenants — no per-tenant scoping.
 * The controller gates this behind @Roles('GLOBAL_ADMIN') so only the
 * platform operator can call it.
 */
@Injectable()
export class AdminOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commodityPrices: CommodityPricesService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // KPI TILES — GET /admin/overview
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Six blocks the FE renders as tiles + summary strip. All counts are
  // platform-wide. `people.clients` is DISTINCT users with the CLIENT
  // role (a person, not a client↔warehouse attachment) — a client with
  // receipts at three warehouses is still one head.

  async getOverview() {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [
      tenantsTotal,
      tenantsActive,
      tenantsSuspended,
      financiersTotal,
      financiersActive,
      financiersSuspended,
      warehousesTotal,
      warehousesActive,
      managerCount,
      clientCount,
      activeLiens,
      activeReceipts,
      lienedReceipts,
      receiptsThisMonth,
    ] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { status: TenantStatus.ACTIVE } }),
      this.prisma.tenant.count({ where: { status: TenantStatus.SUSPENDED } }),
      this.prisma.financierOrg.count(),
      this.prisma.financierOrg.count({
        where: { status: FinancierOrgStatus.ACTIVE },
      }),
      this.prisma.financierOrg.count({
        where: { status: FinancierOrgStatus.SUSPENDED },
      }),
      this.prisma.warehouse.count(),
      this.prisma.warehouse.count({ where: { status: 'ACTIVE' } }),
      this.prisma.user.count({
        where: {
          roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } },
        },
      }),
      // DISTINCT client users platform-wide.
      this.prisma.user.count({
        where: {
          roles: { some: { role: { name: 'CLIENT' } } },
        },
      }),
      // Aggregation for totalLienedValue + activeLiens count in one query.
      this.prisma.lien.findMany({
        where: {
          status: {
            in: [LienStatus.ACTIVE, LienStatus.PARTIALLY_RELEASED],
          },
        },
        select: {
          remainingQuantity: true,
          receipt: {
            select: { tenantId: true, commodityId: true },
          },
        },
      }),
      this.prisma.receipt.count({
        where: {
          status: {
            in: ['ACTIVE', 'HELD_WITHDRAWAL', 'HELD_LOAN', 'HELD_TRADE', 'HELD_PLEDGE_PENDING', 'HELD_LIEN'],
          },
        },
      }),
      this.prisma.receipt.count({
        where: { status: { in: ['HELD_LIEN'] } },
      }),
      this.prisma.receipt.count({
        where: {
          parentReceiptId: null,
          createdAt: { gte: monthStart },
        },
      }),
    ]);

    // Value liens at current market prices, keyed by (tenantId, commodityId)
    // — a financier is cross-tenant so the same commodity in tenant A vs
    // tenant B may be priced differently.
    const uniquePairs = new Set<string>();
    for (const l of activeLiens) {
      uniquePairs.add(`${l.receipt.tenantId}::${l.receipt.commodityId}`);
    }
    const priceMap = new Map<
      string,
      { pricePerUnit: Prisma.Decimal; currency: string }
    >();
    for (const key of uniquePairs) {
      const [tenantId, commodityId] = key.split('::');
      const p = await this.commodityPrices.currentPrice(tenantId, commodityId);
      if (p) {
        priceMap.set(key, {
          pricePerUnit: p.pricePerUnit,
          currency: p.currency,
        });
      }
    }
    let totalLienedValue = new Prisma.Decimal(0);
    let currency = 'NGN';
    for (const l of activeLiens) {
      const key = `${l.receipt.tenantId}::${l.receipt.commodityId}`;
      const p = priceMap.get(key);
      if (!p) continue;
      totalLienedValue = totalLienedValue.add(
        p.pricePerUnit.mul(l.remainingQuantity),
      );
      currency = p.currency;
    }

    return {
      tenants: {
        total: tenantsTotal,
        active: tenantsActive,
        suspended: tenantsSuspended,
      },
      financiers: {
        total: financiersTotal,
        active: financiersActive,
        suspended: financiersSuspended,
      },
      warehouses: { total: warehousesTotal, active: warehousesActive },
      people: { managers: managerCount, clients: clientCount },
      collateral: {
        totalLienedValue: totalLienedValue.toFixed(2),
        currency,
        activeLiens: activeLiens.length,
      },
      receipts: {
        active: activeReceipts,
        liened: lienedReceipts,
        issuedThisMonth: receiptsThisMonth,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TREND — GET /admin/overview/trend?days=7|30|90
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Zero-filled daily series on ONE shared axis. The FE never uses a
  // second y-scale, so all three counts (receipts, pledges, liens) come
  // out on the same order-of-magnitude assumption. That's fine here —
  // on a platform-wide series they'll be roughly comparable.

  async getTrend(days = 30) {
    if (![7, 30, 90].includes(days)) {
      throw new BadRequestException('days must be 7, 30, or 90');
    }
    const now = new Date();
    // Anchor to UTC-midnight of "today" so the day boundaries in the DB
    // (also UTC-based on our timestamps) line up. Otherwise different
    // server timezones would smear points across days.
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const rangeStart = new Date(
      todayStart.getTime() - (days - 1) * 86_400_000,
    );

    const [receipts, pledges, liens] = await Promise.all([
      this.prisma.receipt.findMany({
        where: {
          parentReceiptId: null,
          createdAt: { gte: rangeStart },
        },
        select: { createdAt: true },
      }),
      this.prisma.pledge.findMany({
        where: { createdAt: { gte: rangeStart } },
        select: { createdAt: true },
      }),
      this.prisma.lien.findMany({
        where: { placedAt: { gte: rangeStart } },
        select: { placedAt: true },
      }),
    ]);

    // Zero-fill the whole window, then bump each bucket.
    const dayKey = (d: Date) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const buckets = new Map<
      string,
      { date: string; receiptsIssued: number; pledgesCreated: number; liensPlaced: number }
    >();
    for (let i = 0; i < days; i++) {
      const d = new Date(rangeStart.getTime() + i * 86_400_000);
      const key = dayKey(d);
      buckets.set(key, {
        date: key,
        receiptsIssued: 0,
        pledgesCreated: 0,
        liensPlaced: 0,
      });
    }
    for (const r of receipts) {
      const b = buckets.get(dayKey(r.createdAt));
      if (b) b.receiptsIssued++;
    }
    for (const p of pledges) {
      const b = buckets.get(dayKey(p.createdAt));
      if (b) b.pledgesCreated++;
    }
    for (const l of liens) {
      const b = buckets.get(dayKey(l.placedAt));
      if (b) b.liensPlaced++;
    }

    return [...buckets.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DISTRIBUTION — GET /admin/overview/distribution
  // ═══════════════════════════════════════════════════════════════════════
  //
  // One row per tenant with stored + liened value in NGN. FE sorts and
  // renders the top 6 as a horizontal ranking chart.

  async getDistribution() {
    const tenants = await this.prisma.tenant.findMany({
      select: { id: true, name: true },
    });
    const items = await Promise.all(
      tenants.map(async (t) => {
        const [warehouses, clientAgg, storedAgg, liens] = await Promise.all([
          this.prisma.warehouse.count({ where: { tenantId: t.id } }),
          this.prisma.user.count({
            where: {
              tenantId: t.id,
              roles: { some: { role: { name: 'CLIENT' } } },
            },
          }),
          this.prisma.receipt.groupBy({
            by: ['commodityId'],
            where: {
              tenantId: t.id,
              status: {
                notIn: ['SPLIT', 'WITHDRAWN', 'TRADED_OUT', 'SEIZED', 'EXPIRED', 'CANCELLED'],
              },
            },
            _sum: { quantity: true },
          }),
          this.prisma.lien.findMany({
            where: {
              tenantId: t.id,
              status: { in: [LienStatus.ACTIVE, LienStatus.PARTIALLY_RELEASED] },
            },
            select: {
              remainingQuantity: true,
              receipt: { select: { commodityId: true } },
            },
          }),
        ]);

        // Price lookup for this tenant.
        const cids = new Set<string>();
        for (const g of storedAgg) cids.add(g.commodityId);
        for (const l of liens) cids.add(l.receipt.commodityId);
        const prices = new Map<string, Prisma.Decimal>();
        for (const cid of cids) {
          const p = await this.commodityPrices.currentPrice(t.id, cid);
          if (p) prices.set(cid, p.pricePerUnit);
        }

        let storedValue = new Prisma.Decimal(0);
        for (const g of storedAgg) {
          const price = prices.get(g.commodityId);
          if (!price) continue;
          storedValue = storedValue.add(
            price.mul(g._sum.quantity ?? 0),
          );
        }
        let lienedValue = new Prisma.Decimal(0);
        for (const l of liens) {
          const price = prices.get(l.receipt.commodityId);
          if (!price) continue;
          lienedValue = lienedValue.add(price.mul(l.remainingQuantity));
        }

        return {
          tenantId: t.id,
          name: t.name,
          warehouses,
          clients: clientAgg,
          storedValue: storedValue.toFixed(2),
          lienedValue: lienedValue.toFixed(2),
        };
      }),
    );
    return items;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // NETWORK WAREHOUSES — GET /admin/network/warehouses
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Cross-tenant warehouse listing. Search matches warehouse name / code /
  // location AND tenant name. Same per-warehouse rollups as the tenant-
  // scoped list, plus tenantId + tenantName + stored/liened values.

  async listNetworkWarehouses(query: {
    search?: string;
    tenantId?: string;
    page?: string;
    limit?: string;
  }) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const where: any = {};
    if (query.tenantId) where.tenantId = query.tenantId;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
        { location: { contains: query.search, mode: 'insensitive' } },
        { tenant: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.warehouse.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { tenant: { select: { id: true, name: true } } },
      }),
      this.prisma.warehouse.count({ where }),
    ]);

    // Row-level rollups — same pattern as tenant-scoped listing.
    const items = await Promise.all(
      rows.map(async (w) => {
        const [managerCount, clientAgg, activeReceipts, stockAgg, liens] =
          await Promise.all([
            this.prisma.warehouseManagerAssignment.count({
              where: { warehouseId: w.id, unassignedAt: null },
            }),
            this.prisma.receipt.groupBy({
              by: ['clientId'],
              where: {
                warehouseId: w.id,
                status: { notIn: ['SPLIT', 'WITHDRAWN', 'TRADED_OUT', 'SEIZED', 'EXPIRED', 'CANCELLED'] },
              },
            }),
            this.prisma.receipt.count({
              where: {
                warehouseId: w.id,
                status: {
                  in: ['ACTIVE', 'HELD_WITHDRAWAL', 'HELD_LOAN', 'HELD_TRADE', 'HELD_PLEDGE_PENDING', 'HELD_LIEN'],
                },
              },
            }),
            this.prisma.receipt.groupBy({
              by: ['commodityId'],
              where: {
                warehouseId: w.id,
                status: {
                  in: ['ACTIVE', 'HELD_WITHDRAWAL', 'HELD_LOAN', 'HELD_TRADE', 'HELD_PLEDGE_PENDING', 'HELD_LIEN'],
                },
              },
              _sum: { quantity: true },
            }),
            this.prisma.lien.findMany({
              where: {
                receipt: { warehouseId: w.id },
                status: { in: [LienStatus.ACTIVE, LienStatus.PARTIALLY_RELEASED] },
              },
              select: {
                remainingQuantity: true,
                receipt: { select: { commodityId: true } },
              },
            }),
          ]);

        // Price lookup for this warehouse's tenant.
        const cids = new Set<string>();
        for (const g of stockAgg) cids.add(g.commodityId);
        for (const l of liens) cids.add(l.receipt.commodityId);
        const prices = new Map<string, Prisma.Decimal>();
        for (const cid of cids) {
          const p = await this.commodityPrices.currentPrice(w.tenantId, cid);
          if (p) prices.set(cid, p.pricePerUnit);
        }

        let storedValue = new Prisma.Decimal(0);
        for (const g of stockAgg) {
          const price = prices.get(g.commodityId);
          if (!price) continue;
          storedValue = storedValue.add(price.mul(g._sum.quantity ?? 0));
        }
        let lienedValue = new Prisma.Decimal(0);
        for (const l of liens) {
          const price = prices.get(l.receipt.commodityId);
          if (!price) continue;
          lienedValue = lienedValue.add(price.mul(l.remainingQuantity));
        }

        // Unit-normalized stock — convert each commodity to MT before
        // summing. Reuses `stockAgg` (already grouped by commodityId)
        // plus a commodity-metadata batch fetch.
        const stockCommodityIds = stockAgg.map((s) => s.commodityId);
        const stockMeta = stockCommodityIds.length
          ? await this.prisma.commodity.findMany({
              where: { id: { in: stockCommodityIds } },
              select: {
                id: true,
                unitOfMeasure: true,
                standardBagWeightKg: true,
                standardDensityKgPerLitre: true,
              },
            })
          : [];
        const stockCommodityById = new Map(stockMeta.map((c) => [c.id, c]));
        const [stockMt] = sumInMt(
          stockAgg.flatMap((s) => {
            const c = stockCommodityById.get(s.commodityId);
            if (!c) return [];
            return [
              {
                quantity: Number(s._sum.quantity ?? 0),
                commodity: c,
              },
            ];
          }),
        );

        const capacityMt = w.capacityMt ? Number(w.capacityMt) : null;
        const utilisationPct =
          capacityMt && capacityMt > 0
            ? Math.min(100, Math.round((stockMt / capacityMt) * 100))
            : null;

        return {
          id: w.id,
          name: w.name,
          code: w.code,
          location: w.location,
          status: w.status,
          capacityMt: capacityMt !== null ? String(capacityMt) : null,
          utilisationPct,
          managerCount,
          clientCount: clientAgg.length,
          activeReceipts,
          tenantId: w.tenantId,
          tenantName: w.tenant.name,
          storedValue: storedValue.toFixed(2),
          lienedValue: lienedValue.toFixed(2),
        };
      }),
    );

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ACTIVITY FEED — GET /admin/activity
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Reads the existing ActivityLog table. `action` maps to FE's `type`;
  // `description` maps to `summary`; `metadata.severity` maps to
  // `severity` (defaulted to INFO when absent).

  async listActivity(query: {
    severity?: string;
    page?: string;
    limit?: string;
  }) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    // Severity is stored inside `metadata.severity`. Prisma supports JSON
    // filtering on the field path — Postgres-only, matches our datasource.
    const where: any = {};
    if (query.severity) {
      where.metadata = {
        path: ['severity'],
        equals: query.severity,
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { firstName: true, lastName: true } },
          tenant: { select: { name: true } },
        },
      }),
      this.prisma.activityLog.count({ where }),
    ]);

    const items = rows.map((r) => {
      const meta = (r.metadata ?? {}) as { severity?: string };
      return {
        id: r.id,
        type: r.action,
        summary: r.description ?? r.action,
        actorName: r.user
          ? `${r.user.firstName} ${r.user.lastName}`.trim()
          : null,
        tenantName: r.tenant?.name ?? null,
        severity: (meta.severity ?? 'INFO') as
          | 'INFO'
          | 'WARNING'
          | 'CRITICAL',
        at: r.createdAt,
      };
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
