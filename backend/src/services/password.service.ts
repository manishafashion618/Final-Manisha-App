import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Password hashing and reset-token minting.
 *
 * Two different primitives on purpose:
 *  - passwords use bcrypt (slow by design, defeats offline cracking);
 *  - reset tokens use SHA-256 (fast, but the token is 32 random bytes, so
 *    there is nothing to guess) because it must be *looked up by value*,
 *    which a salted bcrypt hash cannot be.
 */
const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface ResetOtp {
  /** Emailed to the user; never stored. */
  code: string;
  /** bcrypt hash, stored on the user row. */
  codeHash: string;
  expiresAt: Date;
}

/**
 * A 6-digit code has only a million possibilities, so it leans on bcrypt plus
 * the attempt lockout in auth.service — not on entropy — to stay safe.
 * `randomInt` is used over `Math.random` because this is a credential.
 */
export async function createResetOtp(overrideCode?: string): Promise<ResetOtp> {
  const code = overrideCode ?? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  return {
    code,
    codeHash: await bcrypt.hash(code, 10),
    expiresAt: new Date(Date.now() + env.PASSWORD_RESET_OTP_TTL_MINUTES * 60 * 1000),
  };
}

export function verifyResetOtp(code: string, codeHash: string): Promise<boolean> {
  return bcrypt.compare(code, codeHash);
}

export interface ResetToken {
  /** Handed to the client after the code is verified; never stored. */
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

/**
 * Minted only once the emailed code has been verified. 32 random bytes, so a
 * fast SHA-256 is fine here — and necessary, since it is looked up by value.
 */
export function createResetToken(): ResetToken {
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000),
  };
}

export function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
