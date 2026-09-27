import { z } from 'zod';
import { objectId, phoneNumber } from './common';

const wholesaleApplication = z.object({
  businessName: z.string().trim().min(2).max(120).optional(),
  // PRD 6 — whether document upload is mandatory is still an open item, so the
  // fields exist and are accepted but are not required to submit.
  gstNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Enter a valid GSTIN')
    .optional(),
  shopProofUrl: z.string().url().optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20, 'A refresh token is required'),
  deviceId: z.string().max(120).optional(),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(20),
});

// ── Password + Google credentials ──

/**
 * Minimum 8 with a letter and a digit. Deliberately not a maximum-complexity
 * rule: length carries the entropy, and bcrypt is the real defence.
 */
const passwordField = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'That password is too long')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');

const emailField = z.string().trim().toLowerCase().email('Enter a valid email address').max(160);

export const registerSchema = z.object({
  email: emailField,
  password: passwordField,
  name: z.string().trim().min(1).max(80).optional(),
  accountType: z.enum(['retail', 'wholesale']).default('retail'),
  deviceId: z.string().max(120).optional(),
});

export const passwordLoginSchema = z.object({
  email: emailField,
  // Not `passwordField`: an old password that predates a policy change must
  // still be able to sign in, and echoing the rules here would leak them.
  password: z.string().min(1, 'Enter your password').max(128),
  deviceId: z.string().max(120).optional(),
});

/**
 * `idToken` is deliberately not required here: a missing token is answered
 * with a 400 by the controller, not the generic 422 this middleware produces
 * for a malformed body.
 */
export const googleLoginSchema = z.object({
  idToken: z.string().trim().max(4096).optional(),
  deviceId: z.string().max(120).optional(),
});

export const forgotPasswordSchema = z.object({
  email: emailField,
});

export const verifyResetOtpSchema = z.object({
  email: emailField,
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your email'),
});

export const resetPasswordSchema = z.object({
  // Issued by /auth/verify-reset-otp, not carried in from an email link.
  token: z.string().min(20, 'This reset request is not valid'),
  password: passwordField,
});

/**
 * Name only. Email is deliberately absent — zod strips it, so an old app build
 * that still sends it keeps working but cannot change the address. Changing
 * (or verifying) an email goes through the emailed-code flow below.
 */
export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});

/**
 * Proof that the person at the keyboard is the account owner, not someone who
 * walked up to an unlocked phone or is replaying a stolen access token.
 *
 * Whichever credential the account actually has: a password account sends the
 * password, a Google-only account sends a freshly minted ID token. Required on
 * both steps of the email-change flow, because changing the address is what
 * takes an account away from its owner for good.
 */
const reauthFields = {
  password: z.string().min(1).max(128).optional(),
  googleIdToken: z.string().min(1).max(4096).optional(),
};

/** Step 1 of verify/change email: the address the code is sent to. */
export const requestEmailCodeSchema = z.object({
  email: emailField,
  ...reauthFields,
});

/** DELETE /auth/me — the same proof of the owner as an email change. */
export const deleteAccountSchema = z.object({ ...reauthFields });

/** Step 2: the 6-digit code from that email. */
export const confirmEmailCodeSchema = z.object({
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your email'),
  deviceId: z.string().max(120).optional(),
  ...reauthFields,
});

export const applyWholesaleSchema = wholesaleApplication;

export const addressSchema = z.object({
  label: z.string().trim().max(40).optional(),
  fullName: z.string().trim().min(2).max(80),
  phone: phoneNumber,
  line1: z.string().trim().min(4).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit PIN code'),
  isDefault: z.boolean().optional(),
});

export const addressUpdateSchema = addressSchema.partial();

export const userIdParam = z.object({ userId: objectId });
