import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PledgesService } from './pledges.service';

/**
 * Cron for expiring stale pledges. Runs every 10 minutes — same cadence
 * as WithdrawalsCleanupService for consistency and to keep the "you can
 * see the effect within 10 min of expiry" UX guarantee.
 *
 * Design choice: in-process `@Cron` (via @nestjs/schedule) rather than
 * BullMQ repeat jobs. Same reasoning as the withdrawal cleanup — the
 * batch is small (usually 0-5 pledges per tick), the work is idempotent
 * (each pledge expiration uses a stable idempotency key), and single-
 * instance execution is fine. If we scale horizontally, promote to
 * BullMQ or add a distributed lock.
 */
@Injectable()
export class PledgesCleanupService {
  private readonly log = new Logger(PledgesCleanupService.name);

  constructor(private readonly pledges: PledgesService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireStalePledges() {
    try {
      const { expired } = await this.pledges.expireStalePledges();
      if (expired > 0) {
        this.log.log(`Expired ${expired} stale pledge(s)`);
      }
    } catch (err) {
      // Don't let a cron failure crash the process. The next tick picks
      // up whatever we missed — pledge expiration is idempotent via the
      // ledger's idempotencyKey.
      this.log.error('Pledge expiration cron failed', err as Error);
    }
  }
}
