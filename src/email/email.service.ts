import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EMAIL_QUEUE_NAME, EmailJobName, EmailJobPayload } from './email.types';
import {
  renderPasswordResetEmail,
  renderTransactionOtpEmail,
  renderTestEmail,
  renderWelcomeEmail,
} from './templates';

/**
 * Outbound email transport — producer side.
 *
 * Every public method on this service is a thin renderer that:
 *   1. Builds { subject, text, html } via templates.ts
 *   2. Enqueues an EmailJobPayload on the BullMQ `email` queue
 *
 * The actual SMTP work happens in the EmailProcessor worker so the caller
 * (e.g. AuthService.forgotPassword) never blocks waiting on Gmail /
 * Resend / etc.
 *
 * To swap providers, see EmailProcessor — this file is provider-agnostic
 * and stays the same regardless of who delivers the mail.
 */
@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);

  constructor(
    @InjectQueue(EMAIL_QUEUE_NAME) private readonly queue: Queue,
  ) {}

  /**
   * Deliver a 2FA transaction OTP. Subject + body include the purpose so a
   * client receiving multiple codes (e.g. a withdrawal and a loan in flight
   * back-to-back) can tell which is which. The raw code is in the body —
   * never in subject lines, never logged anywhere except this service.
   */
  async sendTransactionOtpEmail(args: {
    to: string;
    firstName?: string | null;
    code: string;
    purpose: string;
    expiresInMinutes: number;
  }): Promise<void> {
    const { subject, text, html } = renderTransactionOtpEmail({
      firstName: args.firstName,
      code: args.code,
      purpose: args.purpose,
      expiresInMinutes: args.expiresInMinutes,
    });
    await this.send({ to: args.to, subject, text, html });
  }

  /**
   * Welcome email sent the moment a WM creates a client. Carries the
   * system-issued login alias + temp password + a CTA to the sign-in page,
   * plus the "first thing you do is change the password and you'll need
   * this inbox to confirm it" warning. Delivered to the client's
   * contactEmail via the resolveDeliveryEmail convention upstream.
   */
  async sendWelcomeEmail(args: {
    to: string;
    firstName?: string | null;
    loginEmail: string;
    tempPassword: string;
    clientCode: string;
    signInUrl: string;
  }): Promise<void> {
    const { subject, text, html } = renderWelcomeEmail({
      firstName: args.firstName,
      loginEmail: args.loginEmail,
      tempPassword: args.tempPassword,
      clientCode: args.clientCode,
      signInUrl: args.signInUrl,
    });
    await this.send({ to: args.to, subject, text, html });
  }

  async sendPasswordResetEmail(args: {
    to: string;
    firstName?: string | null;
    resetUrl: string;
    expiresInMinutes: number;
  }): Promise<void> {
    const { subject, text, html } = renderPasswordResetEmail({
      firstName: args.firstName,
      resetUrl: args.resetUrl,
      expiresInMinutes: args.expiresInMinutes,
    });
    await this.send({ to: args.to, subject, text, html });
  }

  /**
   * Enqueue a pre-rendered transactional email for delivery. The actual
   * SMTP work happens in the EmailProcessor worker — we never block the
   * caller waiting for Gmail / Resend / etc.
   *
   * Job options:
   *  - 5 attempts with exponential backoff (1s, 5s, 25s, ~2min, ~10min).
   *  - Older job records auto-purge so Redis doesn't grow forever: keep
   *    the last 100 completed jobs and 1000 failed (for post-mortem).
   *
   * Note: we render subject + text + html BEFORE enqueueing. That's
   * intentional — the message the recipient will see is locked in at the
   * moment the domain decided to send. Template changes mid-flight don't
   * retroactively alter queued messages.
   */
  private async send(msg: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void> {
    await this.queue.add(
      EmailJobName.GENERIC,
      {
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      } satisfies EmailJobPayload,
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 1000 },
      },
    );
    this.log.debug(`enqueued email to=${msg.to} subject="${msg.subject}"`);
  }

  /**
   * Admin smoke-test path. Used by POST /admin/email/test to verify the
   * Redis ↔ BullMQ ↔ Nodemailer ↔ Gmail chain end-to-end without having
   * to trigger a real password-reset or OTP flow.
   */
  async enqueueTest(args: { to: string }): Promise<{ jobId: string }> {
    const { subject, text, html } = renderTestEmail();
    const job = await this.queue.add(
      EmailJobName.TEST,
      { to: args.to, subject, text, html } satisfies EmailJobPayload,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 100 },
      },
    );
    return { jobId: String(job.id) };
  }
}
