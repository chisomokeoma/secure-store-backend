import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeeType, BillingFrequency, MeasurementUnit } from '@prisma/client';

@Injectable()
export class StorageFeesService {
  constructor(private prisma: PrismaService) {}

  // ─── LIST ──────────────────────────────────────────────────────────────────

  async getPolicies(
    tenantId: string,
    query: { warehouseId?: string; commodityId?: string; isActive?: string },
  ) {
    const where: any = { tenantId };
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.commodityId) where.commodityId = query.commodityId;
    if (query.isActive !== undefined)
      where.isActive = query.isActive === 'true';

    return this.prisma.storageFeePolicy.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        warehouse: { select: { id: true, name: true } },
        commodity: { select: { id: true, name: true } },
      },
    });
  }

  // ─── CREATE ────────────────────────────────────────────────────────────────

  async createPolicy(
    tenantId: string,
    dto: {
      feeType: FeeType;
      warehouseId?: string;
      commodityId?: string;
      rate: number;
      billingFrequency: BillingFrequency;
      gracePeriodDays: number;
      latePenaltyPct: number;
      currency?: string;
    },
  ) {
    // Validate: PER_BAG_PER_WEEK requires standardBagWeightKg on commodity
    if (dto.feeType === 'PER_BAG_PER_WEEK' && dto.commodityId) {
      const commodity = await this.prisma.commodity.findFirst({
        where: { id: dto.commodityId, tenantId },
      });
      if (!commodity?.standardBagWeightKg) {
        throw new BadRequestException(
          'PER_BAG_PER_WEEK fee requires the commodity to have standardBagWeightKg set',
        );
      }
    }

    return this.prisma.storageFeePolicy.create({
      data: { ...dto, tenantId, currency: dto.currency ?? 'NGN' },
    });
  }

  // ─── UPDATE ────────────────────────────────────────────────────────────────

  async updatePolicy(
    tenantId: string,
    id: string,
    dto: Partial<{
      feeType: FeeType;
      warehouseId: string;
      commodityId: string;
      rate: number;
      billingFrequency: BillingFrequency;
      gracePeriodDays: number;
      latePenaltyPct: number;
      currency: string;
    }>,
  ) {
    const policy = await this.prisma.storageFeePolicy.findFirst({
      where: { id, tenantId },
    });
    if (!policy) throw new NotFoundException('Storage fee policy not found');
    return this.prisma.storageFeePolicy.update({ where: { id }, data: dto });
  }

  // ─── ACTIVATE / DEACTIVATE ─────────────────────────────────────────────────

  async activate(tenantId: string, id: string) {
    const policy = await this.prisma.storageFeePolicy.findFirst({
      where: { id, tenantId },
    });
    if (!policy) throw new NotFoundException('Policy not found');
    return this.prisma.storageFeePolicy.update({
      where: { id },
      data: { isActive: true },
    });
  }

  async deactivate(tenantId: string, id: string) {
    const policy = await this.prisma.storageFeePolicy.findFirst({
      where: { id, tenantId },
    });
    if (!policy) throw new NotFoundException('Policy not found');
    return this.prisma.storageFeePolicy.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // ─── FEE RESOLVER (used by withdrawals) ───────────────────────────────────

  async resolvePolicy(
    tenantId: string,
    warehouseId: string,
    commodityId: string,
  ) {
    const candidates = [
      { warehouseId, commodityId },
      { warehouseId, commodityId: null },
      { warehouseId: null, commodityId },
      { warehouseId: null, commodityId: null },
    ];

    for (const cond of candidates) {
      const policy = await this.prisma.storageFeePolicy.findFirst({
        where: { tenantId, isActive: true, ...cond },
        orderBy: { createdAt: 'desc' },
      });
      if (policy) return policy;
    }

    throw new BadRequestException(
      'No active storage fee policy found for this warehouse/commodity combination. Configure one under Settings → Storage Fees.',
    );
  }

  // ─── FEE CALCULATION ───────────────────────────────────────────────────────

  calculateFee(
    policy: { feeType: FeeType; rate: number },
    quantity: number,
    unit: MeasurementUnit,
    dateOfDeposit: Date,
    withdrawalRequestDate: Date,
    bagWeightKg?: number,
  ): number {
    const days = Math.ceil(
      (withdrawalRequestDate.getTime() - dateOfDeposit.getTime()) / 86_400_000,
    );
    const weeks = Math.ceil(days / 7);
    const months = Math.ceil(days / 30);

    const toMt = (qty: number, u: MeasurementUnit): number => {
      if (u === 'METRIC_TON') return qty;
      if (u === 'KILOGRAM') return qty / 1000;
      if (u === 'BAG') {
        if (!bagWeightKg)
          throw new BadRequestException(
            'Commodity missing standardBagWeightKg',
          );
        return (qty * bagWeightKg) / 1000;
      }
      throw new BadRequestException(`Cannot convert ${u} to METRIC_TON`);
    };

    const toBags = (qty: number, u: MeasurementUnit): number => {
      if (u === 'BAG') return qty;
      if (u === 'KILOGRAM') return Math.ceil(qty / (bagWeightKg ?? 1));
      if (u === 'METRIC_TON')
        return Math.ceil((qty * 1000) / (bagWeightKg ?? 1));
      throw new BadRequestException(`Cannot convert ${u} to BAG`);
    };

    switch (policy.feeType) {
      case 'PER_MT_PER_MONTH':
        return toMt(quantity, unit) * policy.rate * months;
      case 'PER_MT_PER_DAY':
        return toMt(quantity, unit) * policy.rate * days;
      case 'PER_BAG_PER_WEEK':
        return toBags(quantity, unit) * policy.rate * weeks;
      case 'FLAT_RATE':
        return policy.rate;
    }
  }
}
