import { Logger } from '@nestjs/common';

const log = new Logger('EmailRecipient');

/**
 * Minimal shape we need to decide where to send mail. Both User and
 * ClientProfile.user satisfy this — no need to import the full Prisma type.
 */
export interface DeliverableUser {
  id?: string;
  email: string;             // system-issued login alias (@securestore.com)
  contactEmail?: string | null; // user's real mailbox, captured on creation
}

/**
 * The single rule for transactional email delivery in this codebase:
 *
 *   Send to the user's real `contactEmail` whenever it's on file. Fall back
 *   to the system login alias (@securestore.com) ONLY for legacy users who
 *   never had a contact captured (e.g. the slim seed's tenant admin before
 *   patching, or pre-refactor accounts).
 *
 * Why this matters:
 *   - The @securestore.com aliases are USERNAMES, not inboxes. They look
 *     like email addresses so they slot into "email + password" login UIs,
 *     but no one is ever asked to maintain a securestore.com mailbox.
 *   - Every transactional message — password reset, OTP, future welcome
 *     credentials, future deep-link notification emails — must reach the
 *     user's real address to be useful.
 *
 * Falling back to the login alias is a soft warning, not an error: the send
 * still happens (Bull MQ will retry; the SMTP layer may reject and the
 * processor logs it). This signal is more useful than a silent default for
 * the "huh, why didn't they get the email?" debugging case.
 */
export function resolveDeliveryEmail(user: DeliverableUser): string {
  if (user.contactEmail && user.contactEmail.trim().length > 0) {
    return user.contactEmail.trim();
  }
  log.warn(
    `Falling back to login alias for user ${user.id ?? '<unknown>'} ` +
      `(${user.email}) — no contactEmail on file. ` +
      `This delivery is likely to bounce.`,
  );
  return user.email;
}
