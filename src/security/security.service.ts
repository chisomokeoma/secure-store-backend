import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { createHash, randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { resolveDeliveryEmail } from '../email/email.recipient';
import { TransactionOtpPurpose } from '@prisma/client';

// ── Knobs (kept here so they live in one place) ──────────────────────────
const PIN_LENGTH = 4; // 4-digit numeric PIN — matches the FE input
const OTP_LENGTH = 6; // 6-digit numeric OTP — industry standard
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5; // wrong submissions per code before it's burned
const BCRYPT_ROUNDS = 10;

// Stable machine-readable error codes the FE can branch on. The string values
// are part of the public API — don't rename without coordinating with the FE.
// Attached as `code` on the response body via the global exception filter.
export const SEC_ERR = {
  // PIN errors
  PIN_FORMAT_INVALID: 'PIN_FORMAT_INVALID',
  PIN_NOT_SET: 'PIN_NOT_SET',
  PIN_ALREADY_SET: 'PIN_ALREADY_SET',
  PIN_INCORRECT: 'PIN_INCORRECT',
  PIN_REUSED: 'PIN_REUSED',
  PIN_LOCKED_BY_2FA: 'PIN_LOCKED_BY_2FA',
  PIN_REQUIRED: 'PIN_REQUIRED',
  // OTP errors
  OTP_FORMAT_INVALID: 'OTP_FORMAT_INVALID',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_EXHAUSTED: 'OTP_EXHAUSTED',
  OTP_REQUIRED: 'OTP_REQUIRED',
  // Password gate
  PASSWORD_REQUIRED: 'PASSWORD_REQUIRED',
  PASSWORD_INCORRECT: 'PASSWORD_INCORRECT',
} as const;

@Injectable()
export class SecurityService {
  constructor(
    private prisma: PrismaService,
    private email: EmailService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════
  // TRANSACTION PIN — set / change / clear
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Set a transaction PIN for the first time. We require the current
   * account password so a stolen JWT alone can't silently establish a PIN
   * the legitimate user doesn't know.
   */
  async setTransactionPin(args: {
    userId: string;
    password: string;
    pin: string;
  }) {
    this.assertPinFormat(args.pin);
    const user = await this.loadUserOrThrow(args.userId);
    await this.assertPasswordCorrect(user, args.password);
    if (user.transactionPinHash) {
      throw new BadRequestException({
        code: SEC_ERR.PIN_ALREADY_SET,
        message:
          'A transaction PIN is already set. Use the change-PIN flow instead.',
      });
    }
    const hash = await bcrypt.hash(args.pin, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        transactionPinHash: hash,
        transactionPinUpdatedAt: new Date(),
      },
    });
    return { success: true, message: 'Transaction PIN set.' };
  }

  /**
   * Change PIN — requires current PIN + password (defence in depth: if
   * either is wrong, the change is rejected, and a hijacker needs both
   * pieces of knowledge to rotate the PIN).
   */
  async changeTransactionPin(args: {
    userId: string;
    password: string;
    currentPin: string;
    newPin: string;
  }) {
    this.assertPinFormat(args.newPin);
    const user = await this.loadUserOrThrow(args.userId);
    if (!user.transactionPinHash) {
      throw new BadRequestException({
        code: SEC_ERR.PIN_NOT_SET,
        message: 'No transaction PIN is set yet. Use the set-PIN flow first.',
      });
    }
    await this.assertPasswordCorrect(user, args.password);
    if (!(await bcrypt.compare(args.currentPin, user.transactionPinHash))) {
      throw new UnauthorizedException({
        code: SEC_ERR.PIN_INCORRECT,
        message: 'Current PIN is incorrect.',
      });
    }
    if (args.currentPin === args.newPin) {
      throw new BadRequestException({
        code: SEC_ERR.PIN_REUSED,
        message: 'New PIN must differ from the current PIN.',
      });
    }
    const hash = await bcrypt.hash(args.newPin, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        transactionPinHash: hash,
        transactionPinUpdatedAt: new Date(),
      },
    });
    return { success: true, message: 'Transaction PIN updated.' };
  }

  /**
   * Clear the PIN. Blocked while 2FA is on — the PIN is a precondition of
   * 2FA, so removing it would orphan the toggle.
   */
  async clearTransactionPin(args: { userId: string; password: string }) {
    const user = await this.loadUserOrThrow(args.userId);
    await this.assertPasswordCorrect(user, args.password);
    if (!user.transactionPinHash) {
      return { success: true, message: 'No transaction PIN to clear.' };
    }
    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        code: SEC_ERR.PIN_LOCKED_BY_2FA,
        message:
          'Disable two-factor authentication before clearing your PIN.',
      });
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { transactionPinHash: null, transactionPinUpdatedAt: null },
    });
    return { success: true, message: 'Transaction PIN cleared.' };
  }

  // ══════════════════════════════════════════════════════════════════════
  // TWO-FACTOR AUTH — enable / disable
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Turn 2FA on. Requires a PIN to already be set (so transactions stay
   * verifiable end-to-end) and the user's current password (to gate the
   * change behind a fresh credential check).
   */
  async enableTwoFactor(args: { userId: string; password: string }) {
    const user = await this.loadUserOrThrow(args.userId);
    await this.assertPasswordCorrect(user, args.password);
    if (!user.transactionPinHash) {
      throw new BadRequestException({
        code: SEC_ERR.PIN_NOT_SET,
        message:
          'Set a transaction PIN before enabling two-factor authentication.',
      });
    }
    if (user.twoFactorEnabled) {
      return {
        success: true,
        message: 'Two-factor authentication is already enabled.',
        twoFactorEnabled: true,
      };
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true, twoFactorEnabledAt: new Date() },
    });
    return {
      success: true,
      message:
        'Two-factor authentication enabled. Each transaction will now require an OTP.',
      twoFactorEnabled: true,
    };
  }

  /**
   * Disable 2FA. Requires password AND a fresh DISABLE_2FA OTP — so a
   * stolen JWT alone can't quietly turn the protection off. The disable
   * OTP is requested separately via requestTransactionOtp(purpose=DISABLE_2FA).
   */
  async disableTwoFactor(args: {
    userId: string;
    password: string;
    otp: string;
  }) {
    const user = await this.loadUserOrThrow(args.userId);
    await this.assertPasswordCorrect(user, args.password);
    if (!user.twoFactorEnabled) {
      return {
        success: true,
        message: 'Two-factor authentication is already disabled.',
        twoFactorEnabled: false,
      };
    }
    await this.consumeOtp({
      userId: user.id,
      code: args.otp,
      purpose: 'DISABLE_2FA',
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, twoFactorEnabledAt: null },
    });
    return {
      success: true,
      message: 'Two-factor authentication disabled.',
      twoFactorEnabled: false,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // OTP — request + consume
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Issue a fresh OTP for the given user + purpose, and deliver it via
   * email. Any previous unused OTP for the same (user, purpose) is voided
   * so only the newest code is acceptable. Always returns success without
   * leaking whether the user has 2FA on — same anti-enumeration stance
   * we use for password reset.
   */
  async requestTransactionOtp(args: {
    userId: string;
    purpose: TransactionOtpPurpose;
    // For staff-on-behalf flows: who is initiating the request, so the OTP
    // record can be audited. Not used for delivery — the email always goes
    // to the user the OTP is *for*.
    requestedByUserId?: string;
  }) {
    const user = await this.loadUserOrThrow(args.userId);

    // Purposes that ALWAYS require an OTP regardless of the user's 2FA
    // preference. These are step-up gates for security-critical identity
    // actions (password rotation, future email/phone change, …) — the OTP
    // is the proof-of-mailbox-control that stops a session-thief or a WM
    // on a shared kiosk from quietly mutating the account.
    const ALWAYS_REQUIRE_OTP: TransactionOtpPurpose[] = ['CHANGE_PASSWORD'];

    // For all OTHER purposes, 2FA-off means no OTP makes sense:
    //   - WITHDRAWAL/LOAN/TRADE: transaction gate is skipped at submit time
    //   - DISABLE_2FA: there's nothing to disable
    // Return a generic success either way so a probing caller can't infer
    // whether the target user has 2FA on. `expiresInSeconds: 0` signals
    // "nothing was sent" without ever lying about why.
    if (!user.twoFactorEnabled && !ALWAYS_REQUIRE_OTP.includes(args.purpose)) {
      return {
        success: true,
        message:
          'If two-factor authentication is enabled for this account, an OTP has been sent.',
        expiresInSeconds: 0,
        deliveredTo: null,
        channel: null,
      };
    }

    const code = this.generateNumericCode(OTP_LENGTH);
    const codeHash = this.sha256(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await this.prisma.$transaction([
      // Invalidate any prior live OTPs for the same (user, purpose). Only
      // the newest code should ever be valid.
      this.prisma.transactionOtp.updateMany({
        where: {
          userId: user.id,
          purpose: args.purpose,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      }),
      this.prisma.transactionOtp.create({
        data: {
          userId: user.id,
          purpose: args.purpose,
          codeHash,
          expiresAt,
        },
      }),
    ]);

    // Delivery destination follows the system-wide rule: prefer the user's
    // real contactEmail; fall back to the @securestore.com login alias only
    // for legacy users with no contact on file (the helper logs a warning
    // in that case so we notice). See email/email.recipient.ts.
    const deliveryEmail = resolveDeliveryEmail(user);

    await this.email.sendTransactionOtpEmail({
      to: deliveryEmail,
      firstName: user.firstName,
      code,
      purpose: args.purpose,
      expiresInMinutes: OTP_TTL_MINUTES,
    });

    return {
      success: true,
      message:
        'If two-factor authentication is enabled for this account, an OTP has been sent.',
      expiresInSeconds: OTP_TTL_MINUTES * 60,
      // Masked address — lets the FE render "Code sent to m***@example.com
      // · expires in 10:00" with a live countdown, without ever leaking the
      // full address back over the wire. Masks whatever we ACTUALLY sent
      // to, so the inbox the user is checking matches the hint.
      deliveredTo: this.maskEmail(deliveryEmail),
      channel: 'email' as const,
    };
  }

  /**
   * Verify and burn an OTP. Increments `attempts` on a wrong submission;
   * after `OTP_MAX_ATTEMPTS` the code is marked used (you must request a
   * fresh one). Same error message for "no code", "wrong code", "expired",
   * "used" — don't leak which.
   */
  /**
   * Verify and burn an OTP. Distinct error codes (security-vs-UX trade-off
   * favours UX here — the caller is already authenticated, the OTP system is
   * per-(user, purpose), so distinguishing failure modes doesn't expose
   * useful enumeration to an attacker but materially helps the legitimate
   * user understand what to do next):
   *
   *   OTP_FORMAT_INVALID — wrong length / non-numeric, rejected before lookup
   *   OTP_EXPIRED        — no live code for (user, purpose) OR past 10-min TTL
   *                        (folded together: same FE action, "request new")
   *   OTP_INVALID        — wrong code submitted. Response carries
   *                        `attemptsRemaining` so the FE can show "3 left".
   *   OTP_EXHAUSTED      — 5 wrong submissions hit; code burned.
   */
  /**
   * Public for cross-service OTP verification — the password-change flow
   * in MeService / UsersService calls this to gate the rotation. Inside
   * SecurityService itself it's the same code path that backs the
   * transaction-submit and DISABLE_2FA OTP checks.
   */
  async consumeOtp(args: {
    userId: string;
    code: string;
    purpose: TransactionOtpPurpose;
  }): Promise<void> {
    if (!args.code || !/^\d+$/.test(args.code) || args.code.length !== OTP_LENGTH) {
      throw new BadRequestException({
        code: SEC_ERR.OTP_FORMAT_INVALID,
        message: `OTP must be exactly ${OTP_LENGTH} digits (0-9).`,
      });
    }
    // Look up by newest unused OTP for this (user, purpose). Codes are
    // single-use so this is safe.
    const otp = await this.prisma.transactionOtp.findFirst({
      where: {
        userId: args.userId,
        purpose: args.purpose,
        usedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.expiresAt < new Date()) {
      throw new BadRequestException({
        code: SEC_ERR.OTP_EXPIRED,
        message:
          'No active OTP found, or it has expired. Request a new code.',
      });
    }
    const matches = this.sha256(args.code) === otp.codeHash;
    if (!matches) {
      const attempts = otp.attempts + 1;
      const burned = attempts >= OTP_MAX_ATTEMPTS;
      await this.prisma.transactionOtp.update({
        where: { id: otp.id },
        data: {
          attempts,
          // Burn the code if too many wrong tries — force a fresh request
          // rather than letting a bot keep guessing.
          ...(burned ? { usedAt: new Date() } : {}),
        },
      });
      if (burned) {
        throw new BadRequestException({
          code: SEC_ERR.OTP_EXHAUSTED,
          message:
            'Too many incorrect attempts. This code has been disabled — request a new one.',
        });
      }
      const attemptsRemaining = OTP_MAX_ATTEMPTS - attempts;
      throw new BadRequestException({
        code: SEC_ERR.OTP_INVALID,
        message: `Incorrect OTP. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} remaining before this code is disabled.`,
        attemptsRemaining,
      });
    }
    await this.prisma.transactionOtp.update({
      where: { id: otp.id },
      data: { usedAt: new Date() },
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // TRANSACTION GATE — called from withdrawals/loans/trades
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Enforced at the start of every withdrawal / loan / trade create. The
   * `userId` is whose security posture we evaluate — for an on-behalf
   * action, that's the CLIENT, not the WM who's clicking.
   *
   *   2FA OFF on user            → no checks (today's behavior)
   *   2FA ON, client-initiated   → require PIN + OTP from the user
   *   2FA ON, WM on-behalf       → require OTP (sent to client) only;
   *                                PIN is skipped (the WM doesn't have it)
   *
   * Throws on failure — services should call this BEFORE any ledger work.
   */
  async assertTransactionAuth(args: {
    userId: string;
    purpose: TransactionOtpPurpose;
    pin?: string;
    otp?: string;
    isOnBehalf?: boolean;
  }): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: args.userId },
      select: { transactionPinHash: true, twoFactorEnabled: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.twoFactorEnabled) return;

    // Client-initiated path requires the PIN.
    if (!args.isOnBehalf) {
      if (!user.transactionPinHash) {
        throw new BadRequestException({
          code: SEC_ERR.PIN_NOT_SET,
          message:
            'A transaction PIN is required but not set on this account.',
        });
      }
      if (!args.pin) {
        throw new BadRequestException({
          code: SEC_ERR.PIN_REQUIRED,
          message: 'Transaction PIN is required to complete this action.',
        });
      }
      const ok = await bcrypt.compare(args.pin, user.transactionPinHash);
      if (!ok) {
        throw new UnauthorizedException({
          code: SEC_ERR.PIN_INCORRECT,
          message: 'Incorrect transaction PIN.',
        });
      }
    }

    // Both paths require an OTP.
    if (!args.otp) {
      throw new BadRequestException({
        code: SEC_ERR.OTP_REQUIRED,
        message: 'Transaction OTP is required to complete this action.',
      });
    }
    await this.consumeOtp({
      userId: args.userId,
      code: args.otp,
      purpose: args.purpose,
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // helpers
  // ══════════════════════════════════════════════════════════════════════

  private async loadUserOrThrow(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async assertPasswordCorrect(
    user: { password: string },
    password: string,
  ) {
    if (!password) {
      throw new BadRequestException({
        code: SEC_ERR.PASSWORD_REQUIRED,
        message: 'Current account password is required.',
      });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      throw new ForbiddenException({
        code: SEC_ERR.PASSWORD_INCORRECT,
        message: 'Account password is incorrect.',
      });
    }
  }

  private assertPinFormat(pin: string) {
    if (!pin || pin.length !== PIN_LENGTH || !/^\d{4}$/.test(pin)) {
      throw new BadRequestException({
        code: SEC_ERR.PIN_FORMAT_INVALID,
        message: `PIN must be exactly ${PIN_LENGTH} digits (0-9).`,
      });
    }
  }

  private generateNumericCode(length: number): string {
    // `randomInt` is cryptographically strong; zero-pad to keep length stable.
    const max = 10 ** length;
    return String(randomInt(0, max)).padStart(length, '0');
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /**
   * Mask an email for display: keep the first letter of the local part,
   * three asterisks, then the unchanged domain. Matches the FE's expected
   * "m***@example.com" pattern.
   */
  private maskEmail(email: string): string {
    const at = email.indexOf('@');
    if (at < 1) return '***';
    const local = email.slice(0, at);
    const domain = email.slice(at);
    return `${local[0]}***${domain}`;
  }
}
