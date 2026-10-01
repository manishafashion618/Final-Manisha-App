import { api, request } from './helpers/testServer';

/**
 * Reload/Back on the deletion form's post-only addresses, and the 404s a
 * browser sees (HTML) versus the ones the app sees (JSON).
 */

describe('reloading or going Back on the account-deletion form', () => {
  it.each(['/account-deletion/code', '/account-deletion/confirm'])(
    'GET %s is redirected (303) to the start of the page',
    async (path) => {
      const res = await request.get(path);
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe('/account-deletion');
    },
  );

  it('lands on the working page', async () => {
    const redirected = await request.get('/account-deletion/confirm');
    const landed = await request.get(redirected.headers.location);
    expect(landed.status).toBe(200);
    expect(landed.text).toContain('action="/account-deletion/code"');
  });
});

describe('a browser asking for a page that does not exist', () => {
  it.each(['/no-such-page-7f3k', '/', '/static/missing.jpg'])('GET %s gets an HTML 404 with links', async (path) => {
    const res = await request.get(path);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Page not found');
    expect(res.text).toContain('href="/account-deletion"');
    expect(res.text).toContain('href="/privacy-policy"');
    expect(res.text).not.toMatch(/<script/i);
  });

  it('does not echo the requested address into the page', async () => {
    const res = await request.get('/%3Cb%3Eecho-me-9q2%3C%2Fb%3E');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('echo-me-9q2');
  });

  it('answers HEAD with the same 404 and no body', async () => {
    const res = await request.head('/no-such-page-7f3k');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text ?? '').toBe('');
  });
});

describe('the API keeps JSON 404s', () => {
  it.each([api('/no-such-route'), '/api/no-such-route', '/api'])('GET %s', async (path) => {
    const res = await request.get(path);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('as does any non-GET request outside /api', async () => {
    const res = await request.post('/no-such-page-7f3k').send({});
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
