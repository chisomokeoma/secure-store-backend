import { Injectable, Logger } from '@nestjs/common';

/**
 * Outbound email transport.
 *
 * In dev / right now: stub that logs the message. The reset URL prints to
 * the server console so you can copy-paste it during testing without any
 * email provider configured.
 *
 * To swap in real delivery (Resend / SES / SendGrid / SMTP), replace the
 * body of `send()` with the provider call. The rest of the codebase only
 * touches the typed methods below, so nothing else has to change.
 */
@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);

  async sendPasswordResetEmail(args: {
    to: string;
    firstName?: string | null;
    resetUrl: string;
    expiresInMinutes: number;
  }): Promise<void> {
    const greeting = args.firstName ? `Hi ${args.firstName},` : 'Hi,';
    const subject = 'Reset your SecureStore password';
    const text = [
      greeting,
      '',
      'We received a request to reset your SecureStore password.',
      `Open this link within ${args.expiresInMinutes} minutes to choose a new one:`,
      args.resetUrl,
      '',
      "If you didn't request this, you can ignore this email — your password won't change.",
      '',
      '— SecureStore',
    ].join('\n');

    await this.send({ to: args.to, subject, text });
  }

  /** Lowest-level transport. Replace with provider SDK call to ship for real. */
  private async send(msg: {
    to: string;
    subject: string;
    text: string;
  }): Promise<void> {
    // Stub: log loudly so it's obvious in dev. Real provider call goes here.
    this.log.log(
      `[email:stub] to=${msg.to}  subject="${msg.subject}"\n${msg.text}`,
    );
  }
}
