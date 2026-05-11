import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserStatus, WarehouseStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AdminWarehouseService {
  constructor(private prisma: PrismaService) {}

  async getWarehouses(tenantId: string) {
    return this.prisma.warehouse.findMany({
      where: { tenantId },
      include: {
        managerAssignments: {
          include: {
            manager: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                status: true,
              },
            },
          },
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

  // --- Warehouse Manager User Management ---

  async getManagers(tenantId: string) {
    return this.prisma.user.findMany({
      where: {
        tenantId,
        roles: {
          some: { role: { name: 'WAREHOUSE_MANAGER' } },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phoneNumber: true,
        status: true,
        createdAt: true,
        managerAssignments: {
          where: { unassignedAt: null },
          include: {
            warehouse: { select: { id: true, name: true } },
          },
        },
      },
    });
  }

  async createManager(
    tenantId: string,
    dto: {
      email: string;
      firstName: string;
      lastName: string;
      password: string;
      phoneNumber?: string;
    },
  ) {
    // 1. Check if email already in use
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) throw new ConflictException('A user with this email already exists');

    // 2. Get WAREHOUSE_MANAGER role
    const managerRole = await this.prisma.role.findUnique({
      where: { name: 'WAREHOUSE_MANAGER' },
    });
    if (!managerRole) throw new BadRequestException('WAREHOUSE_MANAGER role not found. Ensure seed has been run.');

    // 3. Hash the password
    const hashedPassword = await bcrypt.hash(dto.password, 10);

    // 4. Create user with WAREHOUSE_MANAGER role
    return this.prisma.user.create({
      data: {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        password: hashedPassword,
        phoneNumber: dto.phoneNumber,
        tenantId,
        status: UserStatus.ACTIVE,
        roles: {
          create: {
            roleId: managerRole.id,
          },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phoneNumber: true,
        status: true,
        createdAt: true,
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

    // 2. Verify manager belongs to tenant and has the right role
    const manager = await this.prisma.user.findFirst({
      where: {
        id: managerId,
        tenantId,
        roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } },
      },
    });
    if (!manager) throw new NotFoundException('Warehouse Manager not found in this tenant');

    // 3. Check if already assigned to this warehouse
    const existing = await this.prisma.warehouseManagerAssignment.findFirst({
      where: { warehouseId, managerId, unassignedAt: null },
    });
    if (existing) throw new ConflictException('Manager is already assigned to this warehouse');

    // 4. Create assignment
    return this.prisma.warehouseManagerAssignment.create({
      data: { tenantId, warehouseId, managerId, assignedBy },
      include: {
        warehouse: { select: { id: true, name: true } },
        manager: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
  }

  async unassignManager(tenantId: string, warehouseId: string, managerId: string) {
    const assignment = await this.prisma.warehouseManagerAssignment.findFirst({
      where: { warehouseId, managerId, tenantId, unassignedAt: null },
    });
    if (!assignment) throw new NotFoundException('Active assignment not found');

    return this.prisma.warehouseManagerAssignment.update({
      where: { id: assignment.id },
      data: { unassignedAt: new Date() },
    });
  }
}
