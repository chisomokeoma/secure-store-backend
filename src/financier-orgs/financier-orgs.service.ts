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
} from './dto/financier-orgs.dto';
import { FinancierOrgStatus, UserStatus } from '@prisma/client';

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

  async createFinancierOrg(tenantId: string, dto: CreateFinancierOrgDto) {
    const existing = await this.prisma.financierOrg.findFirst({
      where: { tenantId, name: dto.name },
    });
    if (existing) {
      throw new ConflictException({
        code: 'FINANCIER_ORG_NAME_TAKEN',
        message: `A financier named "${dto.name}" already exists in this tenant`,
      });
    }

    const financierRole = await this.requireFinancierRole();
    const loginEmail = await this.deriveLoginEmail(
      dto.firstUser.firstName,
      dto.firstUser.lastName,
    );
    const tempPassword = this.generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const { org, user } = await this.prisma.$transaction(async (tx) => {
      const org = await tx.financierOrg.create({
        data: {
          tenantId,
          name: dto.name,
          licenseNumber: dto.licenseNumber,
          licenseDocUrl: dto.licenseDocUrl,
          logoUrl: dto.logoUrl,
          status: FinancierOrgStatus.ACTIVE,
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId,
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
      tenantId,
      userId: user.id,
      firstName: user.firstName,
      realEmail: user.contactEmail!,
      loginEmail,
      tempPassword,
      financierOrgName: org.name,
    });

    // Response matches FE FinancierOrgAdminItem plus a credentials block
    // so the TA can hand credentials over manually if email fails.
    const withCounts = await this.loadForAdminList(org.id);
    return {
      financierOrg: this.projectAdminItem(withCounts!),
      credentials: {
        email: loginEmail,
        temporaryPassword: tempPassword,
      },
    };
  }

  // ─── Read ──────────────────────────────────────────────────────────────

  async listFinancierOrgs(
    tenantId: string,
    query: {
      search?: string;
      status?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

    const where: any = { tenantId };
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

  async getFinancierOrg(tenantId: string, id: string) {
    const org = await this.prisma.financierOrg.findFirst({
      where: { id, tenantId },
      include: this.adminItemInclude,
    });
    if (!org) throw new NotFoundException('Financier not found');
    return this.projectAdminItem(org);
  }

  async listFinancierOrgUsers(tenantId: string, id: string) {
    const org = await this.prisma.financierOrg.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!org) throw new NotFoundException('Financier not found');

    return this.prisma.user.findMany({
      where: { financierOrgId: id, tenantId },
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

  // ─── Suspend / Reactivate ──────────────────────────────────────────────
  //
  // Explicit endpoints (POST /suspend, POST /reactivate) rather than
  // one PATCH — matches FE contract and gives the intent-carrying URL
  // that shows up cleanly in audit logs.

  async suspendFinancierOrg(tenantId: string, id: string) {
    const org = await this.prisma.financierOrg.findFirst({
      where: { id, tenantId },
    });
    if (!org) throw new NotFoundException('Financier not found');
    if (org.status === FinancierOrgStatus.SUSPENDED) {
      // Idempotent: already suspended → return current state, no error.
      const current = await this.loadForAdminList(id);
      return this.projectAdminItem(current!);
    }
    await this.prisma.financierOrg.update({
      where: { id },
      data: { status: FinancierOrgStatus.SUSPENDED },
    });
    const updated = await this.loadForAdminList(id);
    return this.projectAdminItem(updated!);
  }

  async reactivateFinancierOrg(tenantId: string, id: string) {
    const org = await this.prisma.financierOrg.findFirst({
      where: { id, tenantId },
    });
    if (!org) throw new NotFoundException('Financier not found');
    if (org.status === FinancierOrgStatus.ACTIVE) {
      const current = await this.loadForAdminList(id);
      return this.projectAdminItem(current!);
    }
    await this.prisma.financierOrg.update({
      where: { id },
      data: { status: FinancierOrgStatus.ACTIVE },
    });
    const updated = await this.loadForAdminList(id);
    return this.projectAdminItem(updated!);
  }

  // ─── Invite additional user ────────────────────────────────────────────

  async inviteFinancierUser(
    tenantId: string,
    financierOrgId: string,
    dto: InviteFinancierUserDto,
  ) {
    const org = await this.prisma.financierOrg.findFirst({
      where: { id: financierOrgId, tenantId },
    });
    if (!org) throw new NotFoundException('Financier not found');
    if (org.status === FinancierOrgStatus.SUSPENDED) {
      throw new BadRequestException(
        'Cannot invite users to a suspended financier org. Reactivate first.',
      );
    }

    const financierRole = await this.requireFinancierRole();
    const loginEmail = await this.deriveLoginEmail(dto.firstName, dto.lastName);
    const tempPassword = this.generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const user = await this.prisma.user.create({
      data: {
        tenantId,
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
      tenantId,
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
    status: FinancierOrgStatus;
    createdAt: Date;
    _count: { liens: number; warehouseLinks: number };
  }) {
    return {
      id: o.id,
      name: o.name,
      licenseNumber: o.licenseNumber ?? '',
      licenseDocUrl: o.licenseDocUrl,
      logoUrl: o.logoUrl,
      status: o.status,
      lienCount: o._count.liens,
      warehouseCount: o._count.warehouseLinks,
      createdAt: o.createdAt,
    };
  }
}
