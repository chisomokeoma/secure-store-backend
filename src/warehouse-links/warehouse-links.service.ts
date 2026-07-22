import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WarehouseLinkStatus } from '@prisma/client';

/**
 * Warehouse-onboarding lifecycle (Q3 = TA-approved).
 *
 * Flow:
 *   1. Financier user submits onboarding: uploads signed agreement PDF,
 *      picks a warehouse from `available` → row created with status=PENDING.
 *      Notification fires to all Tenant Admins.
 *   2. TA reviews in the Onboarding Requests queue, clicks Approve or
 *      Reject-with-reason.
 *      - Approve → status=ACTIVE, `signedAt` = now, `decidedBy` = TA.
 *        From now on the financier appears in the "financiers for this
 *        warehouse" dropdown for clients pledging at that warehouse.
 *      - Reject → status=OFFBOARDED with `decisionReason` capturing the
 *        rejection text. Semantic note: we deliberately fold "rejected"
 *        into OFFBOARDED because the FE enum only has three states
 *        (PENDING/ACTIVE/OFFBOARDED). A rejected onboarding shows in the
 *        financier's history as "Offboarded — <reason>". Financier can
 *        re-submit later; each submission is a fresh row.
 *   3. Financier can offboard an ACTIVE link at any time, but ONLY when
 *      no active liens exist in that warehouse for this financier
 *      (§3.2 in the spec; matches the FE offboard button being disabled
 *      when lienedValue > 0).
 *
 * Concurrency: two financier users of the same org clicking Onboard on
 * the same warehouse race — we handle with a pre-check + rely on the
 * app-level "no non-OFFBOARDED row exists" invariant. A stronger DB
 * constraint (partial unique index) is a v2 hardening.
 */
@Injectable()
export class WarehouseLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Guards the caller has an active FinancierOrg. Reused by all financier-
   * facing methods. Returns the resolved FinancierOrg for downstream use.
   */
  private async requireFinancierOrg(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        tenantId: true,
        financierOrg: {
          select: {
            id: true,
            name: true,
            status: true,
            licenseNumber: true,
            logoUrl: true,
            tenantId: true,
          },
        },
      },
    });
    if (!user?.financierOrg) {
      throw new ForbiddenException(
        'This account is not associated with a FinancierOrg',
      );
    }
    if (user.financierOrg.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: 'FINANCIER_ORG_SUSPENDED',
        message:
          'Your organisation is currently suspended. Please contact the tenant administrator.',
      });
    }
    return { financierOrg: user.financierOrg, tenantId: user.tenantId };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FINANCIER-FACING — /financier/warehouses/*
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Warehouses this financier could still onboard — everything in the
   * tenant MINUS warehouses where a PENDING or ACTIVE link already exists
   * for this org. OFFBOARDED links don't count (financier can re-onboard
   * a warehouse they previously offboarded).
   *
   * Response shape matches FE AvailableWarehouse[].
   */
  async listAvailableWarehouses(callerUserId: string) {
    const { financierOrg, tenantId } = await this.requireFinancierOrg(callerUserId);

    // Warehouses already engaged (PENDING or ACTIVE with this financier).
    const engagedLinks = await this.prisma.warehouseLink.findMany({
      where: {
        tenantId,
        financierOrgId: financierOrg.id,
        status: { in: ['PENDING', 'ACTIVE'] },
      },
      select: { warehouseId: true },
    });
    const engagedIds = new Set(engagedLinks.map((l) => l.warehouseId));

    const warehouses = await this.prisma.warehouse.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        ...(engagedIds.size > 0
          ? { id: { notIn: [...engagedIds] } }
          : {}),
      },
      select: {
        id: true,
        name: true,
        location: true,
        tenant: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });

    return warehouses.map((w) => ({
      id: w.id,
      name: w.name,
      location: w.location,
      tenantName: w.tenant.name,
    }));
  }

  /**
   * The financier's own warehouse links (all statuses, filtered).
   * Powers the FE Warehouses screen table.
   *
   * Includes placeholder null/zero counts for `totalStockValue`,
   * `lienedValue`, `clientCount` — Phase 4 fills these in from the
   * receipt / lien tables. FE already handles null gracefully per its
   * type declaration (all three fields are optional).
   */
  async listFinancierWarehouses(
    callerUserId: string,
    query: { status?: string; page?: string; limit?: string },
  ) {
    const { financierOrg, tenantId } = await this.requireFinancierOrg(callerUserId);
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const where: any = {
      tenantId,
      financierOrgId: financierOrg.id,
      ...(query.status ? { status: query.status } : {}),
    };

    const [links, total] = await Promise.all([
      this.prisma.warehouseLink.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          warehouse: { select: { id: true, name: true, location: true } },
        },
      }),
      this.prisma.warehouseLink.count({ where }),
    ]);

    return {
      items: links.map((l) => this.projectFinancierWarehouseLink(l)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Submit a warehouse onboarding request. Creates a PENDING link and
   * notifies all Tenant Admins (they need to approve).
   *
   * Guards:
   *   - Warehouse belongs to this tenant + is ACTIVE
   *   - No existing PENDING or ACTIVE link between this financier and this warehouse
   *   - agreementDocUrl provided (must have been uploaded via /storage/upload first)
   */
  async onboardWarehouse(
    callerUserId: string,
    warehouseId: string,
    agreementDocUrl: string,
  ) {
    const { financierOrg, tenantId } = await this.requireFinancierOrg(callerUserId);

    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, tenantId, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    if (!warehouse) {
      throw new NotFoundException(
        'Warehouse not found (or not active) in this tenant',
      );
    }

    // Duplicate-check. OFFBOARDED links don't block a fresh submission —
    // the financier is free to re-onboard a warehouse they previously exited.
    const clash = await this.prisma.warehouseLink.findFirst({
      where: {
        tenantId,
        financierOrgId: financierOrg.id,
        warehouseId,
        status: { in: ['PENDING', 'ACTIVE'] },
      },
      select: { id: true, status: true },
    });
    if (clash) {
      throw new ConflictException({
        code:
          clash.status === 'PENDING'
            ? 'WAREHOUSE_LINK_ALREADY_PENDING'
            : 'WAREHOUSE_LINK_ALREADY_ACTIVE',
        message:
          clash.status === 'PENDING'
            ? 'An onboarding request for this warehouse is already awaiting approval.'
            : 'This warehouse is already onboarded with your organisation.',
        existingLinkId: clash.id,
      });
    }

    const link = await this.prisma.warehouseLink.create({
      data: {
        tenantId,
        financierOrgId: financierOrg.id,
        warehouseId,
        status: 'PENDING',
        agreementDocUrl,
        createdById: callerUserId,
      },
      include: {
        warehouse: { select: { id: true, name: true, location: true } },
      },
    });

    // Fire notification to all TAs in the tenant. Best-effort — a
    // notifications outage must not fail the create.
    void this.notifications
      .notifyTenantAdmins(tenantId, {
        type: 'WAREHOUSE_LINK_REQUESTED',
        title: `${financierOrg.name} wants to onboard ${warehouse.name}`,
        body: `Review the signed agreement and approve or reject in the Onboarding Requests queue.`,
        relatedEntityType: 'warehouse_link',
        relatedEntityId: link.id,
      })
      .catch(() => undefined);

    return this.projectFinancierWarehouseLink(link);
  }

  /**
   * Financier initiates offboarding of one of their ACTIVE links.
   * Blocked (409) when any ACTIVE lien exists in the warehouse for this
   * financier — matches spec §3.2 and the FE's "offboard disabled when
   * lienedValue > 0" rule.
   */
  async offboardWarehouse(callerUserId: string, linkId: string) {
    const { financierOrg, tenantId } = await this.requireFinancierOrg(callerUserId);

    const link = await this.prisma.warehouseLink.findFirst({
      where: {
        id: linkId,
        financierOrgId: financierOrg.id,
        tenantId,
      },
    });
    if (!link) throw new NotFoundException('Warehouse link not found');
    if (link.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Cannot offboard a link in status ${link.status}`,
      );
    }

    // Block if any active lien exists in this warehouse for this financier.
    const activeLiens = await this.prisma.lien.count({
      where: {
        tenantId,
        financierOrgId: financierOrg.id,
        status: { in: ['ACTIVE', 'PARTIALLY_RELEASED'] },
        receipt: { warehouseId: link.warehouseId },
      },
    });
    if (activeLiens > 0) {
      throw new ConflictException({
        code: 'ACTIVE_LIENS_EXIST',
        message: `Cannot offboard: ${activeLiens} active lien(s) still exist in this warehouse. Release all liens first.`,
        activeLienCount: activeLiens,
      });
    }

    const updated = await this.prisma.warehouseLink.update({
      where: { id: linkId },
      data: {
        status: 'OFFBOARDED',
        decidedById: callerUserId,
        decidedAt: new Date(),
      },
      include: {
        warehouse: { select: { id: true, name: true, location: true } },
      },
    });

    return this.projectFinancierWarehouseLink(updated);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TA-FACING — /admin/warehouse-links/*
  // ═══════════════════════════════════════════════════════════════════════

  async listAdminWarehouseLinks(
    tenantId: string,
    query: { status?: string; page?: string; limit?: string },
  ) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const where: any = {
      tenantId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [links, total] = await Promise.all([
      this.prisma.warehouseLink.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          financierOrg: {
            select: {
              id: true,
              name: true,
              logoUrl: true,
              licenseNumber: true,
            },
          },
          warehouse: { select: { id: true, name: true, location: true } },
        },
      }),
      this.prisma.warehouseLink.count({ where }),
    ]);

    return {
      items: links.map((l) => this.projectAdminWarehouseLink(l)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async approveWarehouseLink(
    tenantId: string,
    adminUserId: string,
    linkId: string,
  ) {
    const link = await this.prisma.warehouseLink.findFirst({
      where: { id: linkId, tenantId },
      include: {
        financierOrg: { select: { id: true, name: true } },
        warehouse: { select: { id: true, name: true } },
      },
    });
    if (!link) throw new NotFoundException('Onboarding request not found');
    if (link.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot approve a link in status ${link.status}`,
      );
    }

    const updated = await this.prisma.warehouseLink.update({
      where: { id: linkId },
      data: {
        status: 'ACTIVE',
        signedAt: new Date(),
        decidedById: adminUserId,
        decidedAt: new Date(),
      },
      include: {
        financierOrg: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            licenseNumber: true,
          },
        },
        warehouse: { select: { id: true, name: true, location: true } },
      },
    });

    // Notify all financier-org users so their Warehouses screen refreshes
    // and they can start accepting pledges from that warehouse's clients.
    const financierUserIds = await this.prisma.user
      .findMany({
        where: { financierOrgId: link.financierOrg.id, status: 'ACTIVE' },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id));

    void Promise.all(
      financierUserIds.map((userId) =>
        this.notifications
          .notifyUser(userId, {
            tenantId,
            type: 'WAREHOUSE_LINK_APPROVED',
            title: `${link.warehouse.name} approved`,
            body: `Your onboarding request for ${link.warehouse.name} is now active. Clients can begin pledging receipts to you.`,
            relatedEntityType: 'warehouse_link',
            relatedEntityId: link.id,
          })
          .catch(() => undefined),
      ),
    );

    return this.projectAdminWarehouseLink(updated);
  }

  async rejectWarehouseLink(
    tenantId: string,
    adminUserId: string,
    linkId: string,
    reason: string,
  ) {
    const link = await this.prisma.warehouseLink.findFirst({
      where: { id: linkId, tenantId },
      include: {
        financierOrg: { select: { id: true, name: true } },
        warehouse: { select: { id: true, name: true } },
      },
    });
    if (!link) throw new NotFoundException('Onboarding request not found');
    if (link.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot reject a link in status ${link.status}`,
      );
    }

    // Rejection folds into OFFBOARDED per the FE's 3-status enum. The
    // decisionReason distinguishes "rejected by TA" from "financier
    // offboarded themselves" (which has no reason). If the FE ever wants
    // to render these differently, they can branch on
    // `decisionReason !== null && signedAt === null`.
    const updated = await this.prisma.warehouseLink.update({
      where: { id: linkId },
      data: {
        status: 'OFFBOARDED',
        decidedById: adminUserId,
        decidedAt: new Date(),
        decisionReason: reason,
      },
      include: {
        financierOrg: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            licenseNumber: true,
          },
        },
        warehouse: { select: { id: true, name: true, location: true } },
      },
    });

    const financierUserIds = await this.prisma.user
      .findMany({
        where: { financierOrgId: link.financierOrg.id, status: 'ACTIVE' },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id));

    void Promise.all(
      financierUserIds.map((userId) =>
        this.notifications
          .notifyUser(userId, {
            tenantId,
            type: 'WAREHOUSE_LINK_REJECTED',
            title: `${link.warehouse.name} onboarding rejected`,
            body: `Reason: ${reason}`,
            relatedEntityType: 'warehouse_link',
            relatedEntityId: link.id,
          })
          .catch(() => undefined),
      ),
    );

    return this.projectAdminWarehouseLink(updated);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PROJECTIONS
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Both projections match FE types in src/api/types/collateral.ts.
  // Phase 3 leaves totalStockValue / lienedValue / clientCount as null;
  // Phase 4 populates them from the receipts + liens tables.

  private projectFinancierWarehouseLink(l: {
    id: string;
    warehouse: { id: string; name: string; location: string };
    status: WarehouseLinkStatus;
    agreementDocUrl: string | null;
    signedAt: Date | null;
    decisionReason: string | null;
  }) {
    return {
      id: l.id,
      warehouse: {
        id: l.warehouse.id,
        name: l.warehouse.name,
        location: l.warehouse.location,
      },
      status: l.status,
      agreementDocUrl: l.agreementDocUrl,
      signedAt: l.signedAt,
      // TA rejection reasons surface here too, so a financier looking at
      // an OFFBOARDED link they didn't cause can see why.
      decisionReason: l.decisionReason,
      totalStockValue: null,
      lienedValue: null,
      clientCount: null,
    };
  }

  private projectAdminWarehouseLink(l: {
    id: string;
    financierOrg: {
      id: string;
      name: string;
      logoUrl: string | null;
      licenseNumber: string | null;
    };
    warehouse: { id: string; name: string; location: string };
    status: WarehouseLinkStatus;
    agreementDocUrl: string | null;
    decisionReason: string | null;
    createdAt: Date;
  }) {
    return {
      id: l.id,
      financier: {
        id: l.financierOrg.id,
        name: l.financierOrg.name,
        logoUrl: l.financierOrg.logoUrl,
        licenseNumber: l.financierOrg.licenseNumber,
      },
      warehouse: {
        id: l.warehouse.id,
        name: l.warehouse.name,
        location: l.warehouse.location,
      },
      status: l.status,
      agreementDocUrl: l.agreementDocUrl,
      decisionReason: l.decisionReason,
      createdAt: l.createdAt,
    };
  }
}
