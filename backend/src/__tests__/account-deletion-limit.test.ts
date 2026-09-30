import { clearTestDb, connectTestDb, disconnectTestDb, request } from './helpers/testServer';

/**
 * The account-deletion page's rate limit answers with the page itself, not
 * the API's JSON. Its own file: the limit is lowered for the whole file.
 */
jest.mock('../config/env', () => {
  const actual = jest.requireActual('../config/env');
  return { ...actual, env: { ...actual.env, RATE_LIMIT_AUTH_PER_MIN: 2 } };
});

jest.mock('../services/email.service', () => ({
  sendAccountDeletionCode: async () => ({ delivered: true }),
}));

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const postForm = (path: string, fields: Record<string, string>) =>
  request.post(path).type('form').send(fields);

describe('rate limit on the account-deletion page', () => {
  it('answers with the HTML page and keeps the email on step 2', async () => {
    await postForm('/account-deletion/code', { email: 'someone@example.com' }).expect(200);
    await postForm('/account-deletion/code', { email: 'someone@example.com' }).expect(200);

    const step1 = await postForm('/account-deletion/code', { email: 'someone@example.com' });
    expect(step1.status).toBe(429);
    expect(step1.headers['content-type']).toMatch(/text\/html/);
    expect(step1.text).toContain('role="alert"');
    expect(step1.text).toContain('action="/account-deletion/code"');

    // Both steps share one budget; a refused step 2 stays on the code form.
    const step2 = await postForm('/account-deletion/confirm', {
      email: 'someone@example.com',
      code: '123456',
      confirm: 'yes',
    });
    expect(step2.status).toBe(429);
    expect(step2.text).toContain('action="/account-deletion/confirm"');
    expect(step2.text).toContain('value="someone@example.com"');
  });
});
