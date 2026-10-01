import nodemailer, { type Transporter } from 'nodemailer';
import { env, emailConfigured, isProduction } from '../config/env';
import { logger } from '../config/logger';
import { scrubText } from '../utils/scrubPii';

/**
 * Transactional email over Gmail SMTP.
 *
 * In development the credentials are usually absent; rather than fail the
 * calling flow we log the message and carry on, so the password-reset journey
 * stays testable without a live mailbox. `env.ts` refuses to boot production
 * without them, so this fallback cannot silently swallow real mail.
 *
 * Gmail caps sending (roughly 500/day on a free account, 2,000 on Workspace).
 * That is ample for password resets at this volume, but it is a ceiling a
 * dedicated provider would not have.
 */
const transporter: Transporter | null = emailConfigured
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: env.SMTP_USER,
        // Google prints App Passwords in four groups; the spaces are
        // presentational and SMTP auth rejects them, so strip them here
        // rather than relying on whoever fills in .env to do it.
        pass: env.SMTP_APP_PASSWORD?.replace(/\s+/g, ''),
      },
    })
  : null;

// One line at boot, like Razorpay's and Cloudinary's — presence only, never the
// account or the password. (Production refuses to boot without SMTP, so the
// warning can only appear in development.)
if (transporter) {
  logger.info('SMTP configured');
} else {
  logger.warn('SMTP not configured — emails are not sent; codes are written to this log instead.');
}

/**
 * Signs in to Gmail once at startup, so a wrong App Password shows up in the
 * boot log rather than at the first customer's password reset.
 *
 * Called without being awaited (server.ts), so it never delays the server
 * starting to listen, and it never throws: a failure is a warning, and the
 * server keeps running — every send already handles a failed delivery.
 *
 * The warning carries Gmail's error message, never the credentials: the
 * account and the App Password (with or without its spaces) are stripped out
 * explicitly, and any other address or token is scrubbed as in error reports.
 */
export async function verifySmtpConnection(): Promise<void> {
  if (!transporter) return;
  try {
    await transporter.verify();
    logger.info('SMTP verified with Gmail');
  } catch (error) {
    logger.warn(`SMTP could not be verified with Gmail: ${withoutCredentials(error)}`);
  }
}

function withoutCredentials(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const password = env.SMTP_APP_PASSWORD ?? '';
  for (const secret of [env.SMTP_USER, password, password.replace(/\s+/g, '')]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return scrubText(message);
}

const BRAND = 'Manisha Fashions';
/** Matches the coral/rose primary used by the app's design system. */
const ACCENT = '#E5325B';

export interface SendResult {
  delivered: boolean;
  /**
   * Why the send failed, for diagnostics only.
   *
   * Callers on a request path must ignore this: forgot-password returns the
   * same generic response either way, and surfacing a provider error there
   * would reveal whether an address is registered.
   */
  error?: string;
}

type CodePurpose = 'reset' | 'verify' | 'change' | 'delete';

const COPY: Record<CodePurpose, { subject: string; heading: string; lead: string; ignore: string; log: string }> = {
  reset: {
    subject: `Reset your ${BRAND} password`,
    heading: 'Password reset',
    lead: 'Enter this code in the app to choose a new password.',
    ignore: "If you didn't ask for this, you can ignore this email — your password stays as it is.",
    log: 'password reset code',
  },
  verify: {
    subject: `Verify your ${BRAND} email`,
    heading: 'Verify your email',
    lead: 'Enter this code in the app to verify this email address.',
    ignore: "If you didn't ask for this, you can ignore this email.",
    log: 'email verification code',
  },
  change: {
    subject: `Confirm your new ${BRAND} email`,
    heading: 'Confirm your new email',
    lead: 'Enter this code in the app to make this your account email.',
    ignore: "If you didn't ask for this, you can ignore this email — no account will be changed.",
    log: 'email change code',
  },
  delete: {
    subject: `Confirm deleting your ${BRAND} account`,
    heading: 'Delete your account',
    lead: 'Enter this code on the account deletion page to permanently delete your account.',
    ignore: "If you didn't ask for this, ignore this email — your account stays exactly as it is.",
    log: 'account deletion code',
  },
};

export async function sendPasswordResetEmail(input: {
  to: string;
  code: string;
  expiresInMinutes: number;
}): Promise<SendResult> {
  return sendCodeEmail({ ...input, purpose: 'reset' });
}

/** The verify/change-email code, sent to the address being proven. */
export async function sendEmailVerificationCode(input: {
  to: string;
  code: string;
  expiresInMinutes: number;
  purpose: 'verify' | 'change';
}): Promise<SendResult> {
  return sendCodeEmail(input);
}

/** The code for the public account-deletion page (web, no app needed). */
export async function sendAccountDeletionCode(input: {
  to: string;
  code: string;
  expiresInMinutes: number;
}): Promise<SendResult> {
  return sendCodeEmail({ ...input, purpose: 'delete' });
}

async function sendCodeEmail(input: {
  to: string;
  code: string;
  expiresInMinutes: number;
  purpose: CodePurpose;
}): Promise<SendResult> {
  const { to, code, expiresInMinutes, purpose } = input;
  const copy = COPY[purpose];
  const subject = copy.subject;

  if (!transporter) {
    // Dev-only escape hatch: visible to the developer, never to a user.
    logger.warn(`[email:dev] ${copy.log} for ${to} → ${code}`);
    return { delivered: false };
  }

  try {
    // Gmail overrides any other From with the authenticated account, so the
    // display name is the only part worth setting here.
    await transporter.sendMail({
      from: `${BRAND} <${env.SMTP_USER}>`,
      to,
      subject,
      text: plainTextBody(copy, code, expiresInMinutes),
      html: htmlBody(copy, code, expiresInMinutes),
    });
    return { delivered: true };
  } catch (error) {
    // Never surfaced to the caller: the endpoint returns the same generic
    // response either way, so a send failure cannot be used to probe for
    // registered addresses.
    logger.error(`Email (${purpose}) failed to send`, error);
    if (!isProduction) logger.warn(`[email:fallback] ${to} → ${code}`);
    return { delivered: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Tells the address an account is LEAVING that its email was changed.
 *
 * The new address gets the code; this goes to the old one, which is the only
 * inbox the real owner still controls if the change was not theirs. Sent
 * after the change is committed and never allowed to block it — a bounced
 * notice must not undo a change the user legitimately made.
 */
export async function sendEmailChangedNotice(
  previousEmail: string,
  newEmail: string,
): Promise<SendResult> {
  const subject = `Your ${BRAND} email address was changed`;
  // The new address is shown partly masked: if this notice reaches the wrong
  // person, it should not hand them the whole address to go after.
  const masked = maskEmail(newEmail);
  const lines = [
    BRAND,
    '',
    `The email address on your account was changed to ${masked}.`,
    '',
    'You have been signed out on every device.',
    '',
    "If this was you, there is nothing to do. If it was NOT you, contact us immediately — whoever made the change now receives mail for this account.",
  ];

  if (!transporter) {
    logger.warn(`[email:dev] email-changed notice for ${previousEmail}`);
    return { delivered: false };
  }

  try {
    await transporter.sendMail({
      from: `${BRAND} <${env.SMTP_USER}>`,
      to: previousEmail,
      subject,
      text: lines.join('\n'),
      html: noticeHtml(subject, lines),
    });
    return { delivered: true };
  } catch (error) {
    logger.error('Email (change-notice) failed to send', error);
    return { delivered: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** `someone@example.com` → `so•••@example.com`. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '•••';
  const head = local.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}

function noticeHtml(heading: string, lines: string[]): string {
  const body = lines
    .slice(2)
    .filter(Boolean)
    .map((line) => `<p style="margin:0 0 14px;color:#4A4A4A;line-height:1.6">${line}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#FAFAFA;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:16px;padding:32px">
    <p style="margin:0 0 4px;color:${ACCENT};font-weight:700;letter-spacing:.04em">${BRAND}</p>
    <h1 style="margin:0 0 18px;font-size:20px;color:#1A1A1A">${heading}</h1>
    ${body}
  </div></body></html>`;
}

function plainTextBody(copy: (typeof COPY)[CodePurpose], code: string, minutes: number): string {
  return [
    `${BRAND}`,
    '',
    copy.lead,
    '',
    'Your verification code is:',
    '',
    `    ${code}`,
    '',
    `This code expires in ${minutes} minutes and can only be used once.`,
    '',
    copy.ignore,
  ].join('\n');
}

function htmlBody(copy: (typeof COPY)[CodePurpose], code: string, minutes: number): string {
  // The code is spaced out and set in a monospace face so it survives being
  // read off one screen and typed into another.
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#FBF7F4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2B2B2B;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#FFFFFF;border-radius:14px;padding:32px;">
      <tr><td>
        <h1 style="margin:0 0 4px;font-size:20px;letter-spacing:0.02em;color:${ACCENT};">${BRAND}</h1>
        <p style="margin:0 0 24px;font-size:13px;color:#8A8A8A;">${copy.heading}</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">${copy.lead}</p>
        <div style="margin:0 0 24px;padding:20px;background:#FBF7F4;border-radius:12px;text-align:center;">
          <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:${ACCENT};">${code}</span>
        </div>
        <p style="margin:0 0 8px;font-size:13px;color:#6B6B6B;">This code expires in ${minutes} minutes and can only be used once.</p>
        <p style="margin:0;font-size:13px;color:#6B6B6B;">${copy.ignore}</p>
      </td></tr>
    </table>
  </body>
</html>`;
}
