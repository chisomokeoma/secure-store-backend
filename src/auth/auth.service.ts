import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { EmailService } from '../email/email.service';
import { resolveDeliveryEmail } from '../email/email.recipient';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';

// Reset-token configuration. 30 minutes is a common balance: short enough to
// limit damage from a leaked link, long enough that the user actually has
// time to act when the email is delayed.
const RESET_TOKEN_TTL_MINUTES = 30;

// Bcrypt cost factor. 10 is fine for general web auth.
const BCRYPT_ROUNDS = 10;

// Minimum password length enforced at the service layer too — the DTO already
// has @MinLength(6) but defence in depth never hurts.
const MIN_PASSWORD_LENGTH = 6;

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private email: EmailService,
  ) {}

  // ── login ────────────────────────────────────────────────────────────────
  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new BadRequestException('Invalid email or password');

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) throw new BadRequestException('Invalid email or password');

    const roles = user.roles.map((ur) => ur.role.name);
    const token = this.jwt.sign(
      {
        sub: user.id,
        email: user.email,
        roles: roles,
        tenantId: user.tenantId,
      },
      { expiresIn: '24h' },
    );

    return {
      access_token: token,
      user: {
        id: user.id,
        email: user.email,
        roles: roles,
        tenantId: user.tenantId,
      },
    };
  }

  // ── forgot password ──────────────────────────────────────────────────────
  /**
   * Always returns a generic success. We deliberately do NOT reveal whether
   * the email is registered — preventing account enumeration. The cost is
   * a small UX wart: a typo silently does nothing. The benefit is
   * attackers can't probe for valid accounts.
   *
   * When the email IS registered we:
   *   1. Invalidate any prior unused tokens (so a leaked old link goes dead).
   *   2. Generate a fresh cryptographically random token.
   *   3. Store its SHA-256 hash (never the raw token) with a 30 min TTL.
   *   4. Email the raw token (embedded in a reset URL) via EmailService.
   */
  async forgotPassword(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        contactEmail: true,
        firstName: true,
        status: true,
      },
    });

    if (user && user.status === 'ACTIVE') {
      const rawToken = randomBytes(32).toString('base64url');
      const tokenHash = this.sha256(rawToken);
      const expiresAt = new Date(
        Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000,
      );

      await this.prisma.$transaction([
        // Invalidate any previous unused tokens so only the newest link works.
        this.prisma.passwordResetToken.updateMany({
          where: {
            userId: user.id,
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { usedAt: new Date() },
        }),
        this.prisma.passwordResetToken.create({
          data: { userId: user.id, tokenHash, expiresAt },
        }),
      ]);

      const resetUrl = this.buildResetUrl(rawToken);
      // resolveDeliveryEmail enforces the system-wide convention: real
      // contact email if on file, system login alias only as a (logged)
      // fallback. See src/email/email.recipient.ts.
      await this.email.sendPasswordResetEmail({
        to: resolveDeliveryEmail(user),
        firstName: user.firstName,
        resetUrl,
        expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
      });
    } else if (user && user.status !== 'ACTIVE') {
      // Don't issue a reset link to deactivated / suspended accounts, but
      // also don't tell the caller — same generic response.
      this.log.warn(
        `Password reset suppressed for non-ACTIVE user ${user.id} (status=${user.status})`,
      );
    } else {
      // No user — log only at debug to avoid leaking probe attempts in prod.
      this.log.debug(`Password reset requested for unknown email`);
    }

    return {
      success: true,
      message:
        'If an account exists for that email, a password reset link has been sent.',
    };
  }

  // ── reset password ───────────────────────────────────────────────────────
  /**
   * Consumes a reset token. Verifies it exists, isn't already used, and
   * hasn't expired. On success: updates the password, marks the token used,
   * and revokes every refresh token for the user — forcing a fresh login on
   * all devices (the security-on-password-change convention).
   */
  async resetPassword(rawToken: string, newPassword: string) {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    const tokenHash = this.sha256(rawToken);
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    // Same error for "no such token" / "used" / "expired" — don't leak which.
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException(
        'Reset link is invalid or has expired. Request a new one.',
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { password: passwordHash },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: now },
      }),
      // Belt-and-braces: invalidate every OTHER outstanding reset token for
      // this user so a parallel-issued link can't be used after one wins.
      this.prisma.passwordResetToken.updateMany({
        where: { userId: record.userId, usedAt: null },
        data: { usedAt: now },
      }),
      // Revoke active refresh tokens — anyone logged in elsewhere is kicked
      // out and forced to re-authenticate.
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    return {
      success: true,
      message:
        'Password updated. You can now sign in with your new password.',
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private buildResetUrl(token: string): string {
    const base = (process.env.FRONTEND_URL ?? 'http://localhost:3001').replace(
      /\/+$/,
      '',
    );
    return `${base}/reset-password?token=${token}`;
  }
}
