import { OAuth2Client } from 'google-auth-library';
import { env, googleAuthConfigured } from '../config/env';
import { ApiError } from '../utils/ApiError';

/**
 * Server-side verification of a Google ID token from native sign-in.
 *
 * The client is never trusted to report who it is: the raw ID token is
 * verified against Google's public keys here (signature, expiry, issuer), and
 * only the decoded payload is used. A token minted for another app fails the
 * audience check.
 */
const client = new OAuth2Client();

export interface GoogleIdentity {
  googleId: string;
  email: string;
  name?: string;
  picture?: string;
  /**
   * When Google minted the token (`iat`). An ID token stays valid for an
   * hour, so re-authentication checks this rather than mere validity — an
   * hour-old token does not prove the owner is present now.
   */
  issuedAt?: Date;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!googleAuthConfigured) {
    throw ApiError.serviceUnavailable('Google sign-in is not configured on this server.');
  }

  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      // The WEB client id: native Android sign-in is configured with it as
      // `webClientId`, so it is what Google stamps into `aud`.
      audience: env.GOOGLE_WEB_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    throw ApiError.unauthorized('Could not verify your Google sign-in.', 'GOOGLE_TOKEN_INVALID');
  }

  if (!payload?.sub || !payload.email) {
    throw ApiError.unauthorized('Google did not return an email address.', 'GOOGLE_TOKEN_INVALID');
  }

  // Linking is done by email, so an unverified Google email must never be
  // able to claim an existing account. Strictly `true`, not merely truthy.
  if (payload.email_verified !== true) {
    throw ApiError.unauthorized(
      'Your Google email address is not verified.',
      'GOOGLE_EMAIL_UNVERIFIED',
    );
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name,
    picture: payload.picture,
    issuedAt: payload.iat ? new Date(payload.iat * 1000) : undefined,
  };
}
