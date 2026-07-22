import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reads (and — later — writes) commodity reference prices.
 *
 * Q2 decision: pledge valuation is looked up automatically per current
 * market data. In v1 the DB table (`CommodityPrice`) is populated
 * manually by a TA (or seed). A future sync job can insert rows with
 * `source != 'MANUAL'` without any change to this reader — we always
 * pick the latest effective row.
 *
 * `lookupValuation` is the pledge-time entry point: given a
 * (tenantId, commodityId, quantity), return the reference monetary
 * value in NGN. Null when no price is on file — the pledge still
 * succeeds, just with `valuationAtPledge = null` on the row and a
 * "—" in the FE column.
 */
@Injectable()
export class CommodityPricesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The latest CommodityPrice row whose effectiveAt <= now for a given
   * (tenant, commodity). Returns null when no price is on file.
   *
   * Uses the composite index (tenantId, commodityId, effectiveAt DESC)
   * so this is a single index scan even on a large price history.
   */
  async currentPrice(tenantId: string, commodityId: string) {
    return this.prisma.commodityPrice.findFirst({
      where: {
        tenantId,
        commodityId,
        effectiveAt: { lte: new Date() },
      },
      orderBy: { effectiveAt: 'desc' },
    });
  }

  /**
   * Multiply the current per-unit price by the pledged quantity to get
   * the reference valuation. Both `pricePerUnit` and `quantity` are
   * Prisma Decimals so the multiplication is exact (no float drift).
   *
   * Returns `{ value, currency }` when a price exists; null otherwise.
   * Caller stores the value on Pledge.valuationAtPledge and the
   * currency on Pledge.currency (defaults to NGN when missing).
   */
  async lookupValuation(args: {
    tenantId: string;
    commodityId: string;
    quantity: Prisma.Decimal | string | number;
  }): Promise<{ value: Prisma.Decimal; currency: string } | null> {
    const price = await this.currentPrice(args.tenantId, args.commodityId);
    if (!price) return null;
    const qty = new Prisma.Decimal(args.quantity);
    return {
      value: price.pricePerUnit.mul(qty),
      currency: price.currency,
    };
  }

  /**
   * Insert a fresh price row. Used by seed scripts and the (yet-to-be-
   * built) admin price-management screen. Rows are additive — old ones
   * remain in place so the pledge history's `valuationAtPledge` stays
   * meaningful even if the current price later changes.
   */
  async setPrice(args: {
    tenantId: string;
    commodityId: string;
    unit: string;
    pricePerUnit: Prisma.Decimal | string | number;
    currency?: string;
    setById: string;
    effectiveAt?: Date;
    source?: string;
  }) {
    if (typeof args.pricePerUnit === 'number' && args.pricePerUnit <= 0) {
      throw new BadRequestException('pricePerUnit must be positive');
    }
    return this.prisma.commodityPrice.create({
      data: {
        tenantId: args.tenantId,
        commodityId: args.commodityId,
        unit: args.unit,
        pricePerUnit: new Prisma.Decimal(args.pricePerUnit),
        currency: args.currency ?? 'NGN',
        setById: args.setById,
        effectiveAt: args.effectiveAt ?? new Date(),
        source: args.source ?? 'MANUAL',
      },
    });
  }
}
