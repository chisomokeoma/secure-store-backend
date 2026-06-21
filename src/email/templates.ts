/**
 * Transactional email templates — plain text + HTML, rendered together so
 * the EmailService can hand both to BullMQ in a single job payload.
 *
 * Design constraints these templates respect:
 *   • Inline styles only. Outlook, the iOS Mail app, Gmail's web client and
 *     several others strip `<style>` blocks. Anything cosmetic must live
 *     directly on the element.
 *   • Table-based layout. A modern flexbox stack would be fine in iOS Mail
 *     but breaks in Outlook 2016+, which is still ~10% of inboxes for
 *     business users. Tables are the lowest common denominator.
 *   • 600px max width. Wider gets clipped on phones in landscape.
 *   • Plain-text fallback always rendered, never auto-generated from the
 *     HTML. Some inboxes (and accessibility tools) prefer text/plain and
 *     a hand-written version reads much better.
 *   • Preheader text — the tiny preview snippet inboxes show next to the
 *     subject. Set per-template; defaults to a generic line if omitted.
 *
 * Each render fn returns { subject, text, html } so the EmailService can
 * stay agnostic about how a given email is shaped.
 */

interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const BRAND = 'SecureStore';
const ACCENT = '#6366F1'; // Indigo-500, matches the FE's primary
const INK = '#0F172A'; // Slate-900 — body copy
const MUTED = '#64748B'; // Slate-500 — meta lines, footer
const BG = '#F1F5F9'; // Slate-100 — page background
const CARD = '#FFFFFF';
const BORDER = '#E2E8F0'; // Slate-200

/**
 * Shared shell. Every transactional email goes through this — header band,
 * white card body, footer disclaimer. The `body` param is the unique HTML
 * for the specific email type and is dropped into the middle.
 *
 * `preheader` is the snippet inbox lists show after the subject ("Reset
 * your SecureStore password — click within 30 minutes"). Hidden visually
 * via an absolutely-positioned span; renders in the inbox metadata only.
 */
function shell(opts: { preheader: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>${BRAND}</title>
</head>
<body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK};">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${escapeHtml(opts.preheader)}</span>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:${CARD};border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
      <tr><td style="padding:24px 32px;background:${ACCENT};">
        <div style="font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:0.3px;">${BRAND}</div>
      </td></tr>
      <tr><td style="padding:32px;font-size:15px;line-height:1.55;color:${INK};">
        ${opts.body}
      </td></tr>
      <tr><td style="padding:20px 32px;border-top:1px solid ${BORDER};font-size:12px;color:${MUTED};line-height:1.5;">
        You're receiving this email because of activity on your ${BRAND} account.<br />
        If this wasn't you, please ignore the message or reset your password.<br />
        <br />
        © ${new Date().getFullYear()} ${BRAND}. All rights reserved.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Templates ─────────────────────────────────────────────────────────────

export function renderPasswordResetEmail(args: {
  firstName?: string | null;
  resetUrl: string;
  expiresInMinutes: number;
}): RenderedEmail {
  const subject = `Reset your ${BRAND} password`;
  const greeting = args.firstName
    ? `Hi ${args.firstName},`
    : 'Hi,';
  const ttl = `${args.expiresInMinutes} minutes`;
  const preheader = `Use this link within ${ttl} to set a new password.`;

  const text = [
    greeting,
    '',
    `We received a request to reset your ${BRAND} password.`,
    `Open this link within ${ttl} to choose a new one:`,
    args.resetUrl,
    '',
    "If you didn't request this, you can ignore this email — your password won't change.",
    '',
    `— ${BRAND}`,
  ].join('\n');

  const body = `
<p style="margin:0 0 12px;font-size:16px;font-weight:600;color:${INK};">${escapeHtml(greeting)}</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:${INK};">
  We received a request to reset your ${BRAND} password. Click the button below to choose a new one — the link is valid for the next <strong>${ttl}</strong>.
</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
  <tr><td style="border-radius:8px;background:${ACCENT};">
    <a href="${escapeHtml(args.resetUrl)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">
      Reset password
    </a>
  </td></tr>
</table>
<p style="margin:0 0 6px;font-size:13px;color:${MUTED};">
  Button not working? Paste this URL into your browser:
</p>
<p style="margin:0 0 24px;font-size:13px;line-height:1.5;word-break:break-all;">
  <a href="${escapeHtml(args.resetUrl)}" style="color:${ACCENT};text-decoration:underline;">${escapeHtml(args.resetUrl)}</a>
</p>
<p style="margin:0;font-size:13px;color:${MUTED};line-height:1.55;">
  If you didn't request this, ignore the email — your password won't change.
</p>`;

  return { subject, text, html: shell({ preheader, body }) };
}

export function renderTransactionOtpEmail(args: {
  firstName?: string | null;
  code: string;
  purpose: string;
  expiresInMinutes: number;
}): RenderedEmail {
  const niceName = humanizePurpose(args.purpose);
  const subject = `Your ${BRAND} ${niceName} code`;
  const greeting = args.firstName ? `Hi ${args.firstName},` : 'Hi,';
  const ttl = `${args.expiresInMinutes} minutes`;
  const preheader = `Your one-time code for ${niceName} — expires in ${ttl}.`;

  const text = [
    greeting,
    '',
    `Your one-time code to approve this ${niceName} is:`,
    '',
    `    ${args.code}`,
    '',
    `It expires in ${ttl}.`,
    '',
    "If you didn't request this, ignore this email and consider changing",
    'your password — someone may know your sign-in details.',
    '',
    `— ${BRAND}`,
  ].join('\n');

  const body = `
<p style="margin:0 0 12px;font-size:16px;font-weight:600;color:${INK};">${escapeHtml(greeting)}</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:${INK};">
  Use this one-time code to approve your <strong>${escapeHtml(niceName)}</strong>:
</p>
<div style="margin:0 0 24px;padding:18px 20px;border:1px solid ${BORDER};background:#F8FAFC;border-radius:10px;text-align:center;">
  <div style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:30px;letter-spacing:8px;font-weight:700;color:${INK};">
    ${escapeHtml(args.code)}
  </div>
  <div style="margin-top:8px;font-size:12px;color:${MUTED};">expires in ${ttl}</div>
</div>
<p style="margin:0;font-size:13px;color:${MUTED};line-height:1.55;">
  If you didn't request this, ignore the email and consider changing your password — someone may know your sign-in details.
</p>`;

  return { subject, text, html: shell({ preheader, body }) };
}

export function renderWelcomeEmail(args: {
  firstName?: string | null;
  loginEmail: string;
  tempPassword: string;
  clientCode: string;
  signInUrl: string;
}): RenderedEmail {
  const subject = `Welcome to ${BRAND} — your account is ready`;
  const greeting = args.firstName ? `Hi ${args.firstName},` : 'Hi,';
  const preheader = `Your ${BRAND} login is ready — sign in and change your temporary password.`;

  const text = [
    greeting,
    '',
    `Your warehouse manager has created a ${BRAND} account for you.`,
    `Use these credentials to sign in:`,
    '',
    `   Login email:        ${args.loginEmail}`,
    `   Temporary password: ${args.tempPassword}`,
    `   Client ID:          ${args.clientCode}`,
    '',
    'For your security, please sign in and change the temporary password',
    'as soon as possible. You will be asked to verify the change with a code',
    'sent to this email address.',
    '',
    `Sign in here: ${args.signInUrl}`,
    '',
    "If you didn't expect this email, please contact your warehouse manager.",
    '',
    `— ${BRAND}`,
  ].join('\n');

  const body = `
<p style="margin:0 0 12px;font-size:16px;font-weight:600;color:${INK};">${escapeHtml(greeting)}</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:${INK};">
  Your warehouse manager has created a ${BRAND} account for you. Use the credentials below to sign in for the first time.
</p>
<div style="margin:0 0 24px;padding:16px 18px;border:1px solid ${BORDER};background:#F8FAFC;border-radius:10px;font-size:14px;line-height:1.65;color:${INK};">
  <div style="display:block;margin-bottom:8px;">
    <span style="color:${MUTED};font-size:12px;text-transform:uppercase;letter-spacing:0.6px;display:block;">Login email</span>
    <span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:14px;font-weight:600;">${escapeHtml(args.loginEmail)}</span>
  </div>
  <div style="display:block;margin-bottom:8px;">
    <span style="color:${MUTED};font-size:12px;text-transform:uppercase;letter-spacing:0.6px;display:block;">Temporary password</span>
    <span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:14px;font-weight:600;">${escapeHtml(args.tempPassword)}</span>
  </div>
  <div style="display:block;">
    <span style="color:${MUTED};font-size:12px;text-transform:uppercase;letter-spacing:0.6px;display:block;">Client ID</span>
    <span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:14px;font-weight:600;">${escapeHtml(args.clientCode)}</span>
  </div>
</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
  <tr><td style="border-radius:8px;background:${ACCENT};">
    <a href="${escapeHtml(args.signInUrl)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">
      Sign in to ${BRAND}
    </a>
  </td></tr>
</table>
<p style="margin:0 0 14px;font-size:13px;color:${MUTED};line-height:1.55;">
  <strong style="color:${INK};">Important:</strong> please change the temporary password as soon as you sign in. We'll send a one-time code to <strong style="color:${INK};">this email address</strong> to confirm the change — make sure you have access to this inbox before you start.
</p>
<p style="margin:0;font-size:13px;color:${MUTED};line-height:1.55;">
  If you didn't expect this email, please contact your warehouse manager.
</p>`;

  return { subject, text, html: shell({ preheader, body }) };
}

export function renderTestEmail(): RenderedEmail {
  const subject = `${BRAND} email pipeline test`;
  const preheader = `If you can read this, the pipeline works.`;

  const text = [
    'This is a test message sent via the SecureStore email pipeline.',
    '',
    'If you can read this, the chain is working:',
    '   Nest service → BullMQ queue → Worker → Nodemailer → Gmail SMTP → inbox.',
    '',
    'No action is required. You can ignore or delete this message.',
    '',
    `— ${BRAND}`,
  ].join('\n');

  const body = `
<p style="margin:0 0 12px;font-size:16px;font-weight:600;color:${INK};">Pipeline test ✅</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:${INK};">
  This is a test message sent via the ${BRAND} email pipeline. If you're reading this in your inbox, the full chain is healthy:
</p>
<div style="margin:0 0 24px;padding:14px 18px;border:1px solid ${BORDER};background:#F8FAFC;border-radius:10px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:13px;line-height:1.65;color:${INK};">
  Nest service → BullMQ queue → Worker → Nodemailer → Gmail SMTP → inbox
</div>
<p style="margin:0;font-size:13px;color:${MUTED};">
  No action is required. You can ignore or delete this message.
</p>`;

  return { subject, text, html: shell({ preheader, body }) };
}

function humanizePurpose(purpose: string): string {
  switch (purpose) {
    case 'WITHDRAWAL':
      return 'withdrawal';
    case 'LOAN':
      return 'loan';
    case 'TRADE':
      return 'trade';
    case 'DISABLE_2FA':
      return '2FA-disable';
    default:
      return purpose.toLowerCase();
  }
}
