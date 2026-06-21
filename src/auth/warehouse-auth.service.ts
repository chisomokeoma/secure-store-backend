import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

// JWT typ claims for the intermediate tokens. Each intermediate token is
// only valid for the specific endpoint it gates — we enforce this by
// checking the `typ` claim before honoring the token. Reuses the existing
// JwtService config (same secret as the main login flow).
const TYP_CHANGE_PWD = 'wh-change-password';
const TYP_SELECT_MGR = 'wh-select-manager';
const TYP_ACCESS = 'access';

const INTERMEDIATE_TTL = '10m';
const ACCESS_TTL = '24h';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class WarehouseAuthService {
  private readonly log = new Logger(WarehouseAuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  // ── Step 1: warehouse-login ─────────────────────────────────────────────
  /**
   * Verify the warehouse's shared email + password. Two possible outcomes:
   *
   *   mustChangePassword=true:
   *     Returns { mustChangePassword: true, changeToken } — a short-lived
   *     token only valid against POST /auth/warehouse-login/change-password.
   *     The FE prompts the user for a new password, then calls that endpoint
   *     to consume the change token and progress to the select step.
   *
   *   mustChangePassword=false:
   *     Returns { managers: [...], selectToken } — the assigned roster plus
   *     a short-lived token only valid against
   *     POST /auth/warehouse-login/select-manager. The FE shows
   *     "Who are you?" and the user picks themselves; the next call exchanges
   *     the select token + chosen managerId for the full JWT.
   *
   * Anti-enumeration: same generic 401 for bad-email and bad-password.
   */
  async warehouseLogin(rawEmail: string, password: string) {
    const email = rawEmail.trim().toLowerCase();
    const wh = await this.prisma.warehouse.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        code: true,
        tenantId: true,
        passwordHash: true,
        mustChangePassword: true,
        status: true,
      },
    });

    const fail = () => {
      throw new UnauthorizedException('Invalid warehouse credentials.');
    };
    if (!wh || !wh.passwordHash) fail();
    if (wh!.status !== 'ACTIVE') {
      throw new UnauthorizedException(
        'This warehouse is not active. Contact a tenant administrator.',
      );
    }
    const ok = await bcrypt.compare(password, wh!.passwordHash!);
    if (!ok) fail();

    if (wh!.mustChangePassword) {
      const changeToken = this.jwt.sign(
        { typ: TYP_CHANGE_PWD, warehouseId: wh!.id, tenantId: wh!.tenantId },
        { expiresIn: INTERMEDIATE_TTL },
      );
      return {
        mustChangePassword: true,
        warehouse: {
          id: wh!.id,
          name: wh!.name,
          code: wh!.code,
        },
        changeToken,
      };
    }

    return this.selectStepResponse(wh!.id, wh!.tenantId, wh!.name, wh!.code);
  }

  // ── Step 1b: change-password (when forced) ──────────────────────────────
  async changeWarehousePassword(changeToken: string, newPassword: string) {
    const payload = this.verifyTyp(changeToken, TYP_CHANGE_PWD);
    if (!this.isStrongPassword(newPassword)) {
      throw new BadRequestException(
        'Password must be at least 8 characters with at least one uppercase letter, one lowercase letter, and one digit.',
      );
    }
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const updated = await this.prisma.warehouse.update({
      where: { id: payload.warehouseId },
      data: {
        passwordHash: hash,
        passwordSetAt: new Date(),
        mustChangePassword: false,
      },
      select: { id: true, name: true, code: true, tenantId: true },
    });
    return this.selectStepResponse(
      updated.id,
      updated.tenantId,
      updated.name,
      updated.code,
    );
  }

  // ── Step 2: select-manager → full JWT ───────────────────────────────────
  async selectManager(selectToken: string, managerUserId: string) {
    const payload = this.verifyTyp(selectToken, TYP_SELECT_MGR);
    // The chosen manager must be (a) a real user with the WAREHOUSE_MANAGER
    // role and (b) currently assigned to the warehouse they're identifying
    // themselves at. Either check failing → generic 401 (don't leak which).
    const assignment = await this.prisma.warehouseManagerAssignment.findFirst({
      where: {
        tenantId: payload.tenantId,
        warehouseId: payload.warehouseId,
        managerId: managerUserId,
        unassignedAt: null,
        manager: {
          status: 'ACTIVE',
          roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } },
        },
      },
      include: {
        manager: {
          include: { roles: { include: { role: true } } },
        },
      },
    });
    if (!assignment) {
      throw new UnauthorizedException(
        'You are not currently assigned to this warehouse.',
      );
    }
    const manager = assignment.manager;
    const roles = manager.roles.map((ur) => ur.role.name);

    // Full session JWT. `warehouseId` is carried as a claim so downstream
    // code can tell this session was warehouse-mediated (vs a personal-account
    // login). `sub` is the manager so every CurrentUser('id') in the codebase
    // continues to resolve to the specific human — audit chain intact.
    const accessToken = this.jwt.sign(
      {
        typ: TYP_ACCESS,
        sub: manager.id,
        email: manager.email,
        roles,
        tenantId: manager.tenantId,
        warehouseId: payload.warehouseId,
      },
      { expiresIn: ACCESS_TTL },
    );

    return {
      access_token: accessToken,
      user: {
        id: manager.id,
        email: manager.email,
        firstName: manager.firstName,
        lastName: manager.lastName,
        roles,
        tenantId: manager.tenantId,
        warehouseId: payload.warehouseId,
      },
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /**
   * Build the payload that follows a successful credential verification
   * (either fresh password or just-rotated). Shared so both paths return
   * the exact same shape.
   */
  private async selectStepResponse(
    warehouseId: string,
    tenantId: string,
    name: string,
    code: string | null,
  ) {
    const assignments = await this.prisma.warehouseManagerAssignment.findMany({
      where: {
        warehouseId,
        tenantId,
        unassignedAt: null,
        manager: {
          status: 'ACTIVE',
          roles: { some: { role: { name: 'WAREHOUSE_MANAGER' } } },
        },
      },
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
      orderBy: { assignedAt: 'asc' },
    });

    const selectToken = this.jwt.sign(
      { typ: TYP_SELECT_MGR, warehouseId, tenantId },
      { expiresIn: INTERMEDIATE_TTL },
    );

    return {
      mustChangePassword: false,
      warehouse: { id: warehouseId, name, code },
      managers: assignments.map((a) => ({
        id: a.manager.id,
        name: `${a.manager.firstName} ${a.manager.lastName}`,
        managerCode: a.manager.managerCode,
        profilePhotoUrl: a.manager.profilePhotoUrl,
      })),
      selectToken,
    };
  }

  /**
   * Verify an intermediate token and assert its `typ` claim matches the
   * endpoint that consumed it. A change-token submitted to /select-manager
   * (or vice-versa) is rejected. Expiry is enforced automatically by JwtService.
   */
  private verifyTyp(
    token: string,
    expected: string,
  ): { warehouseId: string; tenantId: string } {
    let payload: any;
    try {
      payload = this.jwt.verify(token);
    } catch (err: any) {
      this.log.warn(`warehouse-auth token verify failed: ${err?.message ?? err}`);
      throw new UnauthorizedException('Token is invalid or has expired.');
    }
    if (payload?.typ !== expected) {
      throw new UnauthorizedException('Token is not valid for this step.');
    }
    if (!payload.warehouseId || !payload.tenantId) {
      throw new UnauthorizedException('Token is missing required claims.');
    }
    return { warehouseId: payload.warehouseId, tenantId: payload.tenantId };
  }

  private isStrongPassword(p: string): boolean {
    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(p);
  }
}
