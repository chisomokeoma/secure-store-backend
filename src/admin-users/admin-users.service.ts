import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, UserStatus } from '@prisma/client';
import { DisableUserDto } from './dto/admin-users.dto';

/**
 * Person-level disable / enable — the "Amina quit / was fired / is
 * under investigation" tool. Distinct from tenant-level suspension
 * (which is the commercial lever against an EXTERNAL tenant org).
 *
 * Works across every role: TA, WM, CLIENT, FINANCIER, even another
 * GA. Only GLOBAL_ADMIN can call these endpoints. A disabled user
 * cannot sign in (guarded in AuthService.login by the USER_INACTIVE
 * check); existing JWTs remain valid until they expire — same
 * trade-off as tenant suspension.
 *
 * Two safety rails deliberately built in:
 *   • You can't disable yourself. Prevents a GA accidentally locking
 *     themselves out of their own console.
 *   • Enabling doesn't unblock the tenant if the tenant is suspended.
 *     A re-enabled TA at a SUSPENDED tenant still gets TENANT_SUSPENDED
 *     on their next sign-in attempt — tenant suspension is separate.
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async disableUser(
    callerUserId: string,
    targetUserId: string,
    dto: DisableUserDto,
  ) {
    if (callerUserId === targetUserId) {
      throw new BadRequestException({
        code: 'CANNOT_DISABLE_SELF',
        message: 'You cannot disable your own account.',
      });
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        tenantId: true,
      },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.status === UserStatus.INACTIVE) {
      // Idempotent — already disabled → return current state.
      return this.projectUser(target.id);
    }
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { status: UserStatus.INACTIVE },
    });

    // Platform-wide activity emit. tenantId set to the target's home
    // tenant so per-tenant audit views also pick this up. Best-effort.
    void this.prisma.activityLog
      .create({
        data: {
          tenantId: target.tenantId,
          userId: callerUserId,
          action: 'user.disabled',
          entityType: 'USER',
          entityId: target.id,
          description: dto.reason
            ? `${target.firstName} ${target.lastName} was disabled: ${dto.reason}`
            : `${target.firstName} ${target.lastName} was disabled`,
          metadata: {
            severity: 'WARNING',
            reason: dto.reason ?? null,
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    return this.projectUser(target.id);
  }

  async enableUser(callerUserId: string, targetUserId: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        tenantId: true,
      },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.status === UserStatus.ACTIVE) {
      return this.projectUser(target.id);
    }
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { status: UserStatus.ACTIVE },
    });

    void this.prisma.activityLog
      .create({
        data: {
          tenantId: target.tenantId,
          userId: callerUserId,
          action: 'user.enabled',
          entityType: 'USER',
          entityId: target.id,
          description: `${target.firstName} ${target.lastName} was re-enabled`,
          metadata: { severity: 'INFO' } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    return this.projectUser(target.id);
  }

  private async projectUser(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        contactEmail: true,
        status: true,
        tenantId: true,
        financierOrgId: true,
        updatedAt: true,
      },
    });
    if (!u) throw new NotFoundException('User not found');
    return u;
  }
}
