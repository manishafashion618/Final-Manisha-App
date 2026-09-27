import type { Request, Response } from 'express';
import * as authService from '../services/auth.service';
import * as addressService from '../services/address.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

function loginContext(req: Request) {
  return {
    deviceId: typeof req.body?.deviceId === 'string' ? req.body.deviceId : undefined,
    userAgent: req.headers['user-agent'],
  };
}

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.refreshSession(req.body.refreshToken, loginContext(req));
  res.success(result);
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  await authService.logout(req.body.refreshToken);
  res.success({ message: 'Signed out.' });
});

export const logoutAll = asyncHandler(async (req: Request, res: Response) => {
  await authService.logoutEverywhere(req.user!.id);
  res.success({ message: 'Signed out on every device.' });
});

export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.registerWithPassword({
    email: req.body.email,
    password: req.body.password,
    name: req.body.name,
    accountType: req.body.accountType,
    context: loginContext(req),
  });
  res.success(result);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.loginWithPassword({
    email: req.body.email,
    password: req.body.password,
    context: loginContext(req),
  });
  res.success(result);
});

export const google = asyncHandler(async (req: Request, res: Response) => {
  if (!req.body.idToken) throw ApiError.badRequest('idToken is required.');
  const result = await authService.loginWithGoogle({
    idToken: req.body.idToken,
    context: loginContext(req),
  });
  res.success(result);
});

/**
 * Always the same response, whether or not the address is registered — this
 * endpoint must not be usable to enumerate customers (PRD 8.11).
 */
export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  await authService.requestPasswordReset({ email: req.body.email, ip: req.ip });
  res.success({
    message: "If that email is registered, we've sent a 6-digit code to it.",
  });
});

export const verifyResetOtp = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.verifyPasswordResetOtp({
    email: req.body.email,
    otp: req.body.otp,
  });
  res.success(result);
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  await authService.resetPassword({ token: req.body.token, password: req.body.password });
  res.success({ message: 'Your password has been changed. Please sign in.' });
});

export const requestEmailCode = asyncHandler(async (req: Request, res: Response) => {
  res.success(
    await authService.requestEmailCode(req.user!.id, req.body.email, {
      password: req.body.password,
      googleIdToken: req.body.googleIdToken,
    }),
  );
});

export const confirmEmailCode = asyncHandler(async (req: Request, res: Response) => {
  res.success(
    await authService.confirmEmailCode({
      userId: req.user!.id,
      otp: req.body.otp,
      password: req.body.password,
      googleIdToken: req.body.googleIdToken,
      context: loginContext(req),
    }),
  );
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  res.success(await authService.getProfile(req.user!.id));
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  res.success(await authService.updateProfile(req.user!.id, req.body));
});

export const applyForWholesale = asyncHandler(async (req: Request, res: Response) => {
  res.success(await authService.applyForWholesale(req.user!.id, req.body));
});

/* ── Addresses ──────────────────────────────────────────────────────────── */

export const listAddresses = asyncHandler(async (req: Request, res: Response) => {
  res.success(await addressService.listAddresses(req.user!.id));
});

export const addAddress = asyncHandler(async (req: Request, res: Response) => {
  res.success(await addressService.addAddress(req.user!.id, req.body), undefined, 201);
});

export const updateAddress = asyncHandler(async (req: Request, res: Response) => {
  res.success(await addressService.updateAddress(req.user!.id, req.params.id, req.body));
});

export const deleteAddress = asyncHandler(async (req: Request, res: Response) => {
  res.success(await addressService.deleteAddress(req.user!.id, req.params.id));
});

