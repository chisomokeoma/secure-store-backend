import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateGradingParameterDto } from '../dto/grading.dto';
import { CreateStorageFeePolicyDto } from '../dto/storage-fee.dto';

@Injectable()
export class AdminConfigService {
  constructor(private prisma: PrismaService) {}

  async getGradingParameters(tenantId: string, commodityId?: string) {
    return this.prisma.gradingParameter.findMany({
      where: {
        tenantId,
        ...(commodityId ? { commodityId } : {}),
      },
      include: { commodity: true },
    });
  }

  async upsertGradingParameter(
    tenantId: string,
    dto: CreateGradingParameterDto,
  ) {
    return this.prisma.gradingParameter.upsert({
      where: {
        commodityId_name: {
          commodityId: dto.commodityId,
          name: dto.name,
        },
      },
      update: {
        unit: dto.unit,
        isDefective: dto.isDefective,
        thresholds: dto.thresholds as any,
      },
      create: {
        name: dto.name,
        unit: dto.unit,
        isDefective: dto.isDefective,
        thresholds: dto.thresholds as any,
        commodityId: dto.commodityId,
        tenantId,
      },
    });
  }

  async getStorageFeePolicies(tenantId: string) {
    return this.prisma.storageFeePolicy.findMany({
      where: { tenantId },
      include: { warehouse: true, commodity: true },
    });
  }

  async createStorageFeePolicy(
    tenantId: string,
    dto: CreateStorageFeePolicyDto,
  ) {
    return this.prisma.storageFeePolicy.create({
      data: {
        warehouseId: dto.warehouseId,
        commodityId: dto.commodityId,
        feeType: dto.feeType,
        rate: dto.rate,
        billingFrequency: dto.billingFrequency,
        gracePeriodDays: dto.gracePeriodDays,
        latePenaltyPct: dto.latePenaltyPct,
        currency: dto.currency || 'NGN',
        isActive: dto.isActive !== undefined ? dto.isActive : true,
        tenantId,
      },
    });
  }
}
