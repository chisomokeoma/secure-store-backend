import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserStatus } from '@prisma/client';
import { statusesForGroup } from '../inventory/inventory.types';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import {
  CreateManagerDto,
  UpdateManagerDto,
  AssignWarehousesDto,
} from './dto/manager.dto';

@Injectable()
export class ManagersService {
  constructor(private prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────

  /** Derives platform login email: firstname.lastname@securestore.com with collision suffix */
  private async deriveLoginEmail(
    firstName: string,
    lastName: string,
  ): Promise<string> {
    const base = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`.replace(
      /\s+/g,
      '',
    );
    const domain = 'securestore.com';
    const candidate = `${base}@${domain}`;

    const existing = await this.prisma.user.findUnique({
      where: { email: candidate },
    });
    if (!existing) return candidate;

    // Suffix collision resolution
    for (let i = 2; i <= 99; i++) {
      const suffixed = `${base}${i}@${domain}`;
      const conflict = await this.prisma.user.findUnique({
        where: { email: suffixed },
      });
      if (!conflict) return suffixed;
    }
    throw new ConflictException(
      'Cannot generate a unique login email for this name combination',
    );
  }

  /** Generates a secure 12-char temp password: mixed case + digits + symbol */
  private generateTempPassword(): string {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghjkmnpqrstuvwxyz';
    const digits = '23456789';
    const symbols = '!@#$%&';
    const all = upper + lower + digits + symbols;

    const pick = (chars: string) => chars[crypto.randomInt(chars.length)];
    const rest = Array.from({ length: 8 }, () => pick(all)).join('');
    return pick(upper) + pick(lower) + pick(digits) + pick(symbols) + rest;
  }

  /** Generates MNG-YYYY-XXXX manager code */
  private async generateManagerCode(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await this.prisma.user.count({
      where: { roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } } },
    });
    return `MNG-${year}-${String(count + 1).padStart(4, '0')}`;
  }

  // ─────────────────────────────────────────────────────────────
  // READ
  // ─────────────────────────────────────────────────────────────

  async getManagers(
    tenantId: string,
    query: { status?: string; search?: string; page?: string; limit?: string },
  ) {
    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const skip = (page - 1) * limit;

    const where: any = {
      tenantId,
      roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } },
    };

    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { managerCode: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [managers, total, activeCount, inactiveCount] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          middleName: true,
          phoneNumber: true,
          managerCode: true,
          profilePhotoUrl: true,
          status: true,
          createdAt: true,
          managerAssignments: {
            where: { unassignedAt: null },
            include: {
              warehouse: { select: { id: true, name: true, code: true } },
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: { ...where, status: 'ACTIVE' } }),
      this.prisma.user.count({
        where: {
          ...where,
          status: { in: ['INACTIVE', 'DEACTIVATED', 'SUSPENDED'] },
        },
      }),
    ]);

    return {
      stats: { total, active: activeCount, inactive: inactiveCount },
      data: managers,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getManagerById(tenantId: string, id: string) {
    const manager = await this.prisma.user.findFirst({
      where: {
        id,
        tenantId,
        roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        middleName: true,
        gender: true,
        dateOfBirth: true,
        residentialAddress: true,
        phoneNumber: true,
        contactEmail: true,
        employmentDate: true,
        profilePhotoUrl: true,
        managerCode: true,
        status: true,
        permissions: true,
        notificationPrefs: true,
        createdAt: true,
        managerAssignments: {
          where: { unassignedAt: null },
          include: {
            warehouse: {
              select: {
                id: true,
                name: true,
                code: true,
                location: true,
                capacityMt: true,
              },
            },
          },
        },
      },
    });
    if (!manager) throw new NotFoundException('Manager not found');

    // ── Aggregate stats for the portfolio cards ───────────────────────────
    // The TA's "Manager portfolio" page shows three KPI cards: Total Clients,
    // Active Clients, Assigned Warehouses. Without these the first two cards
    // render as "—". `assignedWarehouses` the FE could derive from
    // managerAssignments.length, but emitting it here keeps the contract
    // explicit and lets the FE bind to a single `stats` block.
    //
    // The scope: any client with at least one receipt in any warehouse this
    // manager currently oversees. "Active" means at least one receipt whose
    // status is in the ACTIVE group (ACTIVE / HELD_* in-warehouse states).
    // SPLIT internal nodes are deliberately excluded by the status filter.
    const warehouseIds = manager.managerAssignments.map((a) => a.warehouseId);
    let totalClients = 0;
    let activeClients = 0;
    if (warehouseIds.length > 0) {
      const [t, a] = await Promise.all([
        this.prisma.user.count({
          where: {
            tenantId,
            receipts: { some: { warehouseId: { in: warehouseIds } } },
          },
        }),
        this.prisma.user.count({
          where: {
            tenantId,
            receipts: {
              some: {
                warehouseId: { in: warehouseIds },
                status: { in: statusesForGroup('ACTIVE') },
              },
            },
          },
        }),
      ]);
      totalClients = t;
      activeClients = a;
    }

    return {
      ...manager,
      stats: {
        totalClients,
        activeClients,
        assignedWarehouses: warehouseIds.length,
      },
    };
  }

  async getManagerWarehouses(tenantId: string, id: string) {
    const manager = await this.prisma.user.findFirst({
      where: { id, tenantId },
    });
    if (!manager) throw new NotFoundException('Manager not found');

    return this.prisma.warehouseManagerAssignment.findMany({
      where: { managerId: id, tenantId, unassignedAt: null },
      include: {
        warehouse: {
          include: {
            _count: { select: { receipts: true } },
          },
        },
      },
    });
  }

  async getManagerClients(
    tenantId: string,
    id: string,
    query: { status?: string; page?: string; limit?: string },
  ) {
    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const skip = (page - 1) * limit;

    const manager = await this.prisma.user.findFirst({
      where: { id, tenantId },
    });
    if (!manager) throw new NotFoundException('Manager not found');

    // Get warehouse IDs this manager currently manages
    const assignments = await this.prisma.warehouseManagerAssignment.findMany({
      where: { managerId: id, tenantId, unassignedAt: null },
      select: { warehouseId: true },
    });
    const warehouseIds = assignments.map((a) => a.warehouseId);

    if (warehouseIds.length === 0) {
      return { data: [], meta: { page, limit, total: 0, totalPages: 0 } };
    }

    // Transitive query: clients whose receipts are in these warehouses
    const where: any = {
      tenantId,
      receipts: {
        some: { warehouseId: { in: warehouseIds } },
      },
    };
    if (query.status) where.status = query.status;

    const [clients, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          status: true,
          // Surface the clientProfile's identifiers — the FE's "Client ID"
          // column expects clientCode (e.g. CLT-2026-0001) and the "Type"
          // column expects ClientType (TRADER / MILLER / etc.). These don't
          // live on User; they live on ClientProfile.
          clientProfile: {
            select: { clientCode: true, type: true },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    // ── Per-client aggregates, SCOPED to this manager's warehouses ────────
    // The previous code returned `_count.receipts` which counted every
    // receipt the client had ever owned, tenant-wide — wrong here, since
    // a manager portfolio only cares about activity in *their* warehouses.
    // We do one groupBy per page to attach receipts in scope per client.
    //
    // - receiptCount: how many receipts in this manager's warehouses
    // - totalQuantityMt: sum of receipt.quantity (unit-mixed; see the
    //   commodityMovement comment for why this is acceptable here — the
    //   column is just an order-of-magnitude indicator, not a measurement).
    //   `Mt` in the field name matches the FE table header "Weight (MT)";
    //   for non-metric-ton commodities the raw quantity passes through.
    // - lastDepositAt: max receipt.createdAt, scoped.
    //
    // Outstanding fee is left as `null` for now — accurate computation
    // requires the storage-fee policy lookup per receipt plus
    // (today - depositDate) * rate * quantity, which we can layer in later
    // without breaking this shape (just flip null → number when ready).
    const clientIds = clients.map((c) => c.id);
    const aggMap = new Map<
      string,
      { receiptCount: number; totalQuantityMt: number; lastDepositAt: Date | null }
    >();
    if (clientIds.length > 0) {
      const aggs = await this.prisma.receipt.groupBy({
        by: ['clientId'],
        where: {
          clientId: { in: clientIds },
          warehouseId: { in: warehouseIds },
          tenantId,
        },
        _count: { _all: true },
        _sum: { quantity: true },
        _max: { createdAt: true },
      });
      for (const a of aggs) {
        aggMap.set(a.clientId, {
          receiptCount: a._count._all,
          totalQuantityMt: Number(a._sum.quantity ?? 0),
          lastDepositAt: a._max.createdAt,
        });
      }
    }

    const data = clients.map((c) => {
      const agg = aggMap.get(c.id);
      return {
        id: c.id,
        // Discrete name parts (for split rendering) + combined name (for
        // single-string columns), same shape conventions as the rest of
        // the codebase.
        firstName: c.firstName,
        lastName: c.lastName,
        name: `${c.firstName} ${c.lastName}`,
        email: c.email,
        status: c.status,
        clientCode: c.clientProfile?.clientCode ?? null,
        type: c.clientProfile?.type ?? null,
        receiptCount: agg?.receiptCount ?? 0,
        totalQuantityMt: agg?.totalQuantityMt ?? 0,
        lastDepositAt: agg?.lastDepositAt ?? null,
        outstandingFee: null,
      };
    });

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // CREATE
  // ─────────────────────────────────────────────────────────────

  async createManager(tenantId: string, dto: CreateManagerDto) {
    const { personalInfo, accountSetup, warehouseIds = [] } = dto;

    // 1. Get WAREHOUSE_MANAGER role
    const managerRole = await this.prisma.role.findUnique({
      where: { name: 'WAREHOUSE_MANAGER' },
    });
    if (!managerRole)
      throw new BadRequestException(
        'WAREHOUSE_MANAGER role not configured. Run seed.',
      );

    // 2. Auto-generate email, password, manager code
    const loginEmail = await this.deriveLoginEmail(
      personalInfo.firstName,
      personalInfo.lastName,
    );
    const tempPassword = this.generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    const managerCode = await this.generateManagerCode();

    // 3. Validate warehouse IDs belong to tenant
    if (warehouseIds.length > 0) {
      const warehouses = await this.prisma.warehouse.findMany({
        where: { id: { in: warehouseIds }, tenantId },
      });
      if (warehouses.length !== warehouseIds.length) {
        throw new BadRequestException(
          'One or more warehouse IDs are invalid or do not belong to this tenant',
        );
      }
    }

    // 4. Atomic transaction: create user + role + warehouse assignments
    const manager = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: loginEmail,
          password: hashedPassword,
          firstName: personalInfo.firstName,
          middleName: personalInfo.middleName,
          lastName: personalInfo.lastName,
          gender: personalInfo.gender,
          dateOfBirth: personalInfo.dateOfBirth
            ? new Date(personalInfo.dateOfBirth)
            : undefined,
          residentialAddress: personalInfo.residentialAddress,
          phoneNumber: personalInfo.phoneNumber,
          contactEmail: personalInfo.contactEmail,
          employmentDate: personalInfo.employmentDate
            ? new Date(personalInfo.employmentDate)
            : undefined,
          profilePhotoUrl: personalInfo.profilePhotoUrl,
          managerCode,
          tenantId,
          status: UserStatus.ACTIVE,
          permissions: (accountSetup?.permissions ?? {
            manageClients: true,
            manageReceipts: true,
            viewReports: true,
            approveDeposit: true,
          }) as any,
          notificationPrefs: (accountSetup?.notificationPrefs ?? {
            email: true,
            sms: true,
            inApp: true,
          }) as any,
          roles: {
            create: { roleId: managerRole.id },
          },
        },
      });

      // Create warehouse assignments
      if (warehouseIds.length > 0) {
        await tx.warehouseManagerAssignment.createMany({
          data: warehouseIds.map((wId) => ({
            tenantId,
            warehouseId: wId,
            managerId: user.id,
            assignedBy: user.id, // self-assigned via admin creation
          })),
        });
      }

      return user;
    });

    // 5. Fetch assigned warehouses for response
    const assignedWarehouses =
      await this.prisma.warehouseManagerAssignment.findMany({
        where: { managerId: manager.id, unassignedAt: null },
        include: { warehouse: { select: { id: true, name: true } } },
      });

    return {
      manager: {
        id: manager.id,
        managerCode: manager.managerCode,
        firstName: manager.firstName,
        lastName: manager.lastName,
        email: manager.email,
        status: manager.status,
        assignedWarehouses: assignedWarehouses.map((a) => a.warehouse),
      },
      credentials: {
        email: loginEmail,
        temporaryPassword: tempPassword,
        loginUrl: 'https://secure-store-indol.vercel.app/sign-in',
      },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // UPDATE & STATUS
  // ─────────────────────────────────────────────────────────────

  async updateManager(tenantId: string, id: string, dto: UpdateManagerDto) {
    const manager = await this.prisma.user.findFirst({
      where: {
        id,
        tenantId,
        roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } },
      },
    });
    if (!manager) throw new NotFoundException('Manager not found');

    const info = dto.personalInfo ?? {};
    return this.prisma.user.update({
      where: { id },
      data: {
        firstName: info.firstName,
        middleName: info.middleName,
        lastName: info.lastName,
        gender: info.gender,
        dateOfBirth: info.dateOfBirth ? new Date(info.dateOfBirth) : undefined,
        residentialAddress: info.residentialAddress,
        phoneNumber: info.phoneNumber,
        contactEmail: info.contactEmail,
        employmentDate: info.employmentDate
          ? new Date(info.employmentDate)
          : undefined,
        profilePhotoUrl: info.profilePhotoUrl,
        permissions: (dto.accountSetup?.permissions as any) ?? undefined,
        notificationPrefs:
          (dto.accountSetup?.notificationPrefs as any) ?? undefined,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        managerCode: true,
        profilePhotoUrl: true,
        status: true,
        updatedAt: true,
      },
    });
  }

  private async setManagerStatus(
    tenantId: string,
    id: string,
    status: UserStatus,
  ) {
    const manager = await this.prisma.user.findFirst({
      where: {
        id,
        tenantId,
        roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } },
      },
    });
    if (!manager) throw new NotFoundException('Manager not found');
    return this.prisma.user.update({ where: { id }, data: { status } });
  }

  async activateManager(tenantId: string, id: string) {
    return this.setManagerStatus(tenantId, id, UserStatus.ACTIVE);
  }

  async deactivateManager(tenantId: string, id: string) {
    return this.setManagerStatus(tenantId, id, UserStatus.DEACTIVATED);
  }

  async suspendManager(tenantId: string, id: string) {
    return this.setManagerStatus(tenantId, id, UserStatus.SUSPENDED);
  }

  // ─────────────────────────────────────────────────────────────
  // WAREHOUSE ASSIGNMENT
  // ─────────────────────────────────────────────────────────────

  async assignWarehouses(
    tenantId: string,
    managerId: string,
    dto: AssignWarehousesDto,
    assignedBy: string,
  ) {
    const manager = await this.prisma.user.findFirst({
      where: { id: managerId, tenantId },
    });
    if (!manager) throw new NotFoundException('Manager not found');

    // Validate warehouses
    const warehouses = await this.prisma.warehouse.findMany({
      where: { id: { in: dto.warehouseIds }, tenantId },
    });
    if (warehouses.length !== dto.warehouseIds.length) {
      throw new BadRequestException('One or more warehouse IDs are invalid');
    }

    // Additive + idempotent: only create assignments that don't already exist
    const existing = await this.prisma.warehouseManagerAssignment.findMany({
      where: { managerId, tenantId, unassignedAt: null },
      select: { warehouseId: true },
    });
    const existingIds = new Set(existing.map((e) => e.warehouseId));
    const newIds = dto.warehouseIds.filter((id) => !existingIds.has(id));

    if (newIds.length > 0) {
      await this.prisma.warehouseManagerAssignment.createMany({
        data: newIds.map((warehouseId) => ({
          tenantId,
          warehouseId,
          managerId,
          assignedBy,
        })),
      });
    }

    return {
      assigned: newIds.length,
      alreadyAssigned: dto.warehouseIds.length - newIds.length,
    };
  }

  async unassignWarehouse(
    tenantId: string,
    managerId: string,
    warehouseId: string,
  ) {
    const assignment = await this.prisma.warehouseManagerAssignment.findFirst({
      where: { managerId, warehouseId, tenantId, unassignedAt: null },
    });
    if (!assignment) throw new NotFoundException('Active assignment not found');

    return this.prisma.warehouseManagerAssignment.update({
      where: { id: assignment.id },
      data: { unassignedAt: new Date() },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // PASSWORD RESET
  // ─────────────────────────────────────────────────────────────

  async resetPassword(tenantId: string, id: string) {
    const manager = await this.prisma.user.findFirst({
      where: {
        id,
        tenantId,
        roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } },
      },
    });
    if (!manager) throw new NotFoundException('Manager not found');

    const tempPassword = this.generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    await this.prisma.user.update({
      where: { id },
      data: { password: hashedPassword },
    });

    return {
      credentials: {
        email: manager.email,
        temporaryPassword: tempPassword,
        loginUrl: 'https://secure-store-indol.vercel.app/sign-in',
      },
    };
  }
}
