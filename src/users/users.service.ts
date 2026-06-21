import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityService } from '../security/security.service';
import { StorageService } from '../storage/storage.service';
import { UpdateProfileDto } from './dto/users.dto';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private security: SecurityService,
    private storage: StorageService,
  ) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return this.projectMe(user);
  }

  async updateMe(dto: UpdateProfileDto, userId: string) {
    // Validate the photo URL came from our own storage layer. Empty string
    // is allowed and means "clear the photo" — assertOwnedUrls skips empty
    // entries silently, so we explicitly let through "" by only passing
    // truthy values through the validator.
    if (dto.profilePhotoUrl && dto.profilePhotoUrl.length > 0) {
      await this.storage.assertOwnedUrls([dto.profilePhotoUrl]);
    }

    // Normalise "" on the photo field → null so we don't persist empty
    // strings; the schema's `profilePhotoUrl` is nullable, not "".
    const normalisedPhotoUrl =
      dto.profilePhotoUrl === undefined
        ? undefined
        : dto.profilePhotoUrl === ''
          ? null
          : dto.profilePhotoUrl;

    // The user + the ClientProfile (if any) need to stay in sync on
    // profilePhotoUrl — at creation time the WM writes the same URL to
    // both, and any update from /me would otherwise drift the two copies.
    // The WM's client-detail view reads ClientProfile.profilePhotoUrl
    // and the client's own settings read User.profilePhotoUrl. Mirroring
    // here keeps both surfaces showing the same image.
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: {
          ...dto,
          profilePhotoUrl: normalisedPhotoUrl,
        },
        include: { roles: { include: { role: true } } },
      });
      if (dto.profilePhotoUrl !== undefined) {
        // Best-effort: not every user has a ClientProfile (e.g. WMs,
        // admins). updateMany with a userId filter is a no-op when no
        // row matches — cheaper than a findFirst + conditional update.
        await tx.clientProfile.updateMany({
          where: { userId },
          data: { profilePhotoUrl: normalisedPhotoUrl },
        });
      }
      return u;
    });
    return this.projectMe(updated);
  }

  /**
   * Shared projection for both `GET /users/me` and `PATCH /users/me` so the
   * shape stays in lock-step. Includes the security posture (`transactionPinSet`
   * + `twoFactorEnabled`) so the settings page and the transaction-submit
   * forms can branch off a single fetch. The PIN hash is NEVER returned —
   * only the boolean projection.
   */
  private projectMe(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    middleName: string | null;
    contactEmail: string | null;
    phoneNumber: string | null;
    status: string;
    profilePhotoUrl: string | null;
    transactionPinHash: string | null;
    transactionPinUpdatedAt: Date | null;
    twoFactorEnabled: boolean;
    twoFactorEnabledAt: Date | null;
    roles: { role: { name: string } }[];
  }) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      middleName: user.middleName,
      contactEmail: user.contactEmail,
      phoneNumber: user.phoneNumber,
      status: user.status,
      // Profile photo. Null when none uploaded — FE renders a placeholder
      // avatar. The URL is fetched with `Authorization: Bearer <jwt>` and
      // converted to a Blob URL for <img src>, same convention as any
      // other file served by /files/*.
      profilePhotoUrl: user.profilePhotoUrl,
      roles: user.roles.map((ur) => ur.role.name),
      // Security posture — drives the settings page and the transaction
      // submit forms. `transactionPinSet` is a projection of the hash's
      // presence so the FE never sees the hash itself.
      transactionPinSet: !!user.transactionPinHash,
      transactionPinUpdatedAt: user.transactionPinUpdatedAt,
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorEnabledAt: user.twoFactorEnabledAt,
    };
  }

  /**
   * In-app password rotation. Gated by THREE proofs:
   *   1. Current password — proves "you knew it before" (session-thief check).
   *   2. OTP delivered to the user's contactEmail — proves "you control the
   *      mailbox" (the actual anti-WM-impersonation gate; a session-thief
   *      without inbox access can't pass this).
   *   3. New-password strength + not-same-as-current.
   *
   * The OTP is consumed via SecurityService.consumeOtp which is the same
   * code path that gates withdrawals/loans/trades — same error shapes
   * (OTP_INVALID with attemptsRemaining, OTP_EXPIRED, OTP_EXHAUSTED).
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    otp: string,
  ) {
    if (!currentPassword || !newPassword) {
      throw new BadRequestException(
        'currentPassword and newPassword are required',
      );
    }
    if (!otp) {
      throw new BadRequestException(
        'OTP is required to change password. Request one via POST /me/transactions/request-otp { purpose: "CHANGE_PASSWORD" }.',
      );
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (newPassword === currentPassword) {
      throw new BadRequestException(
        'New password must be different from the current password',
      );
    }
    const strong = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    if (!strong.test(newPassword)) {
      throw new BadRequestException(
        'New password must be at least 8 characters with uppercase, lowercase, and digit',
      );
    }
    // OTP check is last so we don't burn an attempt against a request that
    // would have failed for password/format reasons anyway.
    await this.security.consumeOtp({
      userId,
      code: otp,
      purpose: 'CHANGE_PASSWORD',
    });
    const hashed = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashed },
    });
    return { success: true, message: 'Password changed successfully' };
  }

  async getPreferences(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const prefs = (user.notificationPrefs as Record<string, boolean>) ?? {};
    return {
      emailNotifications: prefs.email ?? true,
      smsNotifications: prefs.sms ?? false,
      inAppNotifications: prefs.inApp ?? true,
    };
  }

  async updatePreferences(
    userId: string,
    body: { emailNotifications?: boolean; smsNotifications?: boolean; inAppNotifications?: boolean },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const current = (user.notificationPrefs as Record<string, boolean>) ?? {};
    const updated = {
      ...current,
      ...(body.emailNotifications !== undefined && { email: body.emailNotifications }),
      ...(body.smsNotifications !== undefined && { sms: body.smsNotifications }),
      ...(body.inAppNotifications !== undefined && { inApp: body.inAppNotifications }),
    };
    await this.prisma.user.update({
      where: { id: userId },
      data: { notificationPrefs: updated },
    });
    return {
      emailNotifications: updated.email ?? true,
      smsNotifications: updated.sms ?? false,
      inAppNotifications: updated.inApp ?? true,
    };
  }
}
