import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WarehouseStatus } from '@prisma/client';

@Injectable()
export class AdminWarehouseService {
  constructor(private prisma: PrismaService) {}

  async getWarehouses(tenantId: string) {
    return this.prisma.warehouse.findMany({
      where: { tenantId },
      include: {
        managerAssignments: {
          include: { manager: true },
          where: { unassignedAt: null },
        },
      },
    });
  }

  async createWarehouse(
    tenantId: string,
    dto: {
      name: string;
      location: string;
      code?: string;
      capacityMt?: number;
    },
  ) {
    return this.prisma.warehouse.create({
      data: {
        ...dto,
        tenantId,
        status: WarehouseStatus.ACTIVE,
      },
    });
  }

  async assignManager(
    tenantId: string,
    warehouseId: string,
    managerId: string,
    assignedBy: string,
  ) {
    // 1. Verify warehouse belongs to tenant
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, tenantId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    // 2. Verify manager belongs to tenant
    const manager = await this.prisma.user.findFirst({
      where: { id: managerId, tenantId },
    });
    if (!manager) throw new NotFoundException('Manager not found');

    // 3. Create assignment
    return this.prisma.warehouseManagerAssignment.create({
      data: {
        tenantId,
        warehouseId,
        managerId,
        assignedBy,
      },
    });
  }
}
