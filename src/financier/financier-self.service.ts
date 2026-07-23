import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommodityPricesService } from '../commodity-prices/commodity-prices.service';
import { UpdateFinancierSettingsDto } from '../financier-orgs/dto/financier-orgs.dto';

/**
 * The default pledge TTL when no per-org override is set. Sourced from
 * env so it can be tuned without a code push. Falls back to 7 (matching
 * the FE's platform-default copy and §1.3 of the spec).
 *
 * The org-level `pledgeTtlDays` column overrides this per FinancierOrg
 * (Q1 answer). Snapshot semantics: the value used at pledge CREATION is
 * captured on the Pledge row (via `expiresAt`); later changes don't
 * retroactively shift already-created pledges.
 */
export const DEFAULT_PLEDGE_TTL_DAYS = (() => {
  const raw = process.env.PLEDGE_TTL_DAYS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
})();

/**
 * Financier-facing self operations: profile, settings, dashboard.
 * Everything here scopes implicitly to the caller's `financierOrgId`
 * (from the JWT) — we NEVER accept a financierOrgId from the request
 * body per §3 preamble.
 *
 * This service will grow substantially in later phases:
 *   Phase 3: warehouse onboarding, position views
 *   Phase 4: pledge inbox, accept/reject
 *   Phase 5: lien portfolio, release request queue
 * For now (Phase 2), it just returns the org profile, an empty-state
 * dashboard, and the pledge-config toggle.
 */
@Injectable()
export class FinancierSelfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commodityPrices: CommodityPricesService,
  ) {}

  /**
   * Assert the caller is actually a financier-role user with a resolvable
   * FinancierOrg. Used at the top of every /financier/* handler. Returns
   * the resolved org for downstream use.
   */
  async requireFinancierOrg(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        financierOrgId: true,
        financierOrg: {
          select: {
            id: true,
            name: true,
            licenseNumber: true,
            logoUrl: true,
            status: true,
            pledgeTtlDays: true,
          },
        },
      },
    });
    if (!user?.financierOrgId || !user.financierOrg) {
      throw new ForbiddenException(
        'This account is not associated with a FinancierOrg',
      );
    }
    if (user.financierOrg.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: 'FINANCIER_ORG_SUSPENDED',
        message:
          'Your organisation is currently suspended. Please contact the tenant administrator.',
      });
    }
    return user.financierOrg;
  }

  // ─── Self / org profile ────────────────────────────────────────────────

  /**
   * The signed-in financier user's own profile + org context. FE binds
   * the header (org name + logo) and Settings screen to this.
   */
  async getSelf(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        middleName: true,
        email: true,
        contactEmail: true,
        phoneNumber: true,
        profilePhotoUrl: true,
        status: true,
        twoFactorEnabled: true,
        transactionPinHash: true,
        financierOrg: {
          select: {
            id: true,
            name: true,
            licenseNumber: true,
            logoUrl: true,
            status: true,
            pledgeTtlDays: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.financierOrg) {
      throw new ForbiddenException(
        'This account is not associated with a FinancierOrg',
      );
    }
    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        middleName: user.middleName,
        lastName: user.lastName,
        email: user.email,
        contactEmail: user.contactEmail,
        phoneNumber: user.phoneNumber,
        profilePhotoUrl: user.profilePhotoUrl,
        status: user.status,
        // Security posture — same shape as /me returns for other roles so
        // the FE's shared settings component can bind identically.
        transactionPinSet: !!user.transactionPinHash,
        twoFactorEnabled: user.twoFactorEnabled,
      },
      financierOrg: user.financierOrg,
    };
  }

  // ─── Settings — Pledge TTL (Q1) ────────────────────────────────────────
  //
  // Response shape matches FE FinancierSettings in
  // src/api/types/collateral.ts: { pledgeTtlDays, isDefault }.
  //   pledgeTtlDays — the raw override (null when using platform default)
  //   isDefault     — true when no override is set
  //
  // The platform default itself (7 by default, tunable via env
  // PLEDGE_TTL_DAYS) is NOT surfaced — the FE hard-codes "7 days" in copy,
  // which is fine while the default doesn't move. If we ever need it to
  // move independently of the FE build, we can promote it to the response.

  async getSettings(userId: string) {
    const org = await this.requireFinancierOrg(userId);
    return {
      pledgeTtlDays: org.pledgeTtlDays,
      isDefault: org.pledgeTtlDays === null,
    };
  }

  /**
   * Update the org's pledge-TTL override.
   *   { pledgeTtlDays: null }  → clear override; revert to platform default
   *   { pledgeTtlDays: 1..90 } → custom window
   *
   * Snapshot semantics: change affects pledges created AFTER this save;
   * pledges already in flight keep their existing expiresAt. That's the
   * spec's rule (§1.3) and matches the FE Settings copy.
   */
  async updateSettings(userId: string, dto: UpdateFinancierSettingsDto) {
    const org = await this.requireFinancierOrg(userId);
    // `pledgeTtlDays` is declared !: in the DTO but class-validator lets
    // it pass either an integer or explicit null; both are valid writes.
    // Defensive guard against `undefined` (a client hitting the endpoint
    // with an empty body) — return 400 rather than silently doing nothing.
    if (dto.pledgeTtlDays === undefined) {
      throw new BadRequestException(
        'pledgeTtlDays is required (integer 1-90 or null to clear the override)',
      );
    }
    await this.prisma.financierOrg.update({
      where: { id: org.id },
      data: { pledgeTtlDays: dto.pledgeTtlDays },
    });
    return this.getSettings(userId);
  }

  // ─── Dashboard (Phase 2 empty-state) ───────────────────────────────────

  /**
   * Financier's dashboard — zeros-and-nulls empty state until later
   * phases populate real numbers. The shape matches the FE's
   * FinancierDashboardSummary type in src/api/types/collateral.ts so
   * the dashboard cards render immediately with placeholder numbers.
   *
   * Phase 3 fills in warehouseCount (from active WarehouseLinks).
   * Phase 4 fills in pending.pledges + recentActivity + byCommodity +
   *   byWarehouse.
   * Phase 5 fills in exposure.* + pending.releaseRequests +
   *   lienCount + clientCount.
   * Phase 6 wires the recentActivity feed to the real audit stream.
   */
  async getDashboard(userId: string) {
    const org = await this.requireFinancierOrg(userId);

    // Load everything the dashboard needs in parallel. The heaviest query
    // is the liens-with-relations load (bounded by count of active liens
    // per org). If a financier grows past ~5k active liens this may want
    // aggregation-by-DB or a materialised view; today the read cost is
    // negligible for realistic portfolios.
    const [
      warehouseCount,
      pendingPledges,
      pendingReleaseRequests,
      activeLiens,
      recentActivity,
    ] = await Promise.all([
      this.prisma.warehouseLink.count({
        where: { financierOrgId: org.id, status: 'ACTIVE' },
      }),
      this.prisma.pledge.count({
        where: { financierOrgId: org.id, status: 'PENDING' },
      }),
      this.prisma.releaseRequest.count({
        where: { financierOrgId: org.id, status: 'PENDING' },
      }),
      // Active liens with commodity + warehouse relations for aggregation.
      // `remainingQuantity` is what matters — a partially-released lien's
      // exposure is what's LEFT, not the original.
      this.prisma.lien.findMany({
        where: {
          financierOrgId: org.id,
          status: { in: ['ACTIVE', 'PARTIALLY_RELEASED'] },
        },
        select: {
          id: true,
          clientId: true,
          remainingQuantity: true,
          receipt: {
            select: {
              // tenantId on the receipt is how we scope the CommodityPrice
              // lookup — financiers are platform-level and cross-tenant, so
              // the same commodity in a different tenant could be priced
              // differently. Pull it from the receipt (source of truth for
              // which tenant this collateral lives under).
              tenantId: true,
              commodityId: true,
              warehouseId: true,
              commodity: { select: { name: true, unitOfMeasure: true } },
              warehouse: { select: { id: true, name: true } },
            },
          },
        },
      }),
      // Recent activity feed — pledges + release requests + force-releases
      // over the last 30 days, projected to the FE's `{ type, at, summary }`
      // shape. We union three queries with a limit each, then sort in
      // memory. For a bank with a few hundred entries this is fine; if it
      // grows, promote to a dedicated ActivityLog projection.
      this.buildRecentActivity(org.id),
    ]);

    // ── Batched valuation lookup ────────────────────────────────────────
    // Financier is cross-tenant, so we key the price map by (tenantId,
    // commodityId) — the same commodity in tenant A vs tenant B may be
    // priced differently. Map key is a composite string; lookups later
    // reconstruct the same key from each lien's receipt.
    const uniqueTenantCommodityPairs = [
      ...new Set(
        activeLiens.map(
          (l) => `${l.receipt.tenantId}::${l.receipt.commodityId}`,
        ),
      ),
    ];
    const priceMap = new Map<
      string,
      { pricePerUnit: Prisma.Decimal; currency: string }
    >();
    for (const pair of uniqueTenantCommodityPairs) {
      const [tenantId, commodityId] = pair.split('::');
      const p = await this.commodityPrices.currentPrice(tenantId, commodityId);
      if (p) {
        priceMap.set(pair, {
          pricePerUnit: p.pricePerUnit,
          currency: p.currency,
        });
      }
    }

    // ── Aggregate by commodity ────────────────────────────────────────
    const commodityBuckets = new Map<
      string,
      {
        commodity: string;
        unit: string;
        quantity: Prisma.Decimal;
        value: Prisma.Decimal;
      }
    >();
    // Helper: reconstruct the (tenantId, commodityId) key used in priceMap.
    const priceKey = (lien: typeof activeLiens[number]) =>
      `${lien.receipt.tenantId}::${lien.receipt.commodityId}`;

    for (const lien of activeLiens) {
      const cid = lien.receipt.commodityId;
      const price = priceMap.get(priceKey(lien));
      const lineValue = price
        ? price.pricePerUnit.mul(lien.remainingQuantity)
        : new Prisma.Decimal(0);
      const bucket = commodityBuckets.get(cid) ?? {
        commodity: lien.receipt.commodity.name,
        unit: lien.receipt.commodity.unitOfMeasure,
        quantity: new Prisma.Decimal(0),
        value: new Prisma.Decimal(0),
      };
      bucket.quantity = bucket.quantity.add(lien.remainingQuantity);
      bucket.value = bucket.value.add(lineValue);
      commodityBuckets.set(cid, bucket);
    }

    // ── Aggregate by warehouse ────────────────────────────────────────
    const warehouseBuckets = new Map<
      string,
      { warehouseId: string; name: string; lienedValue: Prisma.Decimal }
    >();
    for (const lien of activeLiens) {
      const wid = lien.receipt.warehouseId;
      const price = priceMap.get(priceKey(lien));
      const lineValue = price
        ? price.pricePerUnit.mul(lien.remainingQuantity)
        : new Prisma.Decimal(0);
      const bucket = warehouseBuckets.get(wid) ?? {
        warehouseId: wid,
        name: lien.receipt.warehouse.name,
        lienedValue: new Prisma.Decimal(0),
      };
      bucket.lienedValue = bucket.lienedValue.add(lineValue);
      warehouseBuckets.set(wid, bucket);
    }

    // Totals derived from the same aggregation loop — cheaper than a
    // separate pass.
    let totalLienedValue = new Prisma.Decimal(0);
    for (const b of commodityBuckets.values()) {
      totalLienedValue = totalLienedValue.add(b.value);
    }
    const uniqueClientIds = new Set(activeLiens.map((l) => l.clientId));

    return {
      exposure: {
        totalLienedValue: totalLienedValue.toString(),
        currency: 'NGN',
        lienCount: activeLiens.length,
        warehouseCount,
        clientCount: uniqueClientIds.size,
      },
      pending: {
        pledges: pendingPledges,
        releaseRequests: pendingReleaseRequests,
      },
      byCommodity: [...commodityBuckets.values()].map((b) => ({
        commodity: b.commodity,
        quantity: b.quantity.toString(),
        unit: b.unit,
        value: b.value.toString(),
      })),
      byWarehouse: [...warehouseBuckets.values()].map((b) => ({
        warehouseId: b.warehouseId,
        name: b.name,
        lienedValue: b.lienedValue.toString(),
      })),
      recentActivity,
    };
  }

  /**
   * Build the recent-activity feed by unioning three query streams. Each
   * feed contributes a projection to `{ type, at, summary }` and we merge-
   * sort by timestamp desc. Cheap enough for the sizes we expect; if it
   * grows past ~500 events per week we should promote to an ActivityLog
   * projection with a materialised view.
   */
  private async buildRecentActivity(
    financierOrgId: string,
  ): Promise<{ type: string; at: Date; summary: string }[]> {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [pledges, releases, forceReleases] = await Promise.all([
      this.prisma.pledge.findMany({
        where: {
          financierOrgId,
          OR: [
            { createdAt: { gte: since } },
            { decidedAt: { gte: since } },
          ],
        },
        select: {
          id: true,
          status: true,
          quantity: true,
          unit: true,
          createdAt: true,
          decidedAt: true,
          receipt: {
            select: {
              receiptNumber: true,
              commodity: { select: { name: true } },
            },
          },
          client: {
            select: { firstName: true, lastName: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.releaseRequest.findMany({
        where: {
          financierOrgId,
          OR: [
            { createdAt: { gte: since } },
            { decidedAt: { gte: since } },
          ],
        },
        select: {
          id: true,
          status: true,
          createdAt: true,
          decidedAt: true,
          client: { select: { firstName: true, lastName: true } },
          lines: { select: { quantity: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.forceRelease.findMany({
        where: {
          lien: { financierOrgId },
          createdAt: { gte: since },
        },
        select: {
          id: true,
          reason: true,
          createdAt: true,
          lien: {
            select: {
              client: { select: { firstName: true, lastName: true } },
              receipt: { select: { receiptNumber: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const entries: { type: string; at: Date; summary: string }[] = [];

    for (const p of pledges) {
      const client = `${p.client.firstName} ${p.client.lastName}`;
      const commodity = p.receipt.commodity.name;
      const qty = `${p.quantity.toString()} ${p.unit}`;
      const rcp = p.receipt.receiptNumber;
      // Emit the CREATE event
      entries.push({
        type: 'pledge.created',
        at: p.createdAt,
        summary: `${client} pledged ${qty} ${commodity} (${rcp})`,
      });
      // And the DECISION event when there is one
      if (p.decidedAt) {
        const decisionType =
          p.status === 'ACCEPTED'
            ? 'pledge.accepted'
            : p.status === 'REJECTED'
              ? 'pledge.rejected'
              : p.status === 'EXPIRED'
                ? 'pledge.expired'
                : 'pledge.cancelled';
        entries.push({
          type: decisionType,
          at: p.decidedAt,
          summary: `Pledge ${p.status.toLowerCase()} — ${qty} ${commodity} (${rcp})`,
        });
      }
    }

    for (const r of releases) {
      const client = `${r.client.firstName} ${r.client.lastName}`;
      const totalQty = r.lines.reduce(
        (sum, l) => sum.add(l.quantity),
        new Prisma.Decimal(0),
      );
      entries.push({
        type: 'release.requested',
        at: r.createdAt,
        summary: `${client} requested release of ${totalQty.toString()} across ${r.lines.length} lien(s)`,
      });
      if (r.decidedAt) {
        entries.push({
          type:
            r.status === 'APPROVED'
              ? 'release.approved'
              : r.status === 'REJECTED'
                ? 'release.rejected'
                : 'release.cancelled',
          at: r.decidedAt,
          summary: `Release ${r.status.toLowerCase()} — ${totalQty.toString()}`,
        });
      }
    }

    for (const fr of forceReleases) {
      const client = `${fr.lien.client.firstName} ${fr.lien.client.lastName}`;
      entries.push({
        type: 'lien.force_released',
        at: fr.createdAt,
        summary: `Admin force-released lien on ${client}'s receipt ${fr.lien.receipt.receiptNumber}`,
      });
    }

    entries.sort((a, b) => b.at.getTime() - a.at.getTime());
    return entries.slice(0, 15);
  }
}
