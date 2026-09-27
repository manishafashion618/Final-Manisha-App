import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middleware/authenticate';
import { authLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { objectIdParam } from '../validators/common';
import {
  addressSchema,
  addressUpdateSchema,
  applyWholesaleSchema,
  confirmEmailCodeSchema,
  forgotPasswordSchema,
  googleLoginSchema,
  logoutSchema,
  passwordLoginSchema,
  refreshSchema,
  registerSchema,
  requestEmailCodeSchema,
  resetPasswordSchema,
  verifyResetOtpSchema,
  updateProfileSchema,
} from '../validators/auth.validator';

const router = Router();

/**
 * Middleware order on every route below matches PRD 8.6:
 *   validate → rate limit → authenticate → authorize → controller
 */

// ── Public (PRD 8.7) ──
router.post('/refresh', validate({ body: refreshSchema }), authLimiter, authController.refresh);
router.post('/logout', validate({ body: logoutSchema }), authController.logout);
// Every device at once, including access tokens already handed out.
router.post('/logout-all', authenticate, authController.logoutAll);

// ── Email + password (PRD 4.1 extension) ──
router.post('/register', validate({ body: registerSchema }), authLimiter, authController.register);
router.post('/login', validate({ body: passwordLoginSchema }), authLimiter, authController.login);

// ── Google (native ID token, verified server-side) ──
router.post('/google', validate({ body: googleLoginSchema }), authLimiter, authController.google);


// ── Password reset ──
// The 3/hour quota per email and per IP lives in the service, keyed by both,
// so rotating IPs cannot lift the per-address ceiling.
router.post(
  '/forgot-password',
  validate({ body: forgotPasswordSchema }),
  authLimiter,
  authController.forgotPassword,
);
router.post(
  '/verify-reset-otp',
  validate({ body: verifyResetOtpSchema }),
  authLimiter,
  authController.verifyResetOtp,
);
router.post(
  '/reset-password',
  validate({ body: resetPasswordSchema }),
  authLimiter,
  authController.resetPassword,
);

// ── Authenticated ──
router.get('/me', authenticate, authController.me);
router.patch('/me', validate({ body: updateProfileSchema }), authenticate, authController.updateProfile);

// ── Verify or change the account email (emailed 6-digit code) ──
router.post(
  '/email/request-code',
  validate({ body: requestEmailCodeSchema }),
  authLimiter,
  authenticate,
  authController.requestEmailCode,
);
router.post(
  '/email/confirm',
  validate({ body: confirmEmailCodeSchema }),
  authLimiter,
  authenticate,
  authController.confirmEmailCode,
);
router.post(
  '/wholesale/apply',
  validate({ body: applyWholesaleSchema }),
  authenticate,
  authController.applyForWholesale,
);

// ── Addresses (PRD 4.3) ──
router.get('/addresses', authenticate, authController.listAddresses);
router.post('/addresses', validate({ body: addressSchema }), authenticate, authController.addAddress);
router.patch(
  '/addresses/:id',
  validate({ params: objectIdParam(), body: addressUpdateSchema }),
  authenticate,
  authController.updateAddress,
);
router.delete(
  '/addresses/:id',
  validate({ params: objectIdParam() }),
  authenticate,
  authController.deleteAddress,
);


export default router;
