import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * How long a PENDING_PAYMENT withdrawal is allowed to sit before we treat
 * it as abandoned. Mirrors `PENDING_PAYMENT_TTL_MINUTES` in WithdrawalsService:
 * the soft reservation drops out of the availability calc at the same point
 * the row becomes a candidate for auto-rejection here.
 *
 * If you change this, change it in WithdrawalsService too — keeping them
 * in lock-step prevents the "still reserved by no-one" zombie state.
 */
const PENDING_PAYMENT_TTL_MINUTES = 30;

const AUTO_REJECTION_REASON =
  'Auto-expired: payment confirmation was not received in time.';

/**
 * Background cleanup for abandoned withdrawal flows.
 *
 * The lifecycle:
 *   1. WM (or client) submits a withdrawal → row created at PENDING_PAYMENT.
 *   2. If `confirmPayment` is never called, the row sits forever.
 *      The receipt stays ACTIVE (no ledger.hold happens until confirm), but
 *      the row clutters the WM's / admin's queue and looks "stuck."
 *
 * This service runs every 10 minutes, finds PENDING_PAYMENT withdrawals
 * older than the TTL, and marks them REJECTED with an auto-rejection
 * reason. No ledger work is required (no hold was ever placed), and the
 * client gets a single notification so they aren't surprised.
 *
 * Cadence note: 10 minutes is a balance — the TTL is 30 minutes, so a row
 * can linger for at worst (TTL + 10) = 40 minutes before cleanup. Tighter
 * cadence is fine but offers diminishing returns for our volume.
 */
@Injectable()
export class WithdrawalsCleanupService {
  private readonly log = new Logger(WithdrawalsCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, {
    name: 'withdrawals.expirePendingPayment',
  })
  async expirePendingPayment(): Promise<void> {
    const cutoff = new Date(
      Date.now() - PENDING_PAYMENT_TTL_MINUTES * 60 * 1000,
    );

    // Pull the rows we're about to reject so we can:
    //   - log a sample line per row (useful for spotting an over-reject bug)
    //   - fire one notification per client per row
    const expired = await this.prisma.withdrawal.findMany({
      where: {
        status: WithdrawalStatus.PENDING_PAYMENT,
        createdAt: { lt: cutoff },
      },
      select: {
        id: true,
        reference: true,
        clientId: true,
        tenantId: true,
        quantity: true,
        createdAt: true,
      },
    });

    if (expired.length === 0) return; // common case — quiet log

    const result = await this.prisma.withdrawal.updateMany({
      where: {
        id: { in: expired.map((w) => w.id) },
        // Re-check status in the update predicate so we never clobber a row
        // that another path (confirmPayment, manual reject) moved out of
        // PENDING_PAYMENT in the milliseconds between findMany and updateMany.
        status: WithdrawalStatus.PENDING_PAYMENT,
      },
      data: {
        status: WithdrawalStatus.REJECTED,
        rejectionReason: AUTO_REJECTION_REASON,
      },
    });

    this.log.log(
      `expired ${result.count}/${expired.length} abandoned PENDING_PAYMENT withdrawal(s) ` +
        `(cutoff=${cutoff.toISOString()}, TTL=${PENDING_PAYMENT_TTL_MINUTES}min)`,
    );

    // Best-effort client notifications. Done outside the updateMany on
    // purpose: the row state-change is what matters; a notification miss
    // doesn't corrupt anything. notifications.notifyUser swallows errors.
    for (const w of expired) {
      void this.notifications.notifyUser(w.clientId, {
        tenantId: w.tenantId,
        type: 'WITHDRAWAL_REJECTED',
        title: 'Withdrawal request expired',
        body:
          `${w.reference} was automatically cancelled because payment was ` +
          `not confirmed within ${PENDING_PAYMENT_TTL_MINUTES} minutes. ` +
          `If you still want to withdraw, please start a new request.`,
        relatedEntityType: 'withdrawal',
        relatedEntityId: w.id,
        data: { reason: AUTO_REJECTION_REASON, autoExpired: true },
      });
    }
  }
}
