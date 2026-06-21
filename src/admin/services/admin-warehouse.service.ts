import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';
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
                  profilePhotoUrl: true,
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
                profilePhotoUrl: true,
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

  // ─── COMMODITIES FOR A WAREHOUSE ────────────────────────────────────────────

  /**
   * The commodities explicitly LINKED to this warehouse — i.e. the ones the
   * warehouse is configured to accept deposits for. Sibling of
   * `getWarehouseReceipts` and `getWarehouseManagers`; same pattern.
   *
   * NOT the same as the tenant-wide list at `GET /admin/grading/commodities`
   * — that one returns every commodity the tenant has defined, regardless
   * of warehouse. Use that endpoint to populate a "pick a commodity to
   * link" dropdown; use THIS endpoint to render the "Commodities linked
   * to this warehouse" card.
   *
   * Shape: a flat list of commodities (not the join rows). `linkedAt`
   * surfaces when each commodity was linked, which the UI can use to show
   * "added X days ago" if that ever becomes useful.
   */
  async getWarehouseCommodities(tenantId: string, warehouseId: string) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, tenantId },
      select: { id: true },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    const links = await this.prisma.warehouseCommodity.findMany({
      where: { warehouseId, tenantId },
      include: {
        commodity: {
          select: {
            id: true,
            name: true,
            code: true,
            description: true,
            unitOfMeasure: true,
            standardBagWeightKg: true,
            gradingLogic: true,
            numberOfGrades: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return links.map((l) => ({
      ...l.commodity,
      linkedAt: l.createdAt,
      // Legacy per-link storage-fee column on WarehouseCommodity. Kept on
      // the response so callers that still read it don't break; the
      // authoritative fee policy is on StorageFeePolicy now.
      legacyStorageFeePerUnit: l.storageFeePerUnit,
    }));
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
            profilePhotoUrl: true,
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
      // Force a password rotation on the next warehouse sign-in. Per spec:
      // every new inheritance triggers a rotation, so the prior team's
      // shared credential is invalidated.
      await this.prisma.warehouse.update({
        where: { id: warehouseId },
        data: { mustChangePassword: true },
      });
    }

    return {
      assigned: newIds.length,
      alreadyAssigned: managerIds.length - newIds.length,
    };
  }

  // ─── WAREHOUSE CREDENTIAL (admin-controlled) ───────────────────────────────

  /**
   * Set the shared warehouse email + initial password. Admin-only. Returns
   * the temp password ONCE so the admin can hand it off to the manager
   * (same one-shot pattern as client creation). After this call the
   * warehouse is loggable via POST /auth/warehouse-login.
   *
   * Idempotent on email: passing the same email a second time just resets
   * the password (effectively a forced rotation). Use this for both initial
   * setup and out-of-band recovery.
   */
  async setWarehouseCredentials(
    tenantId: string,
    warehouseId: string,
    args: { email: string; password?: string },
  ) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, tenantId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    const email = args.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('A valid email address is required.');
    }
    // Email must be unique across warehouses (and shouldn't collide with a
    // user login — they're different identity spaces, but reusing the same
    // address is confusing).
    const taken = await this.prisma.warehouse.findFirst({
      where: { email, NOT: { id: warehouseId } },
      select: { id: true },
    });
    if (taken) {
      throw new BadRequestException(
        'That email is already in use by another warehouse.',
      );
    }

    const password = args.password ?? this.generateInitialPassword();
    const hash = await bcrypt.hash(password, 10);

    await this.prisma.warehouse.update({
      where: { id: warehouseId },
      data: {
        email,
        passwordHash: hash,
        passwordSetAt: new Date(),
        // Whether this is initial setup or a rotation, the next manager
        // sign-in must change the password.
        mustChangePassword: true,
      },
    });

    return {
      success: true,
      message:
        'Warehouse credentials set. The next sign-in will require a password change.',
      // Returned ONCE — the admin must record/relay it before leaving the page.
      credentials: { email, initialPassword: password },
    };
  }

  /**
   * Force a password rotation without resetting the email — generates a
   * new initial password (one-shot return) and flips mustChangePassword.
   * Useful for "I think the previous manager still knows the password".
   */
  async resetWarehousePassword(tenantId: string, warehouseId: string) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, tenantId },
      select: { id: true, email: true },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    if (!warehouse.email) {
      throw new BadRequestException(
        'Set a warehouse email first via PATCH /admin/warehouses/:id/credentials.',
      );
    }
    const password = this.generateInitialPassword();
    const hash = await bcrypt.hash(password, 10);
    await this.prisma.warehouse.update({
      where: { id: warehouseId },
      data: {
        passwordHash: hash,
        passwordSetAt: new Date(),
        mustChangePassword: true,
      },
    });
    return {
      success: true,
      message:
        'Warehouse password reset. The next sign-in will require a password change.',
      credentials: { email: warehouse.email, initialPassword: password },
    };
  }

  private generateInitialPassword(): string {
    // 10-char temp password: at least one upper, one lower, one digit, one
    // symbol — enough to satisfy the warehouse-auth strength check on first
    // login.
    const sets = [
      'ABCDEFGHJKLMNPQRSTUVWXYZ',
      'abcdefghjkmnpqrstuvwxyz',
      '23456789',
      '!@#$%&',
    ];
    const all = sets.join('');
    const pick = (s: string) => s[randomInt(s.length)];
    return (
      pick(sets[0]) +
      pick(sets[1]) +
      pick(sets[2]) +
      pick(sets[3]) +
      Array.from({ length: 6 }, () => pick(all)).join('')
    );
  }
}
