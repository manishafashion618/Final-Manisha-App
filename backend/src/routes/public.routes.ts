import { Router, type Response } from 'express';
import { renderPrivacyPolicy } from '../pages/privacyPolicy';
import { renderTerms } from '../pages/terms';

/**
 * Public web pages: no auth, outside the API prefix, linked from the app and
 * from the Play Console listing. Plain HTML with no scripts (helmet's CSP
 * forbids them, and nothing here needs one).
 *
 * Rendered once at startup: the content only changes with a deploy.
 */
const router = Router();

const PRIVACY = renderPrivacyPolicy();
const TERMS = renderTerms();

function sendPage(res: Response, html: string) {
  // Short cache: a correction to the policy should reach readers the same day.
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(html);
}

router.get('/privacy-policy', (_req, res) => sendPage(res, PRIVACY));
router.get('/terms', (_req, res) => sendPage(res, TERMS));

export default router;
