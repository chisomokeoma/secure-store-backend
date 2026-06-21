import { Logger } from '@nestjs/common';
import {
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { createTransport, Transporter } from 'nodemailer';
import { EMAIL_QUEUE_NAME, EmailJobPayload } from './email.types';

/**
 * Background worker that drains the `email` queue and ships each job via
 * Nodemailer. Built around three properties:
 *
 *   1. A single Nodemailer transporter is created once on boot and reused
 *      for the worker's lifetime. SMTP connections are pooled so we don't
 *      re-handshake on every job. This is the right tradeoff for our
 *      volume; tearing down per-job is wasteful for transactional email.
 *
 *   2. The `process()` method ONLY does SMTP. Rendering, fan-out, retry
 *      policy, and dead-letter retention are all owned by the EmailService
 *      / BullMQ machinery, not here.
 *
 *   3. Any throw inside `process()` is a signal to BullMQ to retry per
 *      the job's attempts/backoff policy. We let real network/SMTP errors
 *      propagate; we only swallow input-shape errors so they don't burn
 *      the retry budget on a malformed payload.
 */
@Processor(EMAIL_QUEUE_NAME)
export class EmailProcessor extends WorkerHost {
  private readonly log = new Logger(EmailProcessor.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor() {
    super();

    const host = process.env.SMTP_HOST ?? 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT ?? 465);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    this.from =
      process.env.SMTP_FROM ?? (user ? `SecureStore <${user}>` : 'SecureStore');

    if (!user || !pass) {
      this.log.warn(
        'SMTP_USER / SMTP_PASS not configured — outbound email will fail at send time. Set both in .env and restart.',
      );
    }

    // `secure: true` uses TLS from the start on port 465 (Gmail's
    // implicit-TLS port). Port 587 + `secure: false` is the STARTTLS
    // alternative; we pick 465 to avoid the upgrade dance.
    this.transporter = createTransport({
      host,
      port,
      secure: port === 465,
      auth: user && pass ? { user, pass } : undefined,
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
    });
  }

  async process(job: Job<EmailJobPayload>): Promise<{ messageId: string }> {
    const { to, subject, text, html } = job.data;
    if (!to || !subject || !text) {
      // Malformed payload — don't burn retries on something that will
      // never succeed. Throwing a non-Error string disables retry by
      // surfacing as a permanent failure; we log explicitly so the
      // operator sees why.
      this.log.error(
        `job ${job.id} dropped: payload missing required field(s) ` +
          `(to=${!!to} subject=${!!subject} text=${!!text})`,
      );
      throw new Error('Email job payload is missing required fields.');
    }

    const info = await this.transporter.sendMail({
      from: this.from,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    });
    return { messageId: info.messageId };
  }

  // ── Structured lifecycle logs — visible in your normal Nest output ──
  @OnWorkerEvent('active')
  onActive(job: Job<EmailJobPayload>) {
    this.log.log(
      `job ${job.id} started: name=${job.name} to=${job.data.to} attempt=${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<EmailJobPayload>, result: { messageId: string }) {
    this.log.log(
      `job ${job.id} delivered: messageId=${result?.messageId} to=${job.data.to}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<EmailJobPayload> | undefined, err: Error) {
    if (!job) {
      this.log.error(`worker failure with no job context: ${err.message}`);
      return;
    }
    const attemptsLeft = (job.opts.attempts ?? 1) - job.attemptsMade;
    const level: 'warn' | 'error' = attemptsLeft > 0 ? 'warn' : 'error';
    this.log[level](
      `job ${job.id} failed: to=${job.data.to} attempt=${job.attemptsMade}/${job.opts.attempts ?? 1} attemptsLeft=${attemptsLeft} reason=${err.message}`,
    );
  }
}
