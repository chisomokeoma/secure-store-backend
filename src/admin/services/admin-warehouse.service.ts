import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReceiptStatus, WarehouseStatus } from '@prisma/client';

@Injectable()
export class AdminWarehouseService {
  constructor(private prisma: PrismaService) {}

  // ─── LIST ──────────────────────────────────────────────────────────────────

  async getWarehouses(
    tenantId: string,
    query: { status?: string; search?: string; page?: string; limit?: string },
  ) {
    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const skip = (page - 1) * limit;

    const where: any = { tenantId };
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
        { location: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [warehouses, total] = await Promise.all([
      this.prisma.warehouse.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          managerAssignments: {
            where: { unassignedAt: null },
            include: {
              manager: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  managerCode: true,
                },
              },
            },
          },
          _count: { select: { receipts: true } },
        },
      }),
      this.prisma.warehouse.count({ where }),
    ]);

    // Aggregate stats
    const allWarehouses = await this.prisma.warehouse.findMany({
      where: { tenantId },
      select: { capacityMt: true, status: true },
    });
    const totalCapacityMt = allWarehouses.reduce(
      (s, w) => s + (w.capacityMt ?? 0),
      0,
    );

    // Total utilized: sum of quantityAvailable on active receipts
    const utilizationAgg = await this.prisma.receipt.aggregate({
      where: { tenantId, status: ReceiptStatus.ACTIVE },
      _sum: { quantityAvailable: true },
    });
    const totalUtilizationMt = utilizationAgg._sum.quantityAvailable ?? 0;

    return {
      stats: {
        totalWarehouses: allWarehouses.length,
        totalCapacityMt,
        totalUtilizationMt,
      },
      data: warehouses,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── DETAIL ────────────────────────────────────────────────────────────────

  async getWarehouseById(tenantId: string, id: string) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id, tenantId },
      include: {
        managerAssignments: {
          where: { unassignedAt: null },
          include: {
            manager: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                managerCode: true,
              },
            },
          },
        },
        warehouseCommodities: {
          include: {
            commodity: {
              select: { id: true, name: true, unitOfMeasure: true },
            },
          },
        },
      },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    // Summary stats
    const [totalClients, totalReceipts, commodityAgg] = await Promise.all([
      this.prisma.receipt
        .groupBy({
          by: ['clientId'],
          where: { warehouseId: id, tenantId, status: ReceiptStatus.ACTIVE },
        })
        .then((r) => r.length),
      this.prisma.receipt.count({ where: { warehouseId: id, tenantId } }),
      this.prisma.receipt.aggregate({
        where: { warehouseId: id, tenantId, status: ReceiptStatus.ACTIVE },
        _sum: { quantityAvailable: true },
      }),
    ]);

    const recentReceipts = await this.prisma.receipt.findMany({
      where: { warehouseId: id, tenantId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        commodity: { select: { name: true, unitOfMeasure: true } },
        client: { select: { firstName: true, lastName: true } },
      },
    });

    return {
      warehouse,
      managers: warehouse.managerAssignments.map((a) => a.manager),
      summary: {
        totalClients,
        totalCommodityMt: commodityAgg._sum.quantityAvailable ?? 0,
        totalReceipts,
        currency: 'NGN',
      },
      recentReceipts,
    };
  }

  // ─── RECEIPTS FOR A WAREHOUSE ───────────────────────────────────────────────

  async getWarehouseReceipts(
    tenantId: string,
    warehouseId: string,
    query: {
      status?: string;
      approvalStatus?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, tenantId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const skip = (page - 1) * limit;

    const where: any = { warehouseId, tenantId };
    if (query.status) where.status = query.status;
    if (query.approvalStatus) where.approvalStatus = query.approvalStatus;

    const [receipts, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          commodity: { select: { name: true, unitOfMeasure: true } },
          client: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.receipt.count({ where }),
    ]);

    return {
      data: receipts,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── MANAGERS FOR A WAREHOUSE ───────────────────────────────────────────────

  async getWarehouseManagers(tenantId: string, warehouseId: string) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, tenantId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    return this.prisma.warehouseManagerAssignment.findMany({
      where: { warehouseId, tenantId, unassignedAt: null },
      include: {
        manager: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            managerCode: true,
            status: true,
          },
        },
      },
    });
  }

  // ─── CREATE ────────────────────────────────────────────────────────────────

  async createWarehouse(
    tenantId: string,
    dto: {
      name: string;
      location: string;
      code?: string;
      type?: string;
      state?: string;
      address?: string;
      capacityMt?: number;
      commodityIds?: string[];
      managerIds?: string[];
    },
  ) {
    const { commodityIds = [], managerIds = [], ...warehouseData } = dto;

    return this.prisma.$transaction(async (tx) => {
      const warehouse = await tx.warehouse.create({
        data: {
          ...warehouseData,
          tenantId,
          status: WarehouseStatus.ACTIVE,
        },
      });

      // Link commodities via WarehouseCommodity upsert
      for (const commodityId of commodityIds) {
        await tx.warehouseCommodity.upsert({
          where: {
            warehouseId_commodityId: { warehouseId: warehouse.id, commodityId },
          },
          create: {
            warehouseId: warehouse.id,
            commodityId,
            tenantId,
            storageFeePerUnit: 0,
          },
          update: {},
        });
      }

      // Assign managers if provided
      if (managerIds.length > 0) {
        await tx.warehouseManagerAssignment.createMany({
          data: managerIds.map((managerId) => ({
            tenantId,
            warehouseId: warehouse.id,
            managerId,
            assignedBy: managerId,
          })),
          skipDuplicates: true,
        });
      }

      return warehouse;
    });
  }

  // ─── UPDATE ────────────────────────────────────────────────────────────────

  async updateWarehouse(
    tenantId: string,
    id: string,
    dto: {
      name?: string;
      location?: string;
      code?: string;
      type?: string;
      state?: string;
      address?: string;
      capacityMt?: number;
      status?: WarehouseStatus;
    },
  ) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id, tenantId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    return this.prisma.warehouse.update({ where: { id }, data: dto });
  }

  // ─── COMMODITY LINKING ─────────────────────────────────────────────────────

  async addCommodity(
    tenantId: string,
    warehouseId: string,
    commodityId: string,
  ) {
    const [warehouse, commodity] = await Promise.all([
      this.prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId } }),
      this.prisma.commodity.findFirst({ where: { id: commodityId, tenantId } }),
    ]);
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    if (!commodity) throw new NotFoundException('Commodity not found');

    return this.prisma.warehouseCommodity.upsert({
      where: { warehouseId_commodityId: { warehouseId, commodityId } },
      create: { warehouseId, commodityId, tenantId, storageFeePerUnit: 0 },
      update: {},
    });
  }

  async removeCommodity(
    tenantId: string,
    warehouseId: string,
    commodityId: string,
  ) {
    const wc = await this.prisma.warehouseCommodity.findFirst({
      where: { warehouseId, commodityId, tenantId },
    });
    if (!wc)
      throw new NotFoundException('Commodity not linked to this warehouse');

    const hasActiveReceipts = await this.prisma.receipt.count({
      where: {
        warehouseId,
        commodityId,
        tenantId,
        status: ReceiptStatus.ACTIVE,
      },
    });
    if (hasActiveReceipts > 0) {
      throw new BadRequestException(
        'Cannot remove commodity: there are active receipts for it in this warehouse',
      );
    }

    return this.prisma.warehouseCommodity.delete({ where: { id: wc.id } });
  }

  // ─── BULK MANAGER ASSIGNMENT ───────────────────────────────────────────────

  async assignManagers(
    tenantId: string,
    warehouseId: string,
    managerIds: string[],
    assignedBy: string,
  ) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, tenantId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    const existing = await this.prisma.warehouseManagerAssignment.findMany({
      where: { warehouseId, tenantId, unassignedAt: null },
      select: { managerId: true },
    });
    const existingIds = new Set(existing.map((e) => e.managerId));
    const newIds = managerIds.filter((id) => !existingIds.has(id));

    if (newIds.length > 0) {
      await this.prisma.warehouseManagerAssignment.createMany({
        data: newIds.map((managerId) => ({
          tenantId,
          warehouseId,
          managerId,
          assignedBy,
        })),
      });
    }

    return {
      assigned: newIds.length,
      alreadyAssigned: managerIds.length - newIds.length,
    };
  }
}
