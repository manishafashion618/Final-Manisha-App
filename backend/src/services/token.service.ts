import crypto from 'crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { RefreshToken } from '../models/refreshToken.model';
import type { IUser } from '../models/user.model';
import { ApiError } from '../utils/ApiError';
import type { JwtAccessPayload, JwtRefreshPayload } from '../types';

/**
 * PRD 8.7 — short-lived JWT access token (15–60 min) plus a long-lived refresh
 * token stored hashed against the user + device.
 */

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresAt: Date;
}

function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function signAccessToken(
  user: Pick<IUser, '_id' | 'accountType' | 'wholesaleStatus'> & { tokenVersion?: number },
): string {
  const payload: JwtAccessPayload = {
    sub: user._id.toString(),
    accountType: user.accountType,
    wholesaleStatus: user.wholesaleStatus,
    tv: user.tokenVersion ?? 0,
    tokenType: 'access',
  };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: 'manisha-fashions',
  } as SignOptions);
}

export function verifyAccessToken(token: string): JwtAccessPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      // Pinned: only the algorithm we sign with is accepted.
      algorithms: ['HS256'],
      issuer: 'manisha-fashions',
    }) as JwtAccessPayload;
    if (decoded.tokenType !== 'access') {
      throw ApiError.unauthorized('Invalid token type', 'INVALID_TOKEN');
    }
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      // Distinct code so the client calls /auth/refresh instead of re-prompting for OTP (PRD 8.8).
      throw ApiError.unauthorized('Access token expired', 'TOKEN_EXPIRED');
    }
    if (error instanceof ApiError) throw error;
    throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  }
}

export async function issueTokens(
  user: IUser,
  context: { deviceId?: string; userAgent?: string } = {},
  lineage: { familyId?: string; jti?: string } = {},
): Promise<IssuedTokens> {
  const accessToken = signAccessToken(user);

  const jti = lineage.jti ?? crypto.randomUUID();
  // A sign-in starts a new family; a rotation continues its predecessor's.
  const familyId = lineage.familyId ?? jti;
  const rawRefreshToken = crypto.randomBytes(48).toString('base64url');
  const refreshPayload: JwtRefreshPayload = {
    sub: user._id.toString(),
    jti,
    tv: user.tokenVersion ?? 0,
    tokenType: 'refresh',
  };
  // The JWT wrapper carries the jti; the random secret half is what gets hashed
  // and stored, so a leaked database cannot be replayed as a session.
  // The jti travels in the payload; passing `jwtid` as well makes jsonwebtoken
  // throw on the duplicate claim.
  const refreshToken = jwt.sign(refreshPayload, env.JWT_REFRESH_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${env.JWT_REFRESH_TTL_DAYS}d`,
    issuer: 'manisha-fashions',
  } as SignOptions);

  const compositeRefresh = `${refreshToken}.${rawRefreshToken}`;
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId: user._id,
    jti,
    tokenHash: hashRefreshToken(compositeRefresh),
    familyId,
    deviceId: context.deviceId,
    userAgent: context.userAgent?.slice(0, 300),
    expiresAt,
  });

  return {
    accessToken,
    refreshToken: compositeRefresh,
    accessTokenExpiresIn: parseTtlSeconds(env.JWT_ACCESS_TTL),
    refreshTokenExpiresAt: expiresAt,
  };
}

/**
 * Rotates a refresh token: the presented token is revoked and a fresh pair is
 * issued. Rotation means a stolen token is usable at most once before the
 * legitimate client's next refresh invalidates it.
 *
 * Reuse detection: presenting a token that was ALREADY rotated means two
 * parties hold the same session (the thief and the owner). The whole family
 * is revoked, so both are signed out and the owner signs in again.
 */
export async function rotateRefreshToken(
  presentedToken: string,
  context: { deviceId?: string; userAgent?: string } = {},
): Promise<{ tokens: IssuedTokens; userId: Types.ObjectId }> {
  const [jwtPart] = presentedToken.split('.').length >= 4
    ? [presentedToken.slice(0, presentedToken.lastIndexOf('.'))]
    : [presentedToken];

  let payload: JwtRefreshPayload;
  try {
    payload = jwt.verify(jwtPart, env.JWT_REFRESH_SECRET, {
      algorithms: ['HS256'],
      issuer: 'manisha-fashions',
    }) as JwtRefreshPayload;
  } catch {
    throw ApiError.unauthorized('Session expired, please sign in again', 'REFRESH_TOKEN_INVALID');
  }

  if (payload.tokenType !== 'refresh') {
    throw ApiError.unauthorized('Invalid token type', 'REFRESH_TOKEN_INVALID');
  }

  const stored = await RefreshToken.findOne({
    jti: payload.jti,
    tokenHash: hashRefreshToken(presentedToken),
  });

  if (!stored) {
    throw ApiError.unauthorized('Session expired, please sign in again', 'REFRESH_TOKEN_INVALID');
  }
  const familyId = stored.familyId ?? stored.jti;

  if (stored.revokedAt) {
    if (stored.replacedByJti) await revokeFamily(familyId, 'reuse');
    throw ApiError.unauthorized('Session expired, please sign in again', stored.replacedByJti ? 'REFRESH_TOKEN_REUSED' : 'REFRESH_TOKEN_INVALID');
  }
  if (stored.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('Session expired, please sign in again', 'REFRESH_TOKEN_INVALID');
  }

  const { User } = await import('../models/user.model');
  const user = await User.findById(stored.userId);
  if (!user || !user.isActive || user.deletedAt) {
    // A deactivated account loses every session, not just this one.
    if (user) await revokeAllSessions(user._id);
    throw ApiError.unauthorized('Account is no longer active', 'ACCOUNT_INACTIVE');
  }

  // Minted before the last "sign everyone out" event: refuse rather than hand
  // out a fresh pair, which would resurrect a session the bump killed.
  // Only this token is revoked: a stale device must not be able to sign out
  // the session that replaced it.
  if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
    await RefreshToken.updateOne({ _id: stored._id }, { $set: { revokedAt: new Date() } });
    throw ApiError.unauthorized('Session expired, please sign in again', 'REFRESH_TOKEN_INVALID');
  }

  // Claimed atomically: of two requests rotating the same token at once, one
  // wins and the other is treated as reuse.
  const nextJti = crypto.randomUUID();
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: stored._id, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date(), replacedByJti: nextJti } },
  );
  if (!claimed) {
    await revokeFamily(familyId, 'reuse');
    throw ApiError.unauthorized('Session expired, please sign in again', 'REFRESH_TOKEN_REUSED');
  }

  const tokens = await issueTokens(
    user,
    {
      deviceId: context.deviceId ?? stored.deviceId,
      userAgent: context.userAgent ?? stored.userAgent,
    },
    { familyId, jti: nextJti },
  );

  return { tokens, userId: user._id };
}

async function revokeFamily(familyId: string, reason: 'reuse'): Promise<void> {
  const { logger } = await import('../config/logger');
  const result = await RefreshToken.updateMany(
    { $or: [{ familyId }, { jti: familyId }], revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
  logger.warn(`Refresh token ${reason} detected; revoked ${result.modifiedCount} session(s) in the family.`);
}

/** PRD 8.10 — logout invalidates the refresh token server-side, not just on-device. */
export async function revokeRefreshToken(presentedToken: string): Promise<void> {
  await RefreshToken.updateOne(
    { tokenHash: hashRefreshToken(presentedToken), revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeAllSessions(userId: Types.ObjectId): Promise<void> {
  await RefreshToken.updateMany(
    { userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}

function parseTtlSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return 1800;
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (multipliers[unit] ?? 60);
}

/**
 * Ends every session the account has, everywhere, at once.
 *
 * Revoking refresh tokens alone left already-issued ACCESS tokens working
 * until their own expiry. Bumping the version makes `authenticate` reject
 * them on the very next request, so "sign me out everywhere" is immediate
 * rather than eventually.
 *
 * Call this for: password reset, email change, role change, deactivation,
 * the Google pre-hijack guard, logout-all and account deletion.
 */
export async function revokeEverySession(userId: Types.ObjectId): Promise<void> {
  const { User } = await import('../models/user.model');
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  await revokeAllSessions(userId);
}
