import { User, type IUser } from '../models/user.model';
import { ApiError } from '../utils/ApiError';
import { serializeUser, type SerializedUser } from '../serializers/user.serializer';
import { env } from '../config/env';
import { getStore } from '../config/store';
import * as emailService from './email.service';
import * as googleService from './google.service';
import * as passwordService from './password.service';
import * as tokenService from './token.service';

/**
 * Admin is granted by the ADMIN_EMAILS env list, re-evaluated on every sign-in
 * rather than written once at signup, so editing the list takes effect on the
 * next login instead of needing a database edit.
 *
 * Only to a VERIFIED address. Holding a whitelisted address in the email field
 * is not proof of owning it — an account used to be able to type one in via
 * PATCH /auth/me and become admin on the next login. Verification comes from a
 * Google sign-in, a completed password reset, or the emailed-code flow.
 *
 * It demotes as well as promotes: an account removed from the list loses admin
 * the next time it signs in. `staff` is left alone — this list governs the
 * admin role specifically, not every elevated role.
 */
function isAdminEmail(email?: string): boolean {
  if (!email) return false;
  const normalised = email.trim().toLowerCase();
  return env.ADMIN_EMAILS.some((entry) => entry.trim().toLowerCase() === normalised);
}

/**
 * A role that moved ends every other session. Done in memory so every caller
 * — which saves and then issues tokens — persists the bump and hands out a
 * pair that already carries it; tokens minted before the change stop working.
 */
function bumpTokenVersion(user: IUser): void {
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
}

/**
 * Returns true when the caller must persist the document afterwards.
 * Silent no-op for staff, and for anyone whose role already matches the list.
 */
function syncAdminRole(user: IUser): boolean {
  const shouldBeAdmin = user.emailVerified === true && isAdminEmail(user.email);

  if (shouldBeAdmin && user.accountType !== 'admin') {
    user.accountType = 'admin';
    user.wholesaleStatus = 'none';
    bumpTokenVersion(user);
    return true;
  }

  if (!shouldBeAdmin && user.accountType === 'admin') {
    // Fall back to the ordinary tier: an approved wholesale buyer who was
    // temporarily an admin keeps their wholesale pricing, everyone else is retail.
    user.accountType = user.wholesaleStatus === 'approved' ? 'wholesale' : 'retail';
    bumpTokenVersion(user);
    return true;
  }

  return false;
}

export interface LoginContext {
  deviceId?: string;
  userAgent?: string;
}

export interface WholesaleApplication {
  businessName?: string;
  gstNumber?: string;
  shopProofUrl?: string;
}

export interface AuthResult {
  user: SerializedUser;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresAt: string;
}

export async function refreshSession(
  refreshToken: string,
  context: LoginContext = {},
): Promise<AuthResult> {
  const { tokens, userId } = await tokenService.rotateRefreshToken(refreshToken, context);
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('Account not found', 'ACCOUNT_NOT_FOUND');
  // rotateRefreshToken has already refused a deactivated account. The admin
  // whitelist is re-applied here too, so an address taken off ADMIN_EMAILS
  // loses admin at the next refresh — not only at the next full sign-in,
  // which a 90-day refresh token could postpone for months.
  let issued = tokens;
  if (syncAdminRole(user)) {
    await user.save();
    // The pair rotated above was minted with the old version and is already
    // dead. Replace it rather than return tokens that fail on first use.
    await tokenService.revokeRefreshToken(tokens.refreshToken);
    issued = await tokenService.issueTokens(user, context);
  }

  return {
    user: serializeUser(user),
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    accessTokenExpiresIn: issued.accessTokenExpiresIn,
    refreshTokenExpiresAt: issued.refreshTokenExpiresAt.toISOString(),
  };
}

export async function logout(refreshToken: string): Promise<void> {
  await tokenService.revokeRefreshToken(refreshToken);
}

/** Signs the account out on every device, including access tokens in flight. */
export async function logoutEverywhere(userId: string): Promise<void> {
  const user = await User.findById(userId).select('_id');
  if (!user) throw ApiError.notFound('Account not found');
  await tokenService.revokeEverySession(user._id);
}

export async function getProfile(userId: string): Promise<SerializedUser> {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('Account not found');
  return serializeUser(user);
}

/**
 * Name only. The email is a login credential and the key ADMIN_EMAILS matches
 * on, so it changes solely through requestEmailCode → confirmEmailCode.
 */
export async function updateProfile(
  userId: string,
  updates: { name?: string },
): Promise<SerializedUser> {
  const $set = updates.name !== undefined ? { name: updates.name } : {};
  const user = await User.findByIdAndUpdate(userId, { $set }, { new: true });
  if (!user) throw ApiError.notFound('Account not found');
  return serializeUser(user);
}

/* ── Verify or change the account email ─────────────────────────────────── */

const EMAIL_CODE_QUOTA_KEY = (userId: string) => `emailcode:quota:${userId}`;
const EMAIL_CODE_ATTEMPT_KEY = (userId: string) => `emailcode:attempts:${userId}`;
const EMAIL_CODE_LOCK_KEY = (userId: string) => `emailcode:lock:${userId}`;

/**
 * Step 1 — email a 6-digit code to `email`.
 *
 * The same flow serves two purposes: sending it to the account's CURRENT
 * address verifies that address; sending it to a NEW one changes the email
 * once the code comes back. Nothing about the account changes until then.
 */
/**
 * Proves the caller is the account owner, right now.
 *
 * An access token only says someone signed in at some point on this device.
 * Changing the account's email address hands the account to whoever owns the
 * new inbox, so it demands the credential itself: the password for a password
 * account, or a freshly minted Google ID token for a Google-only one.
 *
 * The Google token must be recent — an ID token is valid for an hour, and
 * accepting an old one would let a token captured earlier stand in for the
 * owner being present.
 */
const REAUTH_MAX_AGE_MS = 5 * 60 * 1000;

async function requireRecentAuth(
  user: IUser,
  proof: { password?: string; googleIdToken?: string },
): Promise<void> {
  if (user.passwordHash) {
    if (!proof.password) {
      throw new ApiError(401, 'Enter your password to continue.', 'REAUTH_REQUIRED');
    }
    const ok = await passwordService.verifyPassword(proof.password, user.passwordHash);
    if (!ok) {
      throw new ApiError(401, 'That password is not correct.', 'REAUTH_FAILED');
    }
    user.lastAuthAt = new Date();
    return;
  }

  if (!proof.googleIdToken) {
    throw new ApiError(401, 'Sign in with Google again to continue.', 'REAUTH_REQUIRED');
  }
  const identity = await googleService.verifyGoogleIdToken(proof.googleIdToken);
  if (!user.googleId || identity.googleId !== user.googleId) {
    throw new ApiError(401, 'That Google account does not match this one.', 'REAUTH_FAILED');
  }
  if (identity.issuedAt && Date.now() - identity.issuedAt.getTime() > REAUTH_MAX_AGE_MS) {
    throw new ApiError(401, 'Sign in with Google again to continue.', 'REAUTH_REQUIRED');
  }
  user.lastAuthAt = new Date();
}

export async function requestEmailCode(
  userId: string,
  email: string,
  proof: { password?: string; googleIdToken?: string } = {},
): Promise<{ email: string; purpose: 'verify' | 'change'; expiresInMinutes: number }> {
  const target = email.trim().toLowerCase();
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw ApiError.notFound('Account not found');
  await requireRecentAuth(user, proof);

  const purpose = target === user.email ? 'verify' : 'change';
  if (purpose === 'verify' && user.emailVerified) {
    throw ApiError.conflict('Your email address is already verified.');
  }
  if (purpose === 'change') {
    // Case-insensitive by construction: every stored email is lowercased.
    const taken = await User.exists({ email: target, _id: { $ne: user._id } });
    if (taken) throw ApiError.conflict('That email address is already in use.');
  }

  const store = getStore();
  const sent = await store.incr(EMAIL_CODE_QUOTA_KEY(userId));
  if (sent === 1) await store.expire(EMAIL_CODE_QUOTA_KEY(userId), 3600);
  if (sent > env.FORGOT_PASSWORD_MAX_PER_HOUR) {
    throw ApiError.tooManyRequests(
      `You can request at most ${env.FORGOT_PASSWORD_MAX_PER_HOUR} codes per hour. Please try again later.`,
    );
  }

  const otp = await passwordService.createResetOtp();
  await User.updateOne(
    { _id: user._id },
    { $set: { pendingEmail: target, emailCodeHash: otp.codeHash, emailCodeExpiresAt: otp.expiresAt } },
  );
  // A fresh code starts a fresh set of attempts.
  await store.del(EMAIL_CODE_ATTEMPT_KEY(userId));

  await emailService.sendEmailVerificationCode({
    to: target,
    code: otp.code,
    expiresInMinutes: env.PASSWORD_RESET_OTP_TTL_MINUTES,
    purpose,
  });

  return { email: target, purpose, expiresInMinutes: env.PASSWORD_RESET_OTP_TTL_MINUTES };
}

/**
 * Step 2 — check the code and apply it.
 *
 * On a change, the address is re-checked for a clash (it may have been taken
 * since step 1), and every other session is revoked: whoever held the old
 * address should not stay signed in on the strength of it. This device gets a
 * fresh token pair in the response, so it stays signed in.
 */
export async function confirmEmailCode(input: {
  userId: string;
  otp: string;
  /** Same proof as step 1: the code alone is not enough to move an address. */
  password?: string;
  googleIdToken?: string;
  context?: LoginContext;
}): Promise<AuthResult & { changed: boolean }> {
  const { userId, otp, context = {} } = input;
  const store = getStore();

  if (await store.get(EMAIL_CODE_LOCK_KEY(userId))) {
    const remaining = await store.ttl(EMAIL_CODE_LOCK_KEY(userId));
    throw ApiError.tooManyRequests(
      `Too many incorrect codes. Try again in ${Math.max(1, Math.ceil(remaining / 60))} minute(s).`,
    );
  }

  const user = await User.findById(userId).select(
    '+pendingEmail +emailCodeHash +emailCodeExpiresAt +passwordHash',
  );
  if (!user) throw ApiError.notFound('Account not found');
  // Checked before the code, so a wrong password cannot be used to burn
  // someone else's attempts.
  await requireRecentAuth(user, { password: input.password, googleIdToken: input.googleIdToken });

  if (
    !user.pendingEmail ||
    !user.emailCodeHash ||
    !user.emailCodeExpiresAt ||
    user.emailCodeExpiresAt.getTime() <= Date.now()
  ) {
    // 400, not 401: the caller IS signed in; only the code is wrong. A 401 here
    // would read as a dead session and sign the app out.
    throw new ApiError(400, 'This code has expired. Please request a new one.', 'EMAIL_CODE_EXPIRED');
  }

  if (!(await passwordService.verifyResetOtp(otp, user.emailCodeHash))) {
    const attempts = await store.incr(EMAIL_CODE_ATTEMPT_KEY(userId));
    if (attempts === 1) {
      await store.expire(EMAIL_CODE_ATTEMPT_KEY(userId), env.PASSWORD_RESET_OTP_TTL_MINUTES * 60);
    }
    if (attempts >= env.PASSWORD_RESET_MAX_ATTEMPTS) {
      await store.set(EMAIL_CODE_LOCK_KEY(userId), '1', env.PASSWORD_RESET_LOCKOUT_MINUTES * 60);
      await store.del(EMAIL_CODE_ATTEMPT_KEY(userId));
      // Burn the code too, so waiting out the lock does not reopen it.
      await User.updateOne(
        { _id: user._id },
        { $unset: { pendingEmail: 1, emailCodeHash: 1, emailCodeExpiresAt: 1 } },
      );
      throw ApiError.tooManyRequests(
        `Too many incorrect codes. Please request a new code in ${env.PASSWORD_RESET_LOCKOUT_MINUTES} minutes.`,
      );
    }
    const remaining = env.PASSWORD_RESET_MAX_ATTEMPTS - attempts;
    throw new ApiError(
      400,
      `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      'EMAIL_CODE_INVALID',
    );
  }

  const target = user.pendingEmail;
  // Captured before the overwrite: the notice below goes to the address the
  // account is leaving, which is the owner's last line of defence.
  const previousEmail = user.email;
  const changed = target !== user.email;
  if (changed && (await User.exists({ email: target, _id: { $ne: user._id } }))) {
    throw ApiError.conflict('That email address is already in use.');
  }

  user.email = target;
  user.emailVerified = true;
  user.pendingEmail = undefined;
  user.emailCodeHash = undefined;
  user.emailCodeExpiresAt = undefined;
  // A proven address is exactly what the ADMIN_EMAILS rule waits for.
  syncAdminRole(user);
  await user.save();
  await store.del(EMAIL_CODE_ATTEMPT_KEY(userId));

  if (changed) {
    await tokenService.revokeEverySession(user._id);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    // The old inbox is the only place the real owner still controls if the
    // change was not theirs, so it is told even though it is no longer the
    // account address. Never blocks the change: started inside a promise so
    // that even a synchronous throw lands in the catch, not in this request.
    if (previousEmail) {
      void Promise.resolve()
        .then(() => emailService.sendEmailChangedNotice(previousEmail, target))
        .catch(() => undefined);
    }
  }
  return { ...(await buildAuthResult(user, context)), changed };
}

/** Lets an already-signed-in retail customer apply for a wholesale account. */
export async function applyForWholesale(
  userId: string,
  application: WholesaleApplication,
): Promise<SerializedUser> {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('Account not found');

  if (user.accountType === 'admin' || user.accountType === 'staff') {
    throw ApiError.badRequest('Staff accounts cannot apply for wholesale pricing.');
  }
  if (user.wholesaleStatus === 'pending') {
    throw ApiError.conflict('Your wholesale application is already under review.');
  }
  if (user.wholesaleStatus === 'approved') {
    throw ApiError.conflict('Your wholesale account is already approved.');
  }

  user.accountType = 'wholesale';
  user.wholesaleStatus = 'pending';
  user.business = { ...(user.business ?? {}), ...application, appliedAt: new Date() };
  user.wholesaleReview = undefined;
  await user.save();

  return serializeUser(user);
}

export async function findUserById(userId: string): Promise<IUser> {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('Account not found');
  return user;
}

// ─────────────────────────────────────────────────────────────
// Password + Google credentials
//
// These sit alongside the OTP flow rather than replacing it: an account may
// carry any combination of the three, tracked in `authProviders`.
// ─────────────────────────────────────────────────────────────

/**
 * A bcrypt hash of a throwaway value, compared against when no account
 * matches, so a failed login costs the same time whether the email exists or
 * not. Without it, response latency alone enumerates registered addresses.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.e/qR2Vn3xYQ5xJ0mXW5xq1oQKZ5Lz5m';

export async function registerWithPassword(input: {
  email: string;
  password: string;
  name?: string;
  accountType?: 'retail' | 'wholesale';
  context?: LoginContext;
}): Promise<AuthResult> {
  const { email, password, name, accountType = 'retail', context = {} } = input;
  const normalisedEmail = email.toLowerCase();

  const existing = await User.findOne({ email: normalisedEmail });
  if (existing) {
    throw ApiError.conflict('An account with this email already exists.');
  }

  const user = await User.create({
    email: normalisedEmail,
    name,
    passwordHash: await passwordService.hashPassword(password),
    accountType,
    wholesaleStatus: accountType === 'wholesale' ? 'pending' : 'none',
    authProviders: ['password'],
    lastLoginAt: new Date(),
  });

  // A whitelisted address is admin from its very first session.
  if (syncAdminRole(user)) await user.save();

  return buildAuthResult(user, context);
}

export async function loginWithPassword(input: {
  email: string;
  password: string;
  context?: LoginContext;
}): Promise<AuthResult> {
  const { email, password, context = {} } = input;

  // passwordHash is `select: false`, so it must be asked for explicitly.
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');

  // One timing profile for every failure mode: the bcrypt compare runs even
  // when there is no account or no hash to compare against.
  const matches = await passwordService.verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  // One message for every failure — wrong password, no such account, or an
  // account with no password (Google-only, OTP-only). A distinct message for
  // Google-only accounts used to reveal which addresses had one. The hint is
  // generic, so it is shown to everyone and reveals nothing.
  if (!user || !user.passwordHash || !matches) {
    throw ApiError.unauthorized(
      'Incorrect email or password. If you signed up with Google, use "Continue with Google".',
      'INVALID_CREDENTIALS',
    );
  }

  if (!user.isActive) {
    throw ApiError.forbidden('This account has been deactivated. Please contact support.');
  }

  syncAdminRole(user);
  user.lastLoginAt = new Date();
  await user.save();

  return buildAuthResult(user, context);
}

/**
 * Google sign-in from a verified native ID token.
 *
 * Matches on the stable `sub` first, then on email, so a customer who signed
 * up with a password is linked rather than duplicated. Account type and
 * wholesale status are never touched here beyond the ADMIN_EMAILS sync that
 * every sign-in applies — a new Google account starts as plain retail.
 */
export async function loginWithGoogle(input: {
  idToken: string;
  context?: LoginContext;
}): Promise<AuthResult> {
  const { idToken, context = {} } = input;
  const identity = await googleService.verifyGoogleIdToken(idToken);

  let user = await User.findOne({ googleId: identity.googleId });

  if (!user) {
    user = await User.findOne({ email: identity.email }).select('+passwordHash');

    if (user) {
      // The address already belongs to an account linked to a *different*
      // Google identity. Refuse rather than silently re-point the account.
      if (user.googleId && user.googleId !== identity.googleId) {
        throw ApiError.conflict(
          'This email is linked to a different Google account. Sign in with your password instead.',
        );
      }
      // Account pre-hijacking guard. Registration never proved the address,
      // so a password set on an UNVERIFIED account may belong to someone who
      // registered the victim's email first. Google has now proved who owns
      // it: that password is removed and every existing session revoked.
      if (!user.emailVerified && user.passwordHash) {
        user.passwordHash = undefined;
        user.authProviders = user.authProviders.filter((provider) => provider !== 'password');
        // The same attacker may have left a change-email request pending on
        // the account. Leaving it armed would let them move the address to
        // one they control the moment the real owner takes over.
        user.pendingEmail = undefined;
        user.emailCodeHash = undefined;
        user.emailCodeExpiresAt = undefined;
        user.passwordResetOtpHash = undefined;
        user.passwordResetOtpExpiresAt = undefined;
        user.passwordResetTokenHash = undefined;
        user.passwordResetTokenExpiresAt = undefined;
        await user.save();
        await tokenService.revokeEverySession(user._id);
        // Re-read so the pair issued below carries the bumped version.
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
      }
      // Existing password (or OTP) account — attach the Google credential.
      // Google has verified this exact address (email_verified is required).
      user.emailVerified = true;
      user.googleId = identity.googleId;
      if (!user.authProviders.includes('google')) user.authProviders.push('google');
      if (!user.name && identity.name) user.name = identity.name;
      if (!user.avatar && identity.picture) user.avatar = identity.picture;
    }
  }

  if (!user) {
    // No password and no phone — both fields are optional for this reason.
    user = await User.create({
      email: identity.email,
      name: identity.name,
      avatar: identity.picture,
      googleId: identity.googleId,
      emailVerified: true,
      accountType: 'retail',
      wholesaleStatus: 'none',
      authProviders: ['google'],
      lastLoginAt: new Date(),
    });
    if (syncAdminRole(user)) await user.save();
    return buildAuthResult(user, context);
  }

  if (!user.isActive) {
    throw ApiError.forbidden('This account has been deactivated. Please contact support.');
  }

  // A returning Google user whose address is still the one Google verified.
  if (user.email === identity.email) user.emailVerified = true;
  syncAdminRole(user);
  user.lastLoginAt = new Date();
  await user.save();

  return buildAuthResult(user, context);
}

/**
 * Step 1 of 3 — email a 6-digit code.
 *
 * Returns the same shape whether or not the address is registered (PRD 8.11);
 * the caller must not be able to tell.
 */
export async function requestPasswordReset(input: {
  email: string;
  ip?: string;
}): Promise<void> {
  const email = input.email.toLowerCase();
  const store = getStore();

  // Counted before the user lookup, so the quota applies identically to
  // addresses that do not exist. Keyed by email *and* IP: the email key stops
  // one address being mailbombed from many IPs, the IP key stops one host
  // walking a list of addresses.
  for (const key of [`pwreset:email:${email}`, `pwreset:ip:${input.ip ?? 'unknown'}`]) {
    const count = await store.incr(key);
    if (count === 1) await store.expire(key, 3600);
    if (count > env.FORGOT_PASSWORD_MAX_PER_HOUR) {
      throw ApiError.tooManyRequests(
        `You can request at most ${env.FORGOT_PASSWORD_MAX_PER_HOUR} reset codes per hour. Please try again later.`,
      );
    }
  }

  const user = await User.findOne({ email });

  // The same bcrypt work happens for every address, so response time does not
  // reveal which ones are registered (an unknown address used to answer ~50 ms
  // sooner). Mail is sent without awaiting SMTP, for the same reason.
  const otp = await passwordService.createResetOtp();

  // Silent no-op for unknown addresses: the controller still returns success.
  if (!user || !user.isActive) return;

  user.passwordResetOtpHash = otp.codeHash;
  user.passwordResetOtpExpiresAt = otp.expiresAt;
  // A fresh code invalidates any token already minted from an older one.
  user.passwordResetTokenHash = undefined;
  user.passwordResetTokenExpiresAt = undefined;
  await user.save();

  // A new code clears the previous lockout counter for this address.
  await store.del(OTP_ATTEMPT_KEY(email));

  // Not awaited: a slow Gmail round trip would otherwise mark this address as
  // registered. The send already logs its own failures and never throws.
  void emailService
    .sendPasswordResetEmail({
      to: email,
      code: otp.code,
      expiresInMinutes: env.PASSWORD_RESET_OTP_TTL_MINUTES,
    })
    .catch(() => undefined);
}

const OTP_ATTEMPT_KEY = (email: string) => `pwreset:attempts:${email}`;
const OTP_LOCK_KEY = (email: string) => `pwreset:lock:${email}`;

/**
 * Step 2 of 3 — verify the code, hand back a short-lived token.
 *
 * Mirrors the lockout the phone-OTP login used: wrong codes are counted per
 * email and the address is frozen once the ceiling is hit, which is what makes
 * a 6-digit secret defensible.
 */
export async function verifyPasswordResetOtp(input: {
  email: string;
  otp: string;
}): Promise<{ resetToken: string; expiresInSeconds: number }> {
  const email = input.email.toLowerCase();
  const store = getStore();

  if (await store.get(OTP_LOCK_KEY(email))) {
    const remaining = await store.ttl(OTP_LOCK_KEY(email));
    throw ApiError.tooManyRequests(
      `Too many incorrect codes. Try again in ${Math.max(1, Math.ceil(remaining / 60))} minute(s).`,
    );
  }

  const user = await User.findOne({ email }).select(
    '+passwordResetOtpHash +passwordResetOtpExpiresAt',
  );

  // One message for "no code pending", "wrong email" and "expired" alike, so
  // this step cannot be used to enumerate addresses either.
  const expired =
    !user?.passwordResetOtpHash ||
    !user.passwordResetOtpExpiresAt ||
    user.passwordResetOtpExpiresAt.getTime() <= Date.now();

  if (expired) {
    throw ApiError.unauthorized(
      'This code has expired. Please request a new one.',
      'RESET_OTP_EXPIRED',
    );
  }

  const matches = await passwordService.verifyResetOtp(
    input.otp,
    user.passwordResetOtpHash as string,
  );

  if (!matches) {
    const attempts = await store.incr(OTP_ATTEMPT_KEY(email));
    if (attempts === 1) {
      await store.expire(OTP_ATTEMPT_KEY(email), env.PASSWORD_RESET_OTP_TTL_MINUTES * 60);
    }

    if (attempts >= env.PASSWORD_RESET_MAX_ATTEMPTS) {
      await store.set(OTP_LOCK_KEY(email), '1', env.PASSWORD_RESET_LOCKOUT_MINUTES * 60);
      await store.del(OTP_ATTEMPT_KEY(email));
      // Burn the code as well, so the lockout cannot simply be waited out.
      user.passwordResetOtpHash = undefined;
      user.passwordResetOtpExpiresAt = undefined;
      await user.save();
      throw ApiError.tooManyRequests(
        `Too many incorrect codes. This email is locked for ${env.PASSWORD_RESET_LOCKOUT_MINUTES} minutes.`,
      );
    }

    const remaining = env.PASSWORD_RESET_MAX_ATTEMPTS - attempts;
    throw ApiError.unauthorized(
      `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      'RESET_OTP_INVALID',
    );
  }

  // Single use: consume the code and swap it for the token.
  const reset = passwordService.createResetToken();
  user.passwordResetOtpHash = undefined;
  user.passwordResetOtpExpiresAt = undefined;
  user.passwordResetTokenHash = reset.tokenHash;
  user.passwordResetTokenExpiresAt = reset.expiresAt;
  await user.save();
  await store.del(OTP_ATTEMPT_KEY(email));

  return {
    resetToken: reset.token,
    expiresInSeconds: env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60,
  };
}

/**
 * Step 3 of 3 — set the new password.
 *
 * On success every other session is revoked, so a device the attacker still
 * holds is logged out rather than surviving the reset.
 */
export async function resetPassword(input: {
  token: string;
  password: string;
}): Promise<void> {
  const tokenHash = passwordService.hashResetToken(input.token);

  const user = await User.findOne({ passwordResetTokenHash: tokenHash }).select(
    '+passwordResetTokenHash +passwordResetTokenExpiresAt',
  );

  // A consumed token has had its hash cleared, so a replay lands here too.
  if (!user || !user.passwordResetTokenExpiresAt) {
    throw ApiError.badRequest('This reset request is invalid or has already been used.');
  }

  if (user.passwordResetTokenExpiresAt.getTime() <= Date.now()) {
    user.passwordResetTokenHash = undefined;
    user.passwordResetTokenExpiresAt = undefined;
    await user.save();
    throw ApiError.badRequest('This reset request has expired. Please start again.');
  }

  user.passwordHash = await passwordService.hashPassword(input.password);
  user.passwordResetTokenHash = undefined;
  user.passwordResetTokenExpiresAt = undefined;
  if (!user.authProviders.includes('password')) user.authProviders.push('password');
  // The code reached this inbox, so the account demonstrably owns the address.
  user.emailVerified = true;
  await user.save();

  await tokenService.revokeEverySession(user._id);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
}

async function buildAuthResult(user: IUser, context: LoginContext): Promise<AuthResult> {
  const tokens = await tokenService.issueTokens(user, context);
  return {
    user: serializeUser(user),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresIn: tokens.accessTokenExpiresIn,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
  };
}
