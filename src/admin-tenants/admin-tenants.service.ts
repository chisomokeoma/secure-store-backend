import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommodityPricesService } from '../commodity-prices/commodity-prices.service';
import {
  CreateTenantDto,
  SuspendTenantDto,
} from './dto/admin-tenants.dto';
import {
  LienStatus,
  Prisma,
  TenantStatus,
  TenantType,
  UserStatus,
} from '@prisma/client';
import { sumInMt } from '../common/unit-conversion';

/**
 * Global-Admin surface for managing tenants (institutions).
 *
 * Matches the FE's adminGlobalRoutes contract in
 * src/api/endpoints/admin-global.ts:
 *   GET    /admin/tenants
 *   POST   /admin/tenants               (creates org + first TA in one step)
 *   GET    /admin/tenants/:id           (rich detail with commercial rollups)
 *   POST   /admin/tenants/:id/suspend
 *   POST   /admin/tenants/:id/reactivate
 *   GET    /admin/tenants/:id/managers  (read-only drill-down)
 *   GET    /admin/tenants/:id/warehouses
 *
 * A tenant is created together with its first TENANT_ADMIN so someone
 * can sign in the moment the org is onboarded (chicken-and-egg fix).
 * Invite pattern mirrors ManagersService / FinancierOrgsService: server
 * derives a system-issued alias, generates a 12-char temp password,
 * emails both to the admin's real inbox, and echoes the credentials in
 * the response as a hand-off fallback.
 */
@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
    private readonly commodityPrices: CommodityPricesService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────

  private async deriveLoginEmail(firstName: string, lastName: string) {
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

  private generateTempPassword(): string {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghjkmnpqrstuvwxyz';
    const digits = '23456789';
    const symbols = '!@#$%&';
    const all = upper + lower + digits + symbols;
    const pick = (chars: string) => chars[randomInt(chars.length)];
    const rest = Array.from({ length: 8 }, () => pick(all)).join('');
    return pick(upper) + pick(lower) + pick(digits) + pick(symbols) + rest;
  }

  private async requireTenantAdminRole() {
    const role = await this.prisma.role.findUnique({
      where: { name: 'TENANT_ADMIN' },
    });
    if (!role) {
      throw new BadRequestException(
        'TENANT_ADMIN role not configured. Run seed.',
      );
    }
    return role;
  }

  /**
   * URL-safe slug from a name. Lowercase, dashes, single-run of dashes,
   * no leading/trailing dashes. Falls back to a random suffix if the
   * derived slug clashes with an existing tenant.
   */
  private async deriveSlug(name: string): Promise<string> {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (!base) {
      throw new BadRequestException(
        'Cannot derive slug from name — please supply one explicitly',
      );
    }
    let candidate = base;
    let suffix = 2;
    while (
      await this.prisma.tenant.findUnique({ where: { slug: candidate } })
    ) {
      candidate = `${base}-${suffix++}`;
      if (suffix > 99) {
        throw new ConflictException({
          code: 'TENANT_SLUG_TAKEN',
          field: 'slug',
          message: `Could not derive a unique slug from "${name}". Please supply one.`,
        });
      }
    }
    return candidate;
  }

  private fireInvite(args: {
    tenantId: string;
    userId: string;
    firstName: string;
    realEmail: string;
    loginEmail: string;
    tempPassword: string;
    tenantName: string;
  }) {
    const signInUrl =
      (process.env.FRONTEND_URL ?? 'http://localhost:3001').replace(
        /\/+$/,
        '',
      ) + '/login';
    void this.email
      .sendWelcomeEmail({
        to: args.realEmail,
        firstName: args.firstName,
        loginEmail: args.loginEmail,
        tempPassword: args.tempPassword,
        clientCode: args.tenantName,
        signInUrl,
      })
      .catch(() => undefined);
    void this.notifications
      .notifyUser(args.userId, {
        tenantId: args.tenantId,
        type: 'CLIENT_CREDENTIALS_ISSUED',
        title: `Welcome to SecureStore — your ${args.tenantName} admin account is live`,
        body: `Sign in with ${args.loginEmail} and rotate your temporary password on first entry.`,
        relatedEntityType: 'tenant',
        relatedEntityId: args.tenantId,
      })
      .catch(() => undefined);
  }

  // ─── Create ─────────────────────────────────────────────────────────────

  async createTenant(dto: CreateTenantDto) {
    // 1. Global name uniqueness first (409 with structured code).
    const nameClash = await this.prisma.tenant.findFirst({
      where: { name: dto.name },
    });
    if (nameClash) {
      throw new ConflictException({
        code: 'TENANT_NAME_TAKEN',
        field: 'name',
        message: `A tenant named "${dto.name}" already exists`,
      });
    }

    // 2. Slug — either validate the caller's or derive one that's unique.
    let slug: string;
    if (dto.slug) {
      const clash = await this.prisma.tenant.findUnique({
        where: { slug: dto.slug },
      });
      if (clash) {
        throw new ConflictException({
          code: 'TENANT_SLUG_TAKEN',
          field: 'slug',
          message: `The slug "${dto.slug}" is already in use`,
        });
      }
      slug = dto.slug;
    } else {
      slug = await this.deriveSlug(dto.name);
    }

    // 3. First-admin credentials.
    const taRole = await this.requireTenantAdminRole();
    const loginEmail = await this.deriveLoginEmail(
      dto.firstAdmin.firstName,
      dto.firstAdmin.lastName,
    );
    const tempPassword = this.generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // 4. Atomic transaction: tenant + first admin + role linkage.
    const { tenant, user } = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: dto.name,
          slug,
          contactEmail: dto.contactEmail,
          phoneNumber: dto.phoneNumber,
          address: dto.address,
          logoUrl: dto.logoUrl ?? null,
          status: TenantStatus.ACTIVE,
          type: dto.type ?? TenantType.EXTERNAL,
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: loginEmail,
          password: hashedPassword,
          firstName: dto.firstAdmin.firstName,
          lastName: dto.firstAdmin.lastName,
          contactEmail: dto.firstAdmin.email,
          status: UserStatus.ACTIVE,
          roles: { create: { roleId: taRole.id } },
        },
      });
      return { tenant, user };
    });

    this.fireInvite({
      tenantId: tenant.id,
      userId: user.id,
      firstName: user.firstName,
      realEmail: user.contactEmail!,
      loginEmail,
      tempPassword,
      tenantName: tenant.name,
    });

    // 5. Emit tenant.created activity so the GA System Activity feed
    //    picks it up. Best-effort — a log write failure doesn't roll
    //    back the create.
    void this.prisma.activityLog
      .create({
        data: {
          tenantId: tenant.id,
          userId: null,
          action: 'tenant.created',
          entityType: 'TENANT',
          entityId: tenant.id,
          description: `${tenant.name} was onboarded`,
          metadata: {
            severity: 'INFO',
            slug: tenant.slug,
            firstAdmin: {
              userId: user.id,
              name: `${user.firstName} ${user.lastName}`,
            },
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    const item = await this.loadAdminItem(tenant.id);
    return {
      tenant: item,
      credentials: {
        email: loginEmail,
        temporaryPassword: tempPassword,
      },
    };
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  async listTenants(query: {
    search?: string;
    status?: string;
    page?: string;
    limit?: string;
  }) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.tenant.count({ where }),
    ]);

    // Row-level counts. We batch these rather than doing them inside the
    // findMany() as _count filters, because we need to gate on role
    // (WAREHOUSE_MANAGER / CLIENT) not just "any user."
    const items = await Promise.all(
      rows.map(async (t) => this.projectAdminItem(t)),
    );

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getTenantDetail(id: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tenant not found');
    const base = await this.projectAdminItem(t);

    // Commercial rollups: receipts + active liens + market values.
    const [receiptCount, activeLienCount, activeLiens, receiptsSum] =
      await Promise.all([
        this.prisma.receipt.count({ where: { tenantId: id } }),
        this.prisma.lien.count({
          where: {
            tenantId: id,
            status: {
              in: [LienStatus.ACTIVE, LienStatus.PARTIALLY_RELEASED],
            },
          },
        }),
        this.prisma.lien.findMany({
          where: {
            tenantId: id,
            status: {
              in: [LienStatus.ACTIVE, LienStatus.PARTIALLY_RELEASED],
            },
          },
          select: {
            remainingQuantity: true,
            receipt: {
              select: { commodityId: true },
            },
          },
        }),
        // Sum ACTIVE receipt quantities, grouped by commodity, for stored-
        // value valuation. HELD_* receipts are still stored, so include
        // them; SPLIT nodes are excluded.
        this.prisma.receipt.groupBy({
          by: ['commodityId'],
          where: {
            tenantId: id,
            status: {
              notIn: ['SPLIT', 'WITHDRAWN', 'TRADED_OUT', 'SEIZED', 'EXPIRED', 'CANCELLED'],
            },
          },
          _sum: { quantity: true },
        }),
      ]);

    // Batch commodity-price lookups (one per unique commodityId).
    const commodityIds = new Set<string>();
    for (const g of receiptsSum) commodityIds.add(g.commodityId);
    for (const l of activeLiens) commodityIds.add(l.receipt.commodityId);
    const priceMap = new Map<
      string,
      { pricePerUnit: Prisma.Decimal; currency: string }
    >();
    for (const cid of commodityIds) {
      const p = await this.commodityPrices.currentPrice(id, cid);
      if (p) {
        priceMap.set(cid, {
          pricePerUnit: p.pricePerUnit,
          currency: p.currency,
        });
      }
    }

    let storedValue = new Prisma.Decimal(0);
    let currency = 'NGN';
    for (const g of receiptsSum) {
      const p = priceMap.get(g.commodityId);
      if (!p) continue;
      storedValue = storedValue.add(
        p.pricePerUnit.mul(g._sum.quantity ?? 0),
      );
      currency = p.currency;
    }
    let lienedValue = new Prisma.Decimal(0);
    for (const l of activeLiens) {
      const p = priceMap.get(l.receipt.commodityId);
      if (!p) continue;
      lienedValue = lienedValue.add(p.pricePerUnit.mul(l.remainingQuantity));
    }

    return {
      ...base,
      contactEmail: t.contactEmail,
      phoneNumber: t.phoneNumber,
      address: t.address,
      receiptCount,
      activeLienCount,
      storedValue: storedValue.toFixed(2),
      lienedValue: lienedValue.toFixed(2),
      currency,
    };
  }

  /**
   * Tenant staff roster — BOTH tenant admins and warehouse managers.
   *
   * Widened 2026-07-23 to include TAs so the GA's "Disable a certain
   * tenant admin" flow has a list to pick from. Previously WM-only,
   * which left TAs unreachable from the console (the disable action
   * worked by userId, but there was no way for the GA to discover a
   * TA's userId short of a direct DB query).
   *
   * Each row carries a `role` field so the FE can badge Admin vs
   * Manager. When a user has BOTH roles (rare — an org's TA who also
   * runs a warehouse hands-on), we surface `TENANT_ADMIN` as the
   * primary badge (it's the higher-privileged role); their warehouse
   * assignments still show in `warehouseCount`.
   */
  async listTenantManagers(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const staff = await this.prisma.user.findMany({
      where: {
        tenantId: id,
        roles: {
          some: {
            role: { name: { in: ['TENANT_ADMIN', 'WAREHOUSE_MANAGER'] } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        managerCode: true,
        status: true,
        createdAt: true,
        roles: { select: { role: { select: { name: true } } } },
        managerAssignments: {
          where: { unassignedAt: null },
          select: { warehouseId: true },
        },
      },
    });

    return staff.map((u) => {
      const roleNames = u.roles.map((r) => r.role.name);
      // TA outranks WM for the primary-role badge. If a user has both,
      // the FE renders "Admin" and the disable action still targets
      // the same underlying user row (roles aren't disabled individually).
      const primaryRole = roleNames.includes('TENANT_ADMIN')
        ? 'TENANT_ADMIN'
        : 'WAREHOUSE_MANAGER';
      return {
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        managerCode: u.managerCode,
        status: u.status,
        role: primaryRole,
        warehouseCount: u.managerAssignments.length,
        createdAt: u.createdAt,
      };
    });
  }

  async listTenantWarehouses(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const warehouses = await this.prisma.warehouse.findMany({
      where: { tenantId: id },
      orderBy: { createdAt: 'desc' },
    });

    // Per-warehouse rollups. Same pattern as admin-warehouse.service.ts
    // getWarehouses — but scoped to a single tenant here.
    const items = await Promise.all(
      warehouses.map(async (w) => {
        const [managerCount, clientAgg, activeReceipts, stockByCommodity] =
          await Promise.all([
            this.prisma.warehouseManagerAssignment.count({
              where: { warehouseId: w.id, unassignedAt: null },
            }),
            this.prisma.receipt.groupBy({
              by: ['clientId'],
              where: {
                warehouseId: w.id,
                status: { notIn: ['SPLIT', 'WITHDRAWN', 'TRADED_OUT', 'SEIZED', 'EXPIRED', 'CANCELLED'] },
              },
            }),
            this.prisma.receipt.count({
              where: {
                warehouseId: w.id,
                status: {
                  in: ['ACTIVE', 'HELD_WITHDRAWAL', 'HELD_LOAN', 'HELD_TRADE', 'HELD_PLEDGE_PENDING', 'HELD_LIEN'],
                },
              },
            }),
            // Group in-warehouse receipt quantities by commodity so the
            // utilisation math can unit-convert each line to MT before
            // summing. The per-commodity unit + bag-weight + density
            // metadata lives on Commodity — pulled in one query below.
            this.prisma.receipt.groupBy({
              by: ['commodityId'],
              where: {
                warehouseId: w.id,
                status: {
                  in: ['ACTIVE', 'HELD_WITHDRAWAL', 'HELD_LOAN', 'HELD_TRADE', 'HELD_PLEDGE_PENDING', 'HELD_LIEN'],
                },
              },
              _sum: { quantity: true },
            }),
          ]);

        // Unit-normalized stock in MT. `sumInMt` skips commodities that
        // lack conversion metadata (e.g. a BAG commodity without a bag
        // weight set, or a LITRE commodity without a density set) —
        // utilisation may under-report until the admin fills those in.
        const commodityIds = stockByCommodity.map((s) => s.commodityId);
        const commodityMeta = commodityIds.length
          ? await this.prisma.commodity.findMany({
              where: { id: { in: commodityIds } },
              select: {
                id: true,
                unitOfMeasure: true,
                standardBagWeightKg: true,
                standardDensityKgPerLitre: true,
              },
            })
          : [];
        const commodityById = new Map(commodityMeta.map((c) => [c.id, c]));
        const [stockMt] = sumInMt(
          stockByCommodity.flatMap((s) => {
            const c = commodityById.get(s.commodityId);
            if (!c) return [];
            return [
              {
                quantity: Number(s._sum.quantity ?? 0),
                commodity: c,
              },
            ];
          }),
        );

        const capacityMt = w.capacityMt ? Number(w.capacityMt) : null;
        const utilisationPct =
          capacityMt && capacityMt > 0
            ? Math.min(100, Math.round((stockMt / capacityMt) * 100))
            : null;

        return {
          id: w.id,
          name: w.name,
          code: w.code,
          location: w.location,
          status: w.status,
          capacityMt: capacityMt !== null ? String(capacityMt) : null,
          utilisationPct,
          managerCount,
          clientCount: clientAgg.length,
          activeReceipts,
        };
      }),
    );

    return items;
  }

  // ─── Suspend / Reactivate ───────────────────────────────────────────────

  async suspendTenant(id: string, dto: SuspendTenantDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException('Tenant not found');
    // Defensive: INTERNAL tenants (SecureStore's own operations) cannot
    // be suspended. The GA UI hides the button for these; this guard
    // catches API calls that bypass the UI.
    if (tenant.type === TenantType.INTERNAL) {
      throw new BadRequestException({
        code: 'INTERNAL_TENANT_CANNOT_BE_SUSPENDED',
        message:
          'Internal tenants (SecureStore\'s own operations) cannot be suspended.',
      });
    }
    if (tenant.status === TenantStatus.SUSPENDED) {
      // Idempotent: already suspended → return current state.
      return this.projectAdminItem(tenant);
    }
    const updated = await this.prisma.tenant.update({
      where: { id },
      data: { status: TenantStatus.SUSPENDED },
    });

    void this.prisma.activityLog
      .create({
        data: {
          tenantId: id,
          action: 'tenant.suspended',
          entityType: 'TENANT',
          entityId: id,
          description: dto.reason
            ? `${tenant.name} was suspended: ${dto.reason}`
            : `${tenant.name} was suspended`,
          metadata: { severity: 'WARNING', reason: dto.reason ?? null } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    return this.projectAdminItem(updated);
  }

  async reactivateTenant(id: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException('Tenant not found');
    if (tenant.status === TenantStatus.ACTIVE) {
      return this.projectAdminItem(tenant);
    }
    const updated = await this.prisma.tenant.update({
      where: { id },
      data: { status: TenantStatus.ACTIVE },
    });

    void this.prisma.activityLog
      .create({
        data: {
          tenantId: id,
          action: 'tenant.reactivated',
          entityType: 'TENANT',
          entityId: id,
          description: `${tenant.name} was reactivated`,
          metadata: { severity: 'INFO' } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    return this.projectAdminItem(updated);
  }

  // ─── Projection ─────────────────────────────────────────────────────────

  private async projectAdminItem(t: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    status: TenantStatus;
    type: TenantType;
    createdAt: Date;
  }) {
    const [warehouseCount, managerCount, clientCount] = await Promise.all([
      this.prisma.warehouse.count({ where: { tenantId: t.id } }),
      this.prisma.user.count({
        where: {
          tenantId: t.id,
          roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } },
        },
      }),
      this.prisma.user.count({
        where: {
          tenantId: t.id,
          roles: { some: { role: { name: 'CLIENT' } } },
        },
      }),
    ]);
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      logoUrl: t.logoUrl,
      status: t.status,
      // `type` tells the FE whether to render the Suspend action:
      // hidden/disabled for INTERNAL (our own operations), shown for
      // EXTERNAL (paying customer collateral managers).
      type: t.type,
      warehouseCount,
      managerCount,
      clientCount,
      createdAt: t.createdAt,
    };
  }

  private async loadAdminItem(id: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tenant not found');
    return this.projectAdminItem(t);
  }
}
