import { api, clearTestDb, connectTestDb, disconnectTestDb, request } from './helpers/testServer';
import { User } from '../models/user.model';

interface CodeEmail {
  to: string;
  code: string;
  purpose?: string;
}

const mockSendCode = jest.fn(async (_input: CodeEmail) => ({ delivered: true }));
const mockSendNotice = jest.fn(async (_previous: string, _next: string) => ({ delivered: true }));
jest.mock('../services/email.service', () => ({
  sendPasswordResetEmail: (input: CodeEmail) => mockSendCode({ ...input, purpose: 'reset' }),
  sendEmailVerificationCode: (input: CodeEmail) => mockSendCode(input),
  sendEmailChangedNotice: (previousEmail: string, newEmail: string) =>
    mockSendNotice(previousEmail, newEmail),
}));

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(async () => {
  mockSendCode.mockClear();
  mockSendNotice.mockClear();
  await clearTestDb();
});

// helpers/env.ts sets ADMIN_EMAILS = ' Owner@Example.com , boss@example.com '.
const PASSWORD = 'Marigold42';

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; accountType: string; email: string; emailVerified: boolean };
}

async function register(email: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const res = await request.post(api('/auth/register')).send({ email, password: PASSWORD, ...extra });
  expect(res.status).toBe(200);
  return res.body.data;
}

const login = (email: string, password = PASSWORD) =>
  request.post(api('/auth/login')).send({ email, password });

function lastCodeFor(email: string): string {
  const call = [...mockSendCode.mock.calls].reverse().find(([input]) => input.to === email);
  if (!call) throw new Error(`No code was emailed to ${email}`);
  return call[0].code;
}

/** Runs the emailed-code flow for `email` on the signed-in account. */
async function proveEmail(accessToken: string, email: string) {
  const requested = await request
    .post(api('/auth/email/request-code'))
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ password: PASSWORD, email });
  expect(requested.status).toBe(200);
  return request
    .post(api('/auth/email/confirm'))
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ password: PASSWORD, otp: lastCodeFor(email.toLowerCase()) });
}

describe('ADMIN_EMAILS grants admin only to a verified address', () => {
  it('does not make a whitelisted address admin at registration (not yet verified)', async () => {
    const owner = await register('owner@example.com');
    expect(owner.user.accountType).toBe('retail');
    expect(owner.user.emailVerified).toBe(false);
  });

  it('makes it admin once the address is verified by emailed code', async () => {
    const owner = await register('owner@example.com');

    const confirmed = await proveEmail(owner.accessToken, 'owner@example.com');

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.user).toMatchObject({ accountType: 'admin', emailVerified: true });
    expect((await login('owner@example.com')).body.data.user.accountType).toBe('admin');
  });

  it('matches case-insensitively, ignores padding, and honours every entry', async () => {
    for (const email of ['OWNER@example.com', 'boss@example.com']) {
      const account = await register(email);
      await proveEmail(account.accessToken, email);
      expect((await login(email)).body.data.user.accountType).toBe('admin');
    }
  });

  it('leaves a verified non-whitelisted address as retail', async () => {
    const shopper = await register('shopper@example.com');
    const confirmed = await proveEmail(shopper.accessToken, 'shopper@example.com');
    expect(confirmed.body.data.user.accountType).toBe('retail');
  });

  it('re-applies admin on every login, not just once', async () => {
    const owner = await register('owner@example.com');
    await proveEmail(owner.accessToken, 'owner@example.com');
    await User.updateOne({ email: 'owner@example.com' }, { $set: { accountType: 'retail' } });

    expect((await login('owner@example.com')).body.data.user.accountType).toBe('admin');
  });

  it('demotes an admin whose address is not on the list', async () => {
    await register('shopper@example.com');
    await User.updateOne({ email: 'shopper@example.com' }, { $set: { accountType: 'admin', emailVerified: true } });

    expect((await login('shopper@example.com')).body.data.user.accountType).toBe('retail');
  });

  it('demotes a whitelisted but unverified admin', async () => {
    await register('owner@example.com');
    await User.updateOne({ email: 'owner@example.com' }, { $set: { accountType: 'admin' } });

    expect((await login('owner@example.com')).body.data.user.accountType).toBe('retail');
  });

  it('demotes to wholesale, not retail, for an approved trade account', async () => {
    await register('trade@example.com', { accountType: 'wholesale' });
    await User.updateOne(
      { email: 'trade@example.com' },
      { $set: { accountType: 'admin', wholesaleStatus: 'approved', emailVerified: true } },
    );

    expect((await login('trade@example.com')).body.data.user.accountType).toBe('wholesale');
  });

  it('leaves staff alone — the list governs admin, not every elevated role', async () => {
    await register('helper@example.com');
    await User.updateOne({ email: 'helper@example.com' }, { $set: { accountType: 'staff' } });

    expect((await login('helper@example.com')).body.data.user.accountType).toBe('staff');
  });

  it('counts a completed password reset as verifying the address', async () => {
    await register('owner@example.com');
    await request.post(api('/auth/forgot-password')).send({ email: 'owner@example.com' });
    const verified = await request
      .post(api('/auth/verify-reset-otp'))
      .send({ email: 'owner@example.com', otp: lastCodeFor('owner@example.com') });
    await request
      .post(api('/auth/reset-password'))
      .send({ token: verified.body.data.resetToken, password: 'NewPass4567' });

    expect((await login('owner@example.com', 'NewPass4567')).body.data.user.accountType).toBe('admin');
  });
});

/*
  F1 — the production-readiness audit's critical finding: a customer PATCHed
  their email to an unclaimed ADMIN_EMAILS address and became admin on the
  next login. Each test below is that attack, and each must fail.
*/
describe('F1: a customer cannot make themselves admin by changing their email', () => {
  it('PATCH /auth/me ignores email entirely', async () => {
    const mallory = await register('mallory@example.com');

    const patched = await request
      .patch(api('/auth/me'))
      .set('Authorization', `Bearer ${mallory.accessToken}`)
      .send({ email: 'owner@example.com', name: 'Mallory' });

    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ email: 'mallory@example.com', name: 'Mallory' });

    // The original repro: re-login under the whitelisted address.
    expect((await login('owner@example.com')).status).toBe(401);

    const again = await login('mallory@example.com');
    expect(again.body.data.user.accountType).toBe('retail');
    const adminUsers = await request
      .get(api('/admin/users'))
      .set('Authorization', `Bearer ${again.body.data.accessToken}`);
    expect(adminUsers.status).toBe(403);
  });

  it('requesting a code for a whitelisted address changes nothing until the code is confirmed', async () => {
    const mallory = await register('mallory@example.com');

    await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${mallory.accessToken}`)
      .send({ password: PASSWORD, email: 'owner@example.com' })
      .expect(200);

    const again = await login('mallory@example.com');
    expect(again.body.data.user).toMatchObject({ email: 'mallory@example.com', accountType: 'retail' });
    expect((await login('owner@example.com')).status).toBe(401);
  });

  it('a guessed code does not apply the change', async () => {
    const mallory = await register('mallory@example.com');
    await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${mallory.accessToken}`)
      .send({ password: PASSWORD, email: 'owner@example.com' });

    const wrong = lastCodeFor('owner@example.com') === '123456' ? '654321' : '123456';
    const res = await request
      .post(api('/auth/email/confirm'))
      .set('Authorization', `Bearer ${mallory.accessToken}`)
      .send({ password: PASSWORD, otp: wrong });

    // 400, not 401: the caller is signed in, only the code is wrong.
    expect(res.status).toBe(400);
    expect((await User.findOne({ email: 'mallory@example.com' }))?.accountType).toBe('retail');
  });
});

describe('verified email change', () => {
  it('rejects an address already in use, case-insensitively', async () => {
    await register('taken@example.com');
    const mallory = await register('mallory@example.com');

    const res = await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${mallory.accessToken}`)
      .send({ password: PASSWORD, email: 'TAKEN@Example.com' });

    expect(res.status).toBe(409);
    expect(mockSendCode).not.toHaveBeenCalled();
  });

  it('applies the change after the code, verifies it, and revokes other sessions', async () => {
    const account = await register('old@example.com');
    const otherDevice = (await login('old@example.com')).body.data;

    const confirmed = await proveEmail(account.accessToken, 'New@Example.com');

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.changed).toBe(true);
    expect(confirmed.body.data.user).toMatchObject({ email: 'new@example.com', emailVerified: true });

    // Every earlier session is gone; the fresh pair from the response works.
    for (const token of [account.refreshToken, otherDevice.refreshToken]) {
      await request.post(api('/auth/refresh')).send({ refreshToken: token }).expect(401);
    }
    await request
      .post(api('/auth/refresh'))
      .send({ refreshToken: confirmed.body.data.refreshToken })
      .expect(200);

    expect((await login('old@example.com')).status).toBe(401);
    expect((await login('new@example.com')).status).toBe(200);
  });

  it('refuses the change if the address was taken between request and confirm', async () => {
    const account = await register('first@example.com');
    await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ password: PASSWORD, email: 'contested@example.com' });

    await register('contested@example.com');

    const res = await request
      .post(api('/auth/email/confirm'))
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ password: PASSWORD, otp: lastCodeFor('contested@example.com') });

    expect(res.status).toBe(409);
  });

  it('locks after too many wrong codes and burns the code', async () => {
    const account = await register('person@example.com');
    await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ password: PASSWORD, email: 'person@example.com' });
    const code = lastCodeFor('person@example.com');

    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await request
        .post(api('/auth/email/confirm'))
        .set('Authorization', `Bearer ${account.accessToken}`)
        .send({ password: PASSWORD, otp: code === '000000' ? '111111' : '000000' });
    }
    expect(last?.status).toBe(429);

    const afterLock = await request
      .post(api('/auth/email/confirm'))
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ password: PASSWORD, otp: code });
    expect(afterLock.status).toBe(429);
  });

  it('refuses to re-verify an already verified address', async () => {
    const account = await register('person@example.com');
    await proveEmail(account.accessToken, 'person@example.com');

    const again = await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ password: PASSWORD, email: 'person@example.com' });
    expect(again.status).toBe(409);
  });
});
