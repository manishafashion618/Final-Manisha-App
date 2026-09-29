import { api, request } from './helpers/testServer';

/** The page text as a reader sees it: HTML collapses line breaks to spaces. */
const readable = async (path: string) => (await request.get(path)).text.replace(/\s+/g, ' ');

/**
 * B-2 — the privacy policy and terms are public, script-free HTML pages
 * outside the API. Also pins the policy's corrections, so wording that
 * contradicts what the app does cannot quietly come back.
 */

describe('GET /privacy-policy', () => {
  it('is public HTML, with no script and the site security headers', async () => {
    const res = await request.get('/privacy-policy');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.text).not.toMatch(/<script/i);
  });

  it('covers what Play reviewers look for', async () => {
    const text = await readable('/privacy-policy');

    for (const expected of [
      'Privacy Policy',
      'in.manishafashions.app',
      'Razorpay',
      'MongoDB Atlas',
      'Account → Delete account',
      'https://final-manisha-app.onrender.com/account-deletion',
      'Digital Personal Data Protection Act, 2023',
      'manishafashion618@gmail.com',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('[DATE]');
  });

  it('matches what the app actually does', async () => {
    const text = await readable('/privacy-policy');

    // Google sign-in stores these (auth.service), so the policy says so.
    expect(text).toContain('email, name, profile photo and account ID');
    // The server logs IP addresses (morgan) and rate-limits by them.
    expect(text).toContain('IP address');
    // Deletion keeps reviews, anonymised (account.service).
    expect(text).toContain('shown as "Customer"');
    // There are no push notifications, no order emails, and no Profile menu.
    expect(text).not.toMatch(/notifications\)/);
    expect(text).not.toContain('order or account notices');
    expect(text).not.toContain('Profile → Account');
  });
});

describe('GET /terms', () => {
  it('is public HTML with a contact', async () => {
    const res = await request.get('/terms');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Terms of service');
    expect(res.text).toContain('manishafashion618@gmail.com');
    expect(res.text).not.toMatch(/<script/i);
  });
});

describe('placement', () => {
  it('lives outside the API prefix', async () => {
    const res = await request.get(api('/privacy-policy'));
    expect(res.status).toBe(404);
  });
});
