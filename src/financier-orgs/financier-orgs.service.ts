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
import {
  CreateFinancierOrgDto,
  InviteFinancierUserDto,
  UpdateFinancierOrgDto,
  OffboardFinancierOrgDto,
} from './dto/financier-orgs.dto';
import { FinancierOrgStatus, LienStatus, Prisma, UserStatus } from '@prisma/client';

/**
 * TA-facing management of FinancierOrg entities. Matches the FE's
 * adminFinancierRoutes contract in src/api/endpoints/collateral.ts:
 *   POST   /admin/financiers                    — create org + first user
 *   GET    /admin/financiers                    — list w/ counts
 *   POST   /admin/financiers/:id/suspend        — flip to SUSPENDED
 *   POST   /admin/financiers/:id/reactivate     — flip to ACTIVE
 *   POST   /admin/financiers/:id/users          — invite additional user
 *   GET    /admin/financiers/:id/users          — list team
 *
 * Invite pattern mirrors ManagersService.createManager: server derives
 * `firstname.lastname@securestore.com` login alias, generates 12-char
 * temp password, emails both to the user's real inbox (`contactEmail`).
 * The first user rotates the password voluntarily via /me/change-password
 * (no forced-first-rotation gate yet — noted as follow-up).
 */
@Injectable()
export class FinancierOrgsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── Helpers (mirror ManagersService) ──────────────────────────────────

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

  private async requireFinancierRole() {
    const role = await this.prisma.role.findUnique({
      where: { name: 'FINANCIER' },
    });
    if (!role) {
      throw new BadRequestException(
        'FINANCIER role not configured. Run seed.',
      );
    }
    return role;
  }

  private async fireInvite(args: {
    tenantId: string;
    userId: string;
    firstName: string;
    realEmail: string;
    loginEmail: string;
    tempPassword: string;
    financierOrgName: string;
  }) {
    const signInUrl =
      (process.env.FRONTEND_URL ?? 'http://localhost:3001').replace(
        /\/+$/,
        '',
      ) + '/sign-in';
    void this.email
      .sendWelcomeEmail({
        to: args.realEmail,
        firstName: args.firstName,
        loginEmail: args.loginEmail,
        tempPassword: args.tempPassword,
        clientCode: args.financierOrgName,
        signInUrl,
      })
      .catch(() => undefined);
    void this.notifications
      .notifyUser(args.userId, {
        tenantId: args.tenantId,
        type: 'CLIENT_CREDENTIALS_ISSUED',
        title: 'Welcome — your SecureStore account is live',
        body: `Sign in with ${args.loginEmail} to start receiving pledges for ${args.financierOrgName}.`,
        relatedEntityType: 'financier_org',
        relatedEntityId: args.userId,
      })
      .catch(() => undefined);
  }

  // ─── Create ────────────────────────────────────────────────────────────

  async createFinancierOrg(dto: CreateFinancierOrgDto) {
    // Global name uniqueness (financier names are recognisable brands —
    // no two "Beige Bank" rows anywhere on the platform).
    const existing = await this.prisma.financierOrg.findFirst({
      where: { name: dto.name },
    });
    if (existing) {
      throw new ConflictException({
        code: 'FINANCIER_ORG_NAME_TAKEN',
        message: `A financier named "${dto.name}" already exists`,
      });
    }

    const financierRole = await this.requireFinancierRole();
    const loginEmail = await this.deriveLoginEmail(
      dto.firstUser.firstName,
      dto.firstUser.lastName,
    );
    const tempPassword = this.generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Financier users are platform-level, not tenant-scoped. Until
    // User.tenantId becomes nullable (a broader refactor), we anchor
    // new financier users to a "platform tenant" placeholder — for now
    // that's whatever tenant exists (the seeded SecureStore tenant). The
    // tenantId on financier users is semantically meaningless — every
    // financier-facing query uses `financierOrgId` instead.
    const platformTenant = await this.prisma.tenant.findFirst({
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!platformTenant) {
      throw new BadRequestException(
        'No tenant exists to anchor the financier user. Run the main seed first.',
      );
    }

    const { org, user } = await this.prisma.$transaction(async (tx) => {
      const org = await tx.financierOrg.create({
        data: {
          name: dto.name,
          licenseNumber: dto.licenseNumber,
          licenseDocUrl: dto.licenseDocUrl,
          logoUrl: dto.logoUrl,
          contactEmail: dto.contactEmail,
          phoneNumber: dto.phoneNumber,
          address: dto.address,
          tin: dto.tin,
          regulator: dto.regulator,
          website: dto.website,
          status: FinancierOrgStatus.ACTIVE,
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId: platformTenant.id,
          email: loginEmail,
          password: hashedPassword,
          firstName: dto.firstUser.firstName,
          lastName: dto.firstUser.lastName,
          // FE's `email` field on the first-user block is the person's
          // REAL email address. Store as User.contactEmail — same
          // convention as WMs / clients — so /email/sendWelcomeEmail
          // + OTP delivery flows both target it.
          contactEmail: dto.firstUser.email,
          status: UserStatus.ACTIVE,
          financierOrgId: org.id,
          roles: { create: { roleId: financierRole.id } },
        },
      });
      return { org, user };
    });

    void this.fireInvite({
      tenantId: platformTenant.id,
      userId: user.id,
      firstName: user.firstName,
      realEmail: user.contactEmail!,
      loginEmail,
      tempPassword,
      financierOrgName: org.name,
    });

    // Emit the platform-wide activity event so the GA System Activity
    // feed picks it up. tenantId is null — financier onboarding is a
    // platform-level event, not tenant-scoped. Best-effort.
    void this.prisma.activityLog
      .create({
        data: {
          tenantId: null,
          userId: user.id,
          action: 'financier.created',
          entityType: 'FINANCIER_ORG',
          entityId: org.id,
          description: `${org.name} was onboarded as a financier`,
          metadata: { severity: 'INFO' } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    // Response matches FE FinancierOrgAdminItem plus a credentials block
    // so the GA can hand credentials over manually if email fails.
    const withCounts = await this.loadForAdminList(org.id);
    return {
      financierOrg: this.projectAdminItem(withCounts!),
      credentials: {
        email: loginEmail,
        temporaryPassword: tempPassword,
      },
    };
  }

  // ─── Update (basic-KYC edit) ────────────────────────────────────────────

  async updateFinancierOrg(id: string, dto: UpdateFinancierOrgDto) {
    const org = await this.prisma.financierOrg.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Financier not found');

    // If rename requested, enforce global name uniqueness (ignoring self).
    if (dto.name && dto.name !== org.name) {
      const clash = await this.prisma.financierOrg.findFirst({
        where: { name: dto.name, id: { not: id } },
      });
      if (clash) {
        throw new ConflictException({
          code: 'FINANCIER_ORG_NAME_TAKEN',
          message: `A financier named "${dto.name}" already exists`,
        });
      }
    }

    await this.prisma.financierOrg.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.licenseNumber !== undefined && {
          licenseNumber: dto.licenseNumber,
        }),
        ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
        ...(dto.licenseDocUrl !== undefined && {
          licenseDocUrl: dto.licenseDocUrl,
        }),
        ...(dto.contactEmail !== undefined && {
          contactEmail: dto.contactEmail,
        }),
        ...(dto.phoneNumber !== undefined && {
          phoneNumber: dto.phoneNumber,
        }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.tin !== undefined && { tin: dto.tin }),
        ...(dto.regulator !== undefined && { regulator: dto.regulator }),
        ...(dto.website !== undefined && { website: dto.website }),
      },
    });
    const refreshed = await this.loadForAdminList(id);
    return this.projectAdminItem(refreshed!);
  }

  // ─── Read ──────────────────────────────────────────────────────────────

  async listFinancierOrgs(query: {
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
        { licenseNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [orgs, total] = await Promise.all([
      this.prisma.financierOrg.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: this.adminItemInclude,
      }),
      this.prisma.financierOrg.count({ where }),
    ]);

    return {
      items: orgs.map((o) => this.projectAdminItem(o)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getFinancierOrg(id: string) {
    const org = await this.prisma.financierOrg.findUnique({
      where: { id },
      include: this.adminItemInclude,
    });
    if (!org) throw new NotFoundException('Financier not found');
    return this.projectAdminItem(org);
  }

  async listFinancierOrgUsers(id: string) {
    const org = await this.prisma.financierOrg.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!org) throw new NotFoundException('Financier not found');

    return this.prisma.user.findMany({
      where: { financierOrgId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        contactEmail: true,
        phoneNumber: true,
        profilePhotoUrl: true,
        status: true,
        createdAt: true,
      },
    });
  }

  // ─── Suspend / Reactivate / Offboard ────────────────────────────────────
  //
  // Three distinct actions with distinct semantics:
  //   • suspend    → reversible pause. Existing liens remain manageable.
  //   • reactivate → undo suspend.
  //   • offboard   → terminal. Blocked if any active liens exist. No
  //                  reactivation path.
  //
  // Explicit verb endpoints (rather than one PATCH { status: ... }) give
  // intent-carrying URLs that surface cleanly in audit logs and let each
  // action carry its own required payload (e.g. offboard's mandatory
  // reason).

  async suspendFinancierOrg(id: string) {
    const org = await this.prisma.financierOrg.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Financier not found');
    if (org.status === FinancierOrgStatus.OFFBOARDED) {
      throw new BadRequestException(
        'Cannot suspend an offboarded financier — offboarding is terminal.',
      );
    }
    if (org.status === FinancierOrgStatus.SUSPENDED) {
      const current = await this.loadForAdminList(id);
      return this.projectAdminItem(current!);
    }
    await this.prisma.financierOrg.update({
      where: { id },
      data: { status: FinancierOrgStatus.SUSPENDED },
    });
    void this.prisma.activityLog
      .create({
        data: {
          tenantId: null,
          action: 'financier.suspended',
          entityType: 'FINANCIER_ORG',
          entityId: id,
          description: `${org.name} was suspended`,
          metadata: { severity: 'WARNING' } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    const updated = await this.loadForAdminList(id);
    return this.projectAdminItem(updated!);
  }

  async reactivateFinancierOrg(id: string) {
    const org = await this.prisma.financierOrg.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Financier not found');
    if (org.status === FinancierOrgStatus.OFFBOARDED) {
      throw new BadRequestException(
        'Cannot reactivate an offboarded financier — offboarding is terminal. Create a new financier org instead.',
      );
    }
    if (org.status === FinancierOrgStatus.ACTIVE) {
      const current = await this.loadForAdminList(id);
      return this.projectAdminItem(current!);
    }
    await this.prisma.financierOrg.update({
      where: { id },
      data: { status: FinancierOrgStatus.ACTIVE },
    });
    void this.prisma.activityLog
      .create({
        data: {
          tenantId: null,
          action: 'financier.reactivated',
          entityType: 'FINANCIER_ORG',
          entityId: id,
          description: `${org.name} was reactivated`,
          metadata: { severity: 'INFO' } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    const updated = await this.loadForAdminList(id);
    return this.projectAdminItem(updated!);
  }

  /**
   * Terminal offboard — flips status to OFFBOARDED and refuses if the
   * financier still holds active liens (which would strand real
   * collateral commitments). Reason is mandatory and lands in the audit
   * trail via the reason field on any subsequent operations that
   * reference this org.
   */
  async offboardFinancierOrg(id: string, dto: OffboardFinancierOrgDto) {
    const org = await this.prisma.financierOrg.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Financier not found');
    if (org.status === FinancierOrgStatus.OFFBOARDED) {
      // Idempotent — already offboarded → return current state.
      const current = await this.loadForAdminList(id);
      return this.projectAdminItem(current!);
    }

    // Block if any active liens exist. RELEASED / FORCE_RELEASED are
    // fine (historical). ACTIVE / PARTIALLY_RELEASED block — those are
    // live commitments that can't be orphaned.
    const activeLiens = await this.prisma.lien.count({
      where: {
        financierOrgId: id,
        status: { in: [LienStatus.ACTIVE, LienStatus.PARTIALLY_RELEASED] },
      },
    });
    if (activeLiens > 0) {
      throw new ConflictException({
        code: 'ACTIVE_LIENS_EXIST',
        message: `Cannot offboard: this financier holds ${activeLiens} active lien(s). Release them first (or force-release via /admin/liens/:id/force-release for exceptional cases).`,
        activeLienCount: activeLiens,
      });
    }

    await this.prisma.financierOrg.update({
      where: { id },
      data: { status: FinancierOrgStatus.OFFBOARDED },
    });
    // Platform-wide activity emit — this is the durable audit record for
    // the offboard (reason carried in the description so it survives the
    // per-user notifications). tenantId null since financier is
    // platform-level. Best-effort.
    void this.prisma.activityLog
      .create({
        data: {
          tenantId: null,
          action: 'financier.offboarded',
          entityType: 'FINANCIER_ORG',
          entityId: id,
          description: `${org.name} was offboarded: ${dto.reason}`,
          metadata: {
            severity: 'WARNING',
            reason: dto.reason,
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    // Notify all users of the offboarded org so they know their access
    // is about to lapse. Best-effort — a notification failure does not
    // reverse the offboard.
    void this.prisma.user
      .findMany({
        where: { financierOrgId: id },
        select: { id: true, tenantId: true },
      })
      .then((users) => {
        for (const u of users) {
          if (!u.tenantId) continue;
          void this.notifications.notifyUser(u.id, {
            tenantId: u.tenantId,
            type: 'WAREHOUSE_LINK_REJECTED', // TODO: add FINANCIER_OFFBOARDED type
            title: `${org.name} has been offboarded`,
            body: dto.reason,
            relatedEntityType: 'financierOrg',
            relatedEntityId: id,
          }).catch(() => undefined);
        }
      })
      .catch(() => undefined);

    const updated = await this.loadForAdminList(id);
    return this.projectAdminItem(updated!);
  }

  // ─── Invite additional user ────────────────────────────────────────────

  async inviteFinancierUser(
    financierOrgId: string,
    dto: InviteFinancierUserDto,
  ) {
    const org = await this.prisma.financierOrg.findUnique({
      where: { id: financierOrgId },
    });
    if (!org) throw new NotFoundException('Financier not found');
    if (org.status === FinancierOrgStatus.OFFBOARDED) {
      throw new BadRequestException(
        'Cannot invite users to an offboarded financier org.',
      );
    }
    if (org.status === FinancierOrgStatus.SUSPENDED) {
      throw new BadRequestException(
        'Cannot invite users to a suspended financier org. Reactivate first.',
      );
    }

    const financierRole = await this.requireFinancierRole();
    const loginEmail = await this.deriveLoginEmail(dto.firstName, dto.lastName);
    const tempPassword = this.generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Same platform-tenant anchor as create (see comment there).
    const platformTenant = await this.prisma.tenant.findFirst({
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!platformTenant) {
      throw new BadRequestException(
        'No tenant exists to anchor the financier user.',
      );
    }

    const user = await this.prisma.user.create({
      data: {
        tenantId: platformTenant.id,
        email: loginEmail,
        password: hashedPassword,
        firstName: dto.firstName,
        lastName: dto.lastName,
        contactEmail: dto.email,
        status: UserStatus.ACTIVE,
        financierOrgId,
        roles: { create: { roleId: financierRole.id } },
      },
    });

    void this.fireInvite({
      tenantId: platformTenant.id,
      userId: user.id,
      firstName: user.firstName,
      realEmail: user.contactEmail!,
      loginEmail,
      tempPassword,
      financierOrgName: org.name,
    });

    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        contactEmail: user.contactEmail,
      },
      credentials: {
        email: loginEmail,
        temporaryPassword: tempPassword,
      },
    };
  }

  // ─── Projections ───────────────────────────────────────────────────────
  //
  // Matches FE FinancierOrgAdminItem in src/api/types/collateral.ts:
  //   { id, name, licenseNumber, logoUrl, status, lienCount,
  //     warehouseCount, createdAt }
  //
  // lienCount   — active liens count (excludes RELEASED / FORCE_RELEASED)
  // warehouseCount — active warehouse links (excludes PENDING / OFFBOARDED)

  private readonly adminItemInclude = {
    _count: {
      select: {
        liens: { where: { status: 'ACTIVE' as const } },
        warehouseLinks: { where: { status: 'ACTIVE' as const } },
      },
    },
  };

  private async loadForAdminList(id: string) {
    return this.prisma.financierOrg.findUnique({
      where: { id },
      include: this.adminItemInclude,
    });
  }

  private projectAdminItem(o: {
    id: string;
    name: string;
    licenseNumber: string | null;
    licenseDocUrl: string | null;
    logoUrl: string | null;
    contactEmail: string | null;
    phoneNumber: string | null;
    address: string | null;
    tin: string | null;
    regulator: string | null;
    website: string | null;
    status: FinancierOrgStatus;
    createdAt: Date;
    _count: { liens: number; warehouseLinks: number };
  }) {
    return {
      id: o.id,
      name: o.name,
      // FE renders "Not provided" when this is falsy (empty string
      // included). Keep the empty-string fallback so old FE bindings
      // that expected string-not-null keep working.
      licenseNumber: o.licenseNumber ?? '',
      licenseDocUrl: o.licenseDocUrl,
      logoUrl: o.logoUrl,
      contactEmail: o.contactEmail,
      phoneNumber: o.phoneNumber,
      address: o.address,
      // Extra fields NOT in the FE FinancierOrgAdminItem contract but
      // returned harmlessly — TypeScript at the FE ignores unknown
      // extras. Kept surfaced so future admin screens don't need
      // another BE change to consume them.
      tin: o.tin,
      regulator: o.regulator,
      website: o.website,
      status: o.status,
      lienCount: o._count.liens,
      warehouseCount: o._count.warehouseLinks,
      createdAt: o.createdAt,
    };
  }
}
