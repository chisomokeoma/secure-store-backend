import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, LienStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommodityPricesService } from '../commodity-prices/commodity-prices.service';

/**
 * Read-side surface for the Lien Portfolio table on the financier UI.
 * Writes to Lien rows happen elsewhere (PledgesService on accept; the
 * release-approval flow in Phase 5; force-release admin endpoint in
 * Phase 6). This service only reads.
 *
 * Shape matches FE `Lien` type in src/api/types/collateral.ts:
 *   { id, pledgeId, receipt, client, financier, warehouse,
 *     quantity, remainingQuantity, currentValuation?, currency?,
 *     status, placedAt, releasedAt? }
 *
 * `currentValuation` is computed at read time from the reference-price
 * table (Q2). Same shape as `Pledge.valuationAtPledge` but reflects
 * TODAY's price, not the pledge-time snapshot — this is what the FE's
 * "current valuation" column expects to move as market prices update.
 */
@Injectable()
export class LiensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commodityPrices: CommodityPricesService,
  ) {}

  private async requireFinancierOrg(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        tenantId: true,
        financierOrg: {
          select: { id: true, name: true, status: true },
        },
      },
    });
    if (!user?.financierOrg) {
      throw new ForbiddenException(
        'This account is not associated with a FinancierOrg',
      );
    }
    if (user.financierOrg.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: 'FINANCIER_ORG_SUSPENDED',
        message: 'Your organisation is currently suspended.',
      });
    }
    return { financierOrg: user.financierOrg, tenantId: user.tenantId };
  }

  async listFinancierLiens(
    callerUserId: string,
    query: {
      status?: string;
      clientId?: string;
      warehouseId?: string;
      commodity?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const { financierOrg } = await this.requireFinancierOrg(callerUserId);
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const where: any = { financierOrgId: financierOrg.id };
    if (query.status) where.status = query.status;
    if (query.clientId) where.clientId = query.clientId;
    if (query.warehouseId || query.commodity) {
      where.receipt = {};
      if (query.warehouseId) where.receipt.warehouseId = query.warehouseId;
      if (query.commodity) {
        where.receipt.commodity = {
          name: { equals: query.commodity, mode: 'insensitive' },
        };
      }
    }

    const [rows, total] = await Promise.all([
      this.prisma.lien.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { placedAt: 'desc' },
        include: this.lienInclude,
      }),
      this.prisma.lien.count({ where }),
    ]);

    // Batch valuation lookup: one query per commodity in the page,
    // rather than N queries for N rows. Small optimisation but noticeable
    // for a financier's Lien Portfolio which can easily be hundreds of rows.
    const uniqueCommodityIds = [
      ...new Set(rows.map((r) => r.receipt.commodityId)),
    ];
    const priceMap = new Map<string, { pricePerUnit: Prisma.Decimal; currency: string }>();
    for (const cid of uniqueCommodityIds) {
      const p = await this.commodityPrices.currentPrice(
        rows[0].tenantId,
        cid,
      );
      if (p) {
        priceMap.set(cid, {
          pricePerUnit: p.pricePerUnit,
          currency: p.currency,
        });
      }
    }

    return {
      items: rows.map((r) => this.projectLien(r, priceMap)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getFinancierLienDetail(callerUserId: string, lienId: string) {
    const { financierOrg } = await this.requireFinancierOrg(callerUserId);
    const lien = await this.prisma.lien.findFirst({
      where: { id: lienId, financierOrgId: financierOrg.id },
      include: this.lienInclude,
    });
    if (!lien) throw new NotFoundException('Lien not found');

    const price = await this.commodityPrices.currentPrice(
      lien.tenantId,
      lien.receipt.commodityId,
    );
    const priceMap = new Map<
      string,
      { pricePerUnit: Prisma.Decimal; currency: string }
    >();
    if (price) {
      priceMap.set(lien.receipt.commodityId, {
        pricePerUnit: price.pricePerUnit,
        currency: price.currency,
      });
    }

    return this.projectLien(lien, priceMap);
  }

  // ─── Projection ────────────────────────────────────────────────────────

  private readonly lienInclude = {
    receipt: {
      select: {
        id: true,
        receiptNumber: true,
        commodityId: true,
        grade: true,
        commodity: { select: { name: true, unitOfMeasure: true } },
        warehouse: { select: { id: true, name: true } },
      },
    },
    client: {
      select: { id: true, firstName: true, lastName: true },
    },
    financierOrg: {
      select: { id: true, name: true, logoUrl: true },
    },
    pledge: {
      select: { id: true },
    },
  };

  private projectLien(
    l: {
      id: string;
      tenantId: string;
      pledge: { id: string };
      receipt: {
        id: string;
        receiptNumber: string;
        commodityId: string;
        grade: string | null;
        commodity: { name: string; unitOfMeasure: string };
        warehouse: { id: string; name: string };
      };
      client: { id: string; firstName: string; lastName: string };
      financierOrg: { id: string; name: string; logoUrl: string | null };
      quantity: Prisma.Decimal;
      remainingQuantity: Prisma.Decimal;
      status: LienStatus;
      placedAt: Date;
      releasedAt: Date | null;
    },
    priceMap: Map<string, { pricePerUnit: Prisma.Decimal; currency: string }>,
  ) {
    const price = priceMap.get(l.receipt.commodityId);
    const currentValuation = price
      ? price.pricePerUnit.mul(l.remainingQuantity).toString()
      : null;

    return {
      id: l.id,
      pledgeId: l.pledge.id,
      receipt: {
        id: l.receipt.id,
        receiptNumber: l.receipt.receiptNumber,
        commodity: l.receipt.commodity.name,
        grade: l.receipt.grade,
        unit: l.receipt.commodity.unitOfMeasure,
      },
      client: {
        id: l.client.id,
        name: `${l.client.firstName} ${l.client.lastName}`,
      },
      financier: {
        id: l.financierOrg.id,
        name: l.financierOrg.name,
        logoUrl: l.financierOrg.logoUrl,
      },
      warehouse: {
        id: l.receipt.warehouse.id,
        name: l.receipt.warehouse.name,
      },
      quantity: l.quantity.toString(),
      remainingQuantity: l.remainingQuantity.toString(),
      currentValuation,
      currency: price?.currency ?? 'NGN',
      status: l.status,
      placedAt: l.placedAt,
      releasedAt: l.releasedAt,
    };
  }
}
