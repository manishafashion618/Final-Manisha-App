import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * Fail-fast environment parsing. PRD 8.11 keeps every secret in .env; this
 * schema is the single place that decides what is required to boot.
 */
/**
 * `KEY=` in a .env file arrives as an empty string, not as absent. `.optional()`
 * only accepts `undefined`, so a blank line on a validated field (an email, a
 * URL) fails the whole parse and the server refuses to boot — which is exactly
 * what .env.example produces on a fresh copy. Normalise blanks to undefined.
 */
const blankable = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const csv = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/api/v1'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be a long random value'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be a long random value'),
  JWT_ACCESS_TTL: z.string().default('30m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(90),

  CLOUDINARY_CLOUD_NAME: blankable(z.string().optional()),
  CLOUDINARY_API_KEY: blankable(z.string().optional()),
  CLOUDINARY_API_SECRET: blankable(z.string().optional()),
  CLOUDINARY_FOLDER: z.string().default('manisha-fashions/products'),

  RAZORPAY_KEY_ID: blankable(z.string().optional()),
  RAZORPAY_KEY_SECRET: blankable(z.string().optional()),
  RAZORPAY_WEBHOOK_SECRET: blankable(z.string().optional()),

  /**
   * The COD fallback, in paise, for a state with no CodStateConfig row.
   *
   * Per-state overrides live in the `codstateconfigs` collection and are
   * managed from the admin COD Settings screen; this pair is what applies
   * until a state is configured, so COD works on a fresh database.
   */
  COD_SHIPPING_CHARGE: z.coerce.number().int().nonnegative().default(5000),
  /**
   * COD customers pay the shipping/COD charge ONLINE (Razorpay) before the
   * order is confirmed; only the product amount is collected in cash. Needs
   * Razorpay configured — without it, COD with a charge cannot be placed. Set
   * to false to collect everything in cash (the previous behaviour).
   */
  COD_SHIPPING_PAID_ONLINE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Set to false to make COD opt-in: off everywhere except states admin enables. */
  COD_DEFAULT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  PREPAID_SHIPPING_CHARGE: z.coerce.number().int().nonnegative().default(0),
  CURRENCY: z.string().default('INR'),

  CORS_ORIGINS: z.string().default('').transform(csv),
  RATE_LIMIT_GENERAL_PER_MIN: z.coerce.number().int().positive().default(100),
  // Auth endpoints keep a tighter ceiling than the rest of the API. Overridable
  // so an automated run can lift it. The per-email reset quota in auth.service
  // is the finer-grained control and is unaffected by this value.
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(20),
  TRUST_PROXY: z.string().default('1'),

  /**
   * Emails that always hold the admin role, re-applied on every sign-in.
   *
   * The email equivalent of the phone whitelist that phone+OTP login used:
   * a fresh deployment — or a restored backup — still has a way in without a
   * manual database edit, and the role cannot be lost by an accidental change
   * on the accounts screen.
   *
   * Treat this as a credential. Anyone who can sign in as a listed address
   * gets full admin: pricing, every account, every order.
   */
  ADMIN_EMAILS: z.string().default('').transform(csv),

  // ── Seed / bootstrap admin ──
  // Phone+OTP login was removed, so the first admin needs an email credential
  // or the admin panel is unreachable on a fresh database.
  SEED_ADMIN_EMAIL: z.string().email().default('admin@manishafashions.in'),
  /** No default: the seed script refuses to run without one (scripts/seed.ts). */
  SEED_ADMIN_PASSWORD: blankable(z.string().min(8, 'SEED_ADMIN_PASSWORD must be at least 8 characters').optional()),

  // ── Google Sign-In ──
  /**
   * The WEB OAuth client id (…apps.googleusercontent.com), used as the only
   * accepted `aud` of a Google ID token.
   *
   * The Android app signs in natively and is configured with this same web
   * client id (`webClientId`), so the tokens it mints carry the web id as their
   * audience. The Android OAuth client must exist in Cloud Console, but its id
   * never appears in a token and is not configured here.
   */
  GOOGLE_WEB_CLIENT_ID: blankable(z.string().trim().optional()),

  // ── Transactional email ──
  /**
   * Brevo's HTTPS API. When set, all mail goes through it and SMTP is not
   * used at all: Render's free tier blocks outbound SMTP, so in production
   * this is the only way mail leaves the server.
   */
  BREVO_API_KEY: blankable(z.string().trim().optional()),
  // Gmail SMTP via nodemailer — the fallback when BREVO_API_KEY is unset.
  SMTP_USER: blankable(z.string().email('SMTP_USER must be an email address').optional()),
  /**
   * A Gmail *App Password* (16 characters, usually shown in four groups),
   * never the account login password. Requires 2-Step Verification on the
   * account. Spaces are tolerated — Google displays it with them.
   */
  SMTP_APP_PASSWORD: blankable(z.string().optional()),

  // ── Password reset (email OTP → short-lived token → new password) ──
  /** How long the emailed 6-digit code stays valid. */
  PASSWORD_RESET_OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  /**
   * Life of the token minted once the code is verified. Deliberately short:
   * it is only carried from the OTP screen to the new-password screen.
   */
  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  /** Wrong codes tolerated per email before the lockout below. */
  PASSWORD_RESET_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PASSWORD_RESET_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(10),
  /** Per email *and* per IP, enforced in the reset service (PRD 8.11). */
  FORGOT_PASSWORD_MAX_PER_HOUR: z.coerce.number().int().positive().default(3),

  // ── Error reporting ──
  /** Sentry DSN. Unset = reporting off. */
  SENTRY_DSN: blankable(z.string().url().optional()),
  SENTRY_ENVIRONMENT: blankable(z.string().optional()),

  // ── Online payments left unfinished ──
  /** An unpaid online order is expired, and its stock released, after this long. */
  PENDING_PAYMENT_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  /** How often the server sweeps for such orders (also once at boot). */
  ORDER_EXPIRY_SWEEP_MINUTES: z.coerce.number().int().positive().default(5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // Boot-time failure: no point starting a server that cannot reach its stores.
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';

/** Brevo's HTTPS API is used whenever its key is set; SMTP only otherwise. */
export const brevoConfigured = Boolean(env.BREVO_API_KEY);
export const smtpConfigured = Boolean(env.SMTP_USER && env.SMTP_APP_PASSWORD);
/** Some real way to send mail exists (rather than the dev-console fallback). */
export const emailConfigured = brevoConfigured || smtpConfigured;
export const googleAuthConfigured = Boolean(env.GOOGLE_WEB_CLIENT_ID);

/**
 * Values that are public (in .env.example, in scripts, in tests) and so are
 * no secret at all. A token signed with one of these can be forged by anyone
 * who has read the repository.
 */
const KNOWN_WEAK_SECRETS = new Set([
  'change-me-to-a-64-char-random-string',
  'change-me-to-a-different-64-char-random-string',
  'dev-only-access-secret-0123456789abcdef',
  'dev-only-refresh-secret-0123456789abcdef',
  'test-access-secret-at-least-16-chars',
  'test-refresh-secret-at-least-16-chars',
  'smoke-test-access-secret-value-0123456789',
  'smoke-test-refresh-secret-value-0123456789',
  'audit-test-access-secret-value-0123456789',
  'audit-test-refresh-secret-value-0123456789',
  'coverage-access-secret-value-0123456789',
  'coverage-refresh-secret-value-0123456789',
]);

/** Why a JWT secret is unfit for production, or null if it is fine. */
export function weakSecretReason(value: string): string | null {
  if (value.length < 32) return 'must be at least 32 characters';
  if (KNOWN_WEAK_SECRETS.has(value)) return 'is a published placeholder from this repository';
  if (/change[-_ ]?me|placeholder|example|your[-_ ]?secret|^secret|password/i.test(value)) {
    return 'looks like a placeholder';
  }
  if (new Set(value).size < 10) return 'is too repetitive to be random';
  return null;
}

/**
 * Features that may run degraded in development but must never ship half-configured.
 *
 * Password reset with no way to send mail would silently drop the email while
 * still telling the user one was sent — a worse failure than refusing to boot.
 * Either Brevo's API key or both SMTP settings will do; with the key, SMTP is
 * not needed at all (Render's free tier blocks outbound SMTP anyway).
 * Google sign-in without a web client id would reject every token.
 */
if (isProduction) {
  const missing: string[] = [];
  if (!googleAuthConfigured) missing.push('GOOGLE_WEB_CLIENT_ID');
  if (!brevoConfigured) {
    if (!env.SMTP_USER) missing.push('SMTP_USER (or BREVO_API_KEY)');
    if (!env.SMTP_APP_PASSWORD) missing.push('SMTP_APP_PASSWORD (or BREVO_API_KEY)');
  }
  if (missing.length > 0) {
    throw new Error(
      `Invalid environment configuration: ${missing.join(', ')} must be set in production.`,
    );
  }

  // Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  const weak = (['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const)
    .map((name) => {
      const reason = weakSecretReason(env[name]);
      return reason ? `${name} ${reason}` : null;
    })
    .filter(Boolean);
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    weak.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
  }
  if (weak.length > 0) {
    throw new Error(`Invalid environment configuration: ${weak.join('; ')}.`);
  }
}

// Outside production the API still boots, but Google sign-in answers 503 until
// this is set. Said loudly here because the app's error is deliberately vague.
// console, not the logger: logger.ts imports this module.
if (!googleAuthConfigured && env.NODE_ENV === 'development') {
  console.error(
    '[config] GOOGLE_WEB_CLIENT_ID is not set — POST /auth/google will fail until it is.',
  );
}

export const razorpayConfigured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
export const cloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);
