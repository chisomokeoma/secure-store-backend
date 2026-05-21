import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReceiptStatus, WarehouseStatus, WithdrawalStatus } from '@prisma/client';
import {
  statusesForGroup,
  deriveGroup,
  HELD_STATUSES,
} from '../../inventory/inventory.types';

// In-warehouse = client-owned, physically present. ACTIVE + held-* leaves.
// (Excludes SPLIT internal nodes, PENDING_APPROVAL graded-but-not-approved, and all terminal/closed.)
const IN_WAREHOUSE_STATUSES: ReceiptStatus[] = [
  ReceiptStatus.ACTIVE,
  ...HELD_STATUSES,
];

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
        },
      }),
      this.prisma.warehouse.count({ where }),
    ]);

    // Per-row receipt count: root deposits only (parentReceiptId: null) — excludes
    // SPLIT internal nodes so the number matches "deposits made into this warehouse".
    const receiptCounts = warehouses.length
      ? await this.prisma.receipt.groupBy({
          by: ['warehouseId'],
          where: {
            tenantId,
            parentReceiptId: null,
            warehouseId: { in: warehouses.map((w) => w.id) },
          },
          _count: { _all: true },
        })
      : [];
    const countByWh = new Map(
      receiptCounts.map((r) => [r.warehouseId, r._count._all]),
    );
    const warehousesWithCount = warehouses.map((w) => ({
      ...w,
      _count: { receipts: countByWh.get(w.id) ?? 0 },
    }));

    // Aggregate stats
    const allWarehouses = await this.prisma.warehouse.findMany({
      where: { tenantId },
      select: { capacityMt: true, status: true },
    });
    const totalCapacityMt = allWarehouses.reduce(
      (s, w) => s + (w.capacityMt ?? 0),
      0,
    );

    // Total utilized: client-owned, physically-present quantity (ACTIVE + HELD_*).
    // Held receipts are still in the warehouse — just under a withdrawal/loan/trade lock.
    const utilizationAgg = await this.prisma.receipt.aggregate({
      where: { tenantId, status: { in: IN_WAREHOUSE_STATUSES } },
      _sum: { quantity: true },
    });
    const totalUtilizationMt = Number(utilizationAgg._sum.quantity ?? 0);

    return {
      stats: {
        totalWarehouses: allWarehouses.length,
        totalCapacityMt,
        totalUtilizationMt,
      },
      data: warehousesWithCount,
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

    // Summary stats — totals reflect what's *in the warehouse right now*
    // (client-owned, physically present): ACTIVE + HELD_*. SPLIT internal
    // nodes and terminal states are excluded everywhere.
    const [totalClients, totalReceipts, commodityAgg, billedFeeAgg] =
      await Promise.all([
        this.prisma.receipt
          .groupBy({
            by: ['clientId'],
            where: {
              warehouseId: id,
              tenantId,
              status: { in: IN_WAREHOUSE_STATUSES },
            },
          })
          .then((r) => r.length),
        // Root deposits made into this warehouse — matches the WM dashboard.
        this.prisma.receipt.count({
          where: { warehouseId: id, tenantId, parentReceiptId: null },
        }),
        this.prisma.receipt.aggregate({
          where: {
            warehouseId: id,
            tenantId,
            status: { in: IN_WAREHOUSE_STATUSES },
          },
          _sum: { quantity: true },
        }),
        // Total storage fee billed: sum of completed withdrawals' storageFee
        // for receipts in this warehouse. Drives the "Total Storage Fee" widget.
        this.prisma.withdrawal.aggregate({
          where: {
            tenantId,
            status: WithdrawalStatus.COMPLETED,
            receipt: { warehouseId: id },
          },
          _sum: { storageFee: true, totalFee: true },
        }),
      ]);

    const recentReceipts = await this.prisma.receipt.findMany({
      where: {
        warehouseId: id,
        tenantId,
        // Hide superseded internal nodes — they're not "receipts" the user issued.
        status: { notIn: [ReceiptStatus.SPLIT] },
      },
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
        totalCommodityMt: Number(commodityAgg._sum.quantity ?? 0),
        totalReceipts,
        totalStorageFee: Number(billedFeeAgg._sum.storageFee ?? 0),
        totalFeesBilled: Number(billedFeeAgg._sum.totalFee ?? 0),
        currency: 'NGN',
      },
      recentReceipts: recentReceipts.map((r) => ({
        ...r,
        group: deriveGroup(r),
      })),
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

    // Default: hide SPLIT internal nodes (superseded parents with children).
    // Accepts either the new group filter ('ACTIVE'|'LIENED'|'CANCELLED' aka 'PLEDGE')
    // or a raw ReceiptStatus value — matches WM's listCommodityReceipts contract.
    const where: any = {
      warehouseId,
      tenantId,
      status: { notIn: [ReceiptStatus.SPLIT] },
    };
    const s = (query.status ?? '').toUpperCase();
    if (s === 'ACTIVE')
      where.status = { in: statusesForGroup('ACTIVE') };
    else if (s === 'CANCELLED')
      where.status = { in: statusesForGroup('CANCELLED') };
    else if (s === 'LIENED' || s === 'PLEDGE')
      where.status = { in: statusesForGroup('LIENED') };
    else if (s && (ReceiptStatus as any)[s])
      where.status = s as ReceiptStatus;
    if (query.approvalStatus) where.approvalStatus = query.approvalStatus;

    const [receipts, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          commodity: { select: { name: true, unitOfMeasure: true } },
          warehouse: { select: { id: true, name: true, code: true } },
          client: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.receipt.count({ where }),
    ]);

    return {
      data: receipts.map((r) => ({ ...r, group: deriveGroup(r) })),
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
