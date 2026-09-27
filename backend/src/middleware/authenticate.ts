import type { NextFunction, Request, Response } from 'express';
import { User } from '../models/user.model';
import { verifyAccessToken } from '../services/token.service';
import { ApiError } from '../utils/ApiError';
import { resolvePermissions } from '../utils/rbac';
import { asyncHandler } from '../utils/asyncHandler';

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * PRD 8.8 — JWT Authentication stage.
 *
 * Verifies signature and expiry, then re-loads the user so that role and
 * wholesale-approval changes take effect on the very next request rather than
 * waiting for the access token to expire.
 */
export const authenticate = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const token = extractBearerToken(req);
  if (!token) {
    throw ApiError.unauthorized('Authentication required', 'NO_TOKEN');
  }

  const payload = verifyAccessToken(token);

  const user = await User.findById(payload.sub).select(
    '_id phone accountType wholesaleStatus isActive tokenVersion deletedAt',
  );
  if (!user || user.deletedAt) {
    throw ApiError.unauthorized('Account not found', 'ACCOUNT_NOT_FOUND');
  }
  // Minted before the account last signed everyone out (password reset, email
  // change, role change, deactivation, pre-hijack guard). Refusing here is what
  // makes those events immediate instead of waiting out JWT_ACCESS_TTL.
  //
  // Checked before isActive on purpose: deactivation bumps the version, so a
  // deactivated user gets this 401 — which the app acts on by signing out —
  // rather than a 403 it can only display.
  if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
    throw ApiError.unauthorized('Session ended, please sign in again', 'TOKEN_REVOKED');
  }
  if (!user.isActive) {
    throw ApiError.forbidden('This account has been deactivated');
  }

  req.user = {
    id: user._id.toString(),
    phone: user.phone,
    accountType: user.accountType,
    wholesaleStatus: user.wholesaleStatus,
    permissions: resolvePermissions(user.accountType, user.wholesaleStatus),
  };

  next();
});

/**
 * Attaches req.user when a valid token is present but does not reject
 * anonymous callers. Used only where a signed-out view is legitimate; the
 * product serializer still treats an absent user as retail-tier.
 */
export const optionalAuthenticate = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (!token) {
      next();
      return;
    }
    try {
      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub).select(
        '_id phone accountType wholesaleStatus isActive tokenVersion deletedAt',
      );
      if (user?.isActive && !user.deletedAt && (payload.tv ?? 0) === (user.tokenVersion ?? 0)) {
        req.user = {
          id: user._id.toString(),
          phone: user.phone,
          accountType: user.accountType,
          wholesaleStatus: user.wholesaleStatus,
          permissions: resolvePermissions(user.accountType, user.wholesaleStatus),
        };
      }
    } catch {
      // An invalid token on an optional route is simply treated as anonymous.
    }
    next();
  },
);
