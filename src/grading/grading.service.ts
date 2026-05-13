import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GradingLogic, MeasurementUnit } from '@prisma/client';
import { scoreSample } from './grading.scorer';

@Injectable()
export class GradingService {
  constructor(private prisma: PrismaService) {}

  // ─── COMMODITIES ───────────────────────────────────────────────────────────

  async getCommodities(tenantId: string) {
    return this.prisma.commodity.findMany({
      where: { tenantId },
      include: {
        gradingParameters: true,
        _count: { select: { receipts: true, warehouseCommodities: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createCommodity(
    tenantId: string,
    dto: {
      name: string;
      code?: string;
      unitOfMeasure: MeasurementUnit;
      gradingLogic?: GradingLogic;
      numberOfGrades?: number;
      standardBagWeightKg?: number;
      description?: string;
    },
  ) {
    return this.prisma.commodity.create({
      data: { ...dto, tenantId },
    });
  }

  async updateCommodity(
    tenantId: string,
    id: string,
    dto: Partial<{
      name: string;
      code: string;
      unitOfMeasure: MeasurementUnit;
      gradingLogic: GradingLogic;
      numberOfGrades: number;
      standardBagWeightKg: number;
      description: string;
    }>,
  ) {
    const commodity = await this.prisma.commodity.findFirst({
      where: { id, tenantId },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');
    return this.prisma.commodity.update({ where: { id }, data: dto });
  }

  // ─── GRADING PARAMETERS ────────────────────────────────────────────────────

  async getParameters(tenantId: string, commodityId: string) {
    const commodity = await this.prisma.commodity.findFirst({
      where: { id: commodityId, tenantId },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');

    return this.prisma.gradingParameter.findMany({
      where: { commodityId, tenantId },
      orderBy: { name: 'asc' },
    });
  }

  async addParameter(
    tenantId: string,
    commodityId: string,
    dto: {
      name: string;
      unit: string;
      isDefective: boolean;
      thresholds: Record<string, number>;
    },
  ) {
    const commodity = await this.prisma.commodity.findFirst({
      where: { id: commodityId, tenantId },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');

    // Validate threshold keys match numberOfGrades
    const expectedGrades = Array.from(
      { length: commodity.numberOfGrades },
      (_, i) => `Grade ${i + 1}`,
    );
    const providedKeys = Object.keys(dto.thresholds);
    const missing = expectedGrades.filter((g) => !providedKeys.includes(g));
    const extra = providedKeys.filter((k) => !expectedGrades.includes(k));
    if (missing.length > 0)
      throw new BadRequestException(
        `Missing threshold keys: ${missing.join(', ')}`,
      );
    if (extra.length > 0)
      throw new BadRequestException(
        `Extra threshold keys: ${extra.join(', ')}`,
      );

    return this.prisma.gradingParameter.create({
      data: {
        ...dto,
        commodityId,
        tenantId,
        thresholds: dto.thresholds as any,
      },
    });
  }

  async updateParameter(
    tenantId: string,
    parameterId: string,
    dto: Partial<{
      name: string;
      unit: string;
      isDefective: boolean;
      thresholds: Record<string, number>;
    }>,
  ) {
    const param = await this.prisma.gradingParameter.findFirst({
      where: { id: parameterId, tenantId },
    });
    if (!param) throw new NotFoundException('Grading parameter not found');
    return this.prisma.gradingParameter.update({
      where: { id: parameterId },
      data: { ...dto, thresholds: dto.thresholds as any },
    });
  }

  async deleteParameter(tenantId: string, parameterId: string) {
    const param = await this.prisma.gradingParameter.findFirst({
      where: { id: parameterId, tenantId },
    });
    if (!param) throw new NotFoundException('Grading parameter not found');
    return this.prisma.gradingParameter.delete({ where: { id: parameterId } });
  }

  // ─── APPLY TO WAREHOUSES ───────────────────────────────────────────────────

  async applyToWarehouses(
    tenantId: string,
    commodityId: string,
    warehouseIds?: string[],
  ) {
    const commodity = await this.prisma.commodity.findFirst({
      where: { id: commodityId, tenantId },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');

    const targetIds = warehouseIds?.length
      ? warehouseIds
      : (
          await this.prisma.warehouse.findMany({
            where: { tenantId },
            select: { id: true },
          })
        ).map((w) => w.id);

    const results = await Promise.all(
      targetIds.map((warehouseId) =>
        this.prisma.warehouseCommodity.upsert({
          where: { warehouseId_commodityId: { warehouseId, commodityId } },
          create: { warehouseId, commodityId, tenantId, storageFeePerUnit: 0 },
          update: {},
        }),
      ),
    );

    return { applied: results.length };
  }

  // ─── SCORER PREVIEW ────────────────────────────────────────────────────────

  async scorePreview(
    tenantId: string,
    commodityId: string,
    measurements: Record<string, number>,
  ) {
    const commodity = await this.prisma.commodity.findFirst({
      where: { id: commodityId, tenantId },
      include: { gradingParameters: true },
    });
    if (!commodity) throw new NotFoundException('Commodity not found');
    if (!commodity.gradingParameters.length) {
      throw new BadRequestException(
        'This commodity has no grading parameters configured',
      );
    }

    const params = commodity.gradingParameters.map((p) => ({
      name: p.name,
      unit: p.unit,
      isDefective: p.isDefective,
      thresholds: p.thresholds as Record<string, number>,
    }));

    try {
      const result = scoreSample({
        parameters: params,
        measurements,
        numberOfGrades: commodity.numberOfGrades,
      });
      return { commodity: commodity.name, ...result };
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }
}
