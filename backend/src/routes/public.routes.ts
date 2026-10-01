import express, { Router, type Request, type Response } from 'express';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { createRateLimiter } from '../middleware/rateLimiter';
import {
  renderAccountDeletion,
  type DeletionNotice,
  type DeletionView,
} from '../pages/accountDeletion';
import { renderPrivacyPolicy } from '../pages/privacyPolicy';
import { renderTerms } from '../pages/terms';
import * as accountService from '../services/account.service';
import { ApiError } from '../utils/ApiError';

/**
 * Public web pages: no auth, outside the API prefix, linked from the app and
 * from the Play Console listing. Plain HTML with no scripts (helmet's CSP
 * forbids them, and nothing here needs one).
 *
 * The static pages are rendered once at startup: their content only changes
 * with a deploy.
 */
const router = Router();

const PRIVACY = renderPrivacyPolicy();
const TERMS = renderTerms();
const DELETION_START = renderAccountDeletion({ step: 'email' });

function sendPage(res: Response, html: string) {
  // Short cache: a correction to the policy should reach readers the same day.
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(html);
}

router.get('/privacy-policy', (_req, res) => sendPage(res, PRIVACY));
router.get('/terms', (_req, res) => sendPage(res, TERMS));
router.get('/account-deletion', (_req, res) => sendPage(res, DELETION_START));
// A reload or Back after submitting a step re-requests its address with GET.
// There is nothing to show there, so start the page again (303: a GET, never
// a re-post of the form).
router.get(['/account-deletion/code', '/account-deletion/confirm'], (_req, res) => {
  res.redirect(303, '/account-deletion');
});

/* ── Account deletion by emailed code (Google Play's web deletion URL) ──────
 *
 * Step 1 posts an email and always gets the same page back, whether or not an
 * account uses it; step 2 posts the code and runs the same erase as the app.
 * The code flow itself (quota, lockout, single use) is account.service.ts.
 */

/** Form posts only; the app-wide body parsers are mounted after this router. */
const deletionForm = express.urlencoded({ extended: false, limit: '10kb', parameterLimit: 10 });

const MAX_EMAIL_LENGTH = 254;

/** A posted field, trimmed — only when it arrived as one plain string. */
function field(req: Request, name: string): string | undefined {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value.trim() : undefined;
}

function sendDeletion(res: Response, status: number, view: DeletionView) {
  // These pages echo the visitor's email: never cached anywhere.
  res.set('Cache-Control', 'no-store');
  res.status(status).type('html').send(renderAccountDeletion(view));
}

function serverError(res: Response) {
  res.set('Cache-Control', 'no-store');
  res.status(500).type('text').send('Something went wrong. Please try again in a few minutes.');
}

/**
 * Per-IP ceiling on both steps, answered with the page itself rather than the
 * API's JSON. Runs after the body is parsed, so a refused step 2 can keep the
 * visitor's email on screen.
 */
const deletionLimiter = createRateLimiter({
  windowMs: 60_000,
  limit: env.RATE_LIMIT_AUTH_PER_MIN,
  prefix: 'account-deletion',
  handler: (req, res) => {
    const email = field(req, 'email');
    sendDeletion(
      res,
      429,
      req.path.endsWith('/confirm') && email
        ? { step: 'code', email, notice: 'rate-limited' }
        : { step: 'email', notice: 'rate-limited' },
    );
  },
});

router.post('/account-deletion/code', deletionForm, deletionLimiter, async (req, res) => {
  const email = field(req, 'email');
  if (!email || email.length > MAX_EMAIL_LENGTH || !email.includes('@')) {
    sendDeletion(res, 400, { step: 'email' });
    return;
  }

  try {
    await accountService.requestDeletionCode(email);
  } catch (error) {
    logger.error('Account deletion: could not issue a code', error);
    serverError(res);
    return;
  }

  // Identical whether or not an account uses this address — the service
  // already does the same work either way, so the timing does not tell.
  sendDeletion(res, 200, { step: 'code', email, notice: 'code-sent' });
});

/** Which notice, and status, a refusal from the service becomes. */
function refusal(error: unknown): { status: number; notice: DeletionNotice } | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.statusCode) {
    // A wrong, expired or used code. 404 — the code matched but its account
    // has since gone — reads the same, so it tells a visitor nothing new.
    case 400:
    case 404:
      return { status: 400, notice: 'wrong-code' };
    case 429:
      return { status: 429, notice: 'locked' };
    case 409:
      return { status: 409, notice: 'open-order' };
    case 403:
      return { status: 403, notice: 'admin' };
    default:
      return null;
  }
}

router.post('/account-deletion/confirm', deletionForm, deletionLimiter, async (req, res) => {
  const email = field(req, 'email');
  const code = field(req, 'code');
  if (!email || email.length > MAX_EMAIL_LENGTH) {
    sendDeletion(res, 400, { step: 'email' });
    return;
  }
  // Checked first, so a missed tick never spends one of the five tries.
  if (field(req, 'confirm') !== 'yes') {
    sendDeletion(res, 400, { step: 'code', email, notice: 'confirm-required' });
    return;
  }
  if (!code || !/^\d{6}$/.test(code)) {
    sendDeletion(res, 400, { step: 'code', email, notice: 'wrong-code' });
    return;
  }

  try {
    await accountService.confirmDeletionByCode(email, code);
  } catch (error) {
    const refused = refusal(error);
    if (refused) {
      sendDeletion(res, refused.status, { step: 'code', email, notice: refused.notice });
      return;
    }
    logger.error('Account deletion: confirming a code failed', error);
    serverError(res);
    return;
  }

  sendDeletion(res, 200, { step: 'deleted' });
});

export default router;
