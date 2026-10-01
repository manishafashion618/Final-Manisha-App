/**
 * Sends one real password-reset email, to check the mail route is wired up
 * correctly before any customer depends on it: Brevo's API when
 * BREVO_API_KEY is set, Gmail SMTP otherwise.
 *
 * Keys and passwords are read from .env — never passed on the command line,
 * where they would land in shell history and in the process list.
 *
 *   npm run email:test -- you@example.com
 */
import { brevoConfigured, env, emailConfigured } from '../config/env';
import { sendPasswordResetEmail } from '../services/email.service';

function fail(message: string, hint?: string): never {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`\n${hint}`);
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const to = process.argv[2];

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    fail(
      'Pass the recipient address.',
      'Usage:\n  npm run email:test -- you@example.com',
    );
  }

  if (!emailConfigured) {
    const missing = [
      !env.SMTP_USER && 'SMTP_USER',
      !env.SMTP_APP_PASSWORD && 'SMTP_APP_PASSWORD',
    ].filter(Boolean);
    fail(
      `No mail route is configured — set BREVO_API_KEY, or ${missing.join(' and ')}.`,
      `Set them in backend/.env:\n` +
        `  BREVO_API_KEY=<key from Brevo → SMTP & API → API keys>\n` +
        `or, for Gmail SMTP:\n` +
        `  SMTP_USER=you@gmail.com\n` +
        `  SMTP_APP_PASSWORD=<16-character App Password>\n\n` +
        `Generate one at Google Account → Security → 2-Step Verification →\n` +
        `App Passwords. It is not your normal Gmail password.`,
    );
  }

  console.log(`\nVia:  ${brevoConfigured ? 'Brevo API' : `Gmail SMTP (${env.SMTP_USER})`}`);
  console.log(`To:   ${to}`);

  if (!brevoConfigured) {
    // Gmail rewrites From to the authenticated account, so mail always appears
    // to come from SMTP_USER regardless of what the app asks for.
    console.log('\nNote: Gmail sends as the authenticated account and caps volume');
    console.log('      (~500/day free, ~2,000 on Workspace).');
  }
  console.log('');

  // The genuine template and code path, not a throwaway "hello" — so what
  // arrives is exactly what a customer would receive.
  const result = await sendPasswordResetEmail({
    to,
    code: '123456',
    expiresInMinutes: env.PASSWORD_RESET_OTP_TTL_MINUTES,
  });

  if (!result.delivered) {
    fail(
      `${brevoConfigured ? 'Brevo' : 'Gmail'} rejected the send: ${result.error ?? 'unknown error'}`,
      brevoConfigured
        ? 'Common causes: the API key is wrong or revoked, or the sender address is\n' +
            'not a verified sender in the Brevo account.'
        : 'Common causes: the App Password was revoked or mistyped, 2-Step\n' +
            'Verification is off on the account, or the daily send cap was hit.',
    );
  }

  console.log('\n✓ Sent. Check the inbox (and the spam folder).');
  console.log('  The code in it is a placeholder and will not reset anything.\n');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
