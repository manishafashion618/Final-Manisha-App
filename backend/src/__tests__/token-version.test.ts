import jwt from 'jsonwebtoken';
import { api, clearTestDb, connectTestDb, disconnectTestDb, request } from './helpers/testServer';
import { User } from '../models/user.model';
import { RoleChange } from '../models/roleChange.model';

/**
 * S-1 — tokenVersion. Every "sign everyone out" event must kill an access
 * token that was already handed out, on the very next request, rather than
 * leaving it working until JWT_ACCESS_TTL runs out.
 */

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
  sendEmailChangedNotice: (previous: string, next: string) => mockSendNotice(previous, next),
}));

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken(...args: unknown[]) {
      return mockVerifyIdToken(...args);
    }
  },
}));

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(async () => {
  mockSendCode.mockClear();
  mockSendNotice.mockClear();
  mockVerifyIdToken.mockReset();
  await clearTestDb();
});

const PASSWORD = 'Marigold42';

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; accountType: string; email: string };
}

async function register(email: string): Promise<Session> {
  const res = await request.post(api('/auth/register')).send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data;
}

async function login(email: string, password = PASSWORD): Promise<Session> {
  const res = await request.post(api('/auth/login')).send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data;
}

/** A real admin: a whitelisted address (helpers/env.ts), verified, signed in. */
async function adminSession(): Promise<Session> {
  const session = await register('owner@example.com');
  await User.updateOne({ _id: session.user.id }, { $set: { emailVerified: true } });
  const admin = await login('owner@example.com');
  expect(admin.user.accountType).toBe('admin');
  return admin;
}

const me = (token: string) => request.get(api('/auth/me')).set('Authorization', `Bearer ${token}`);

async function expectRevoked(token: string) {
  const res = await me(token);
  expect(res.status).toBe(401);
  expect(res.body.error.code).toBe('TOKEN_REVOKED');
}

function lastCodeFor(email: string): string {
  const call = [...mockSendCode.mock.calls].reverse().find(([input]) => input.to === email);
  if (!call) throw new Error(`No code was emailed to ${email}`);
  return call[0].code;
}

function googleSignsIn(overrides: Record<string, unknown> = {}) {
  const payload = {
    sub: 'google-sub-owner',
    email: 'owner@example.com',
    email_verified: true,
    name: 'The Owner',
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  };
  mockVerifyIdToken.mockResolvedValueOnce({ getPayload: () => payload });
  return payload;
}

describe('S-1: an access token already handed out dies on the next request', () => {
  it('after a password reset', async () => {
    const session = await register('shopper@example.com');
    expect((await me(session.accessToken)).status).toBe(200);

    await request.post(api('/auth/forgot-password')).send({ email: 'shopper@example.com' });
    const verified = await request
      .post(api('/auth/verify-reset-otp'))
      .send({ email: 'shopper@example.com', otp: lastCodeFor('shopper@example.com') });
    const reset = await request
      .post(api('/auth/reset-password'))
      .send({ token: verified.body.data.resetToken, password: 'Jasmine9000' });
    expect(reset.status).toBe(200);

    await expectRevoked(session.accessToken);
  });

  it('after an email change — and the OLD address is told', async () => {
    const session = await register('before@example.com');
    const other = await login('before@example.com');

    await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ email: 'after@example.com', password: PASSWORD })
      .expect(200);
    const confirmed = await request
      .post(api('/auth/email/confirm'))
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ otp: lastCodeFor('after@example.com'), password: PASSWORD });
    expect(confirmed.status).toBe(200);

    // Every earlier token is dead, on this device and the other one…
    await expectRevoked(session.accessToken);
    await expectRevoked(other.accessToken);
    // …while the pair handed back by the confirm works.
    expect((await me(confirmed.body.data.accessToken)).status).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSendNotice).toHaveBeenCalledWith('before@example.com', 'after@example.com');
  });

  it('after an admin changes the role, and the change is logged', async () => {
    const admin = await adminSession();
    const shopper = await register('shopper@example.com');

    const res = await request
      .patch(api(`/admin/users/${shopper.user.id}/role`))
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ accountType: 'staff' });
    expect(res.status).toBe(200);

    await expectRevoked(shopper.accessToken);

    const rows = await RoleChange.find().lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'role',
      from: 'retail',
      to: 'staff',
      actorEmail: 'owner@example.com',
      targetEmail: 'shopper@example.com',
    });
    expect(String(rows[0].actorId)).toBe(admin.user.id);
    expect(String(rows[0].targetId)).toBe(shopper.user.id);

    const log = await request
      .get(api('/admin/role-changes'))
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(log.status).toBe(200);
    expect(log.body.data[0]).toMatchObject({
      actorEmail: 'owner@example.com',
      targetEmail: 'shopper@example.com',
      from: 'retail',
      to: 'staff',
    });
  });

  it('after deactivation — a 401 the app signs out on, not a 403', async () => {
    const admin = await adminSession();
    const shopper = await register('shopper@example.com');

    await request
      .patch(api(`/admin/users/${shopper.user.id}/active`))
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ isActive: false })
      .expect(200);

    await expectRevoked(shopper.accessToken);
    expect(await RoleChange.countDocuments({ action: 'active', to: 'false' })).toBe(1);
  });

  it('after ADMIN_EMAILS demotes an account at refresh — the refresh hands back a pair that works', async () => {
    const session = await register('shopper@example.com');
    // An admin that is not on the whitelist, as if the address had been removed.
    await User.updateOne(
      { _id: session.user.id },
      { $set: { accountType: 'admin', emailVerified: true } },
    );

    const refreshed = await request.post(api('/auth/refresh')).send({ refreshToken: session.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.user.accountType).toBe('retail');

    await expectRevoked(session.accessToken);
    expect((await me(refreshed.body.data.accessToken)).status).toBe(200);
  });

  it('after logout-all, on every device, and the refresh tokens with them', async () => {
    const phone = await register('shopper@example.com');
    const tablet = await login('shopper@example.com');

    await request
      .post(api('/auth/logout-all'))
      .set('Authorization', `Bearer ${phone.accessToken}`)
      .expect(200);

    await expectRevoked(phone.accessToken);
    await expectRevoked(tablet.accessToken);
    const refresh = await request.post(api('/auth/refresh')).send({ refreshToken: tablet.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('does NOT sign anyone out on deploy: a token minted before tokenVersion existed still works', async () => {
    const session = await register('shopper@example.com');
    // Exactly what a pre-deploy token looks like: no `tv` claim at all.
    const legacy = jwt.sign(
      { sub: session.user.id, accountType: 'retail', wholesaleStatus: 'none', tokenType: 'access' },
      process.env.JWT_ACCESS_SECRET as string,
      { algorithm: 'HS256', expiresIn: '30m', issuer: 'manisha-fashions' },
    );
    // …and a user row that predates the field.
    await User.collection.updateOne({ email: 'shopper@example.com' }, { $unset: { tokenVersion: 1 } });

    expect((await me(legacy)).status).toBe(200);
  });
});

describe('The reviewer scenario: an attacker pre-registers a whitelisted admin address', () => {
  it('gets no admin, and loses the account the moment the owner proves it with Google', async () => {
    // The attacker gets there first and sets a password they know.
    const attacker = await register('owner@example.com');
    expect(attacker.user.accountType).toBe('retail');

    // …and leaves a change-email request armed, pointing at their own inbox.
    await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .send({ email: 'attacker@evil.example', password: PASSWORD })
      .expect(200);
    const armed = await User.findById(attacker.user.id).select('+pendingEmail +emailCodeHash');
    expect(armed?.pendingEmail).toBe('attacker@evil.example');

    // The real owner signs in with Google, which proves the address.
    googleSignsIn();
    const owner = await request.post(api('/auth/google')).send({ idToken: 'owner-id-token' });
    expect(owner.status).toBe(200);
    expect(owner.body.data.user.accountType).toBe('admin');

    // The attacker's session is dead on the next request…
    await expectRevoked(attacker.accessToken);
    // …their password no longer opens the account…
    const retry = await request.post(api('/auth/login')).send({ email: 'owner@example.com', password: PASSWORD });
    expect(retry.status).toBe(401);
    // …and the change-email request they left behind has been disarmed.
    const cleaned = await User.findById(attacker.user.id).select(
      '+pendingEmail +emailCodeHash +emailCodeExpiresAt +passwordHash',
    );
    expect(cleaned?.pendingEmail).toBeUndefined();
    expect(cleaned?.emailCodeHash).toBeUndefined();
    expect(cleaned?.emailCodeExpiresAt).toBeUndefined();
    expect(cleaned?.passwordHash).toBeUndefined();
  });
});

describe('Changing the email demands the owner, not just a session', () => {
  it('refuses a request with no password', async () => {
    const session = await register('shopper@example.com');
    const res = await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ email: 'new@example.com' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
    expect(mockSendCode).not.toHaveBeenCalled();
  });

  it('refuses a wrong password', async () => {
    const session = await register('shopper@example.com');
    const res = await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ email: 'new@example.com', password: 'NotMyPassword1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REAUTH_FAILED');
  });

  it('refuses the confirm step without the password too', async () => {
    const session = await register('shopper@example.com');
    await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ email: 'new@example.com', password: PASSWORD })
      .expect(200);
    const res = await request
      .post(api('/auth/email/confirm'))
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ otp: lastCodeFor('new@example.com') });
    expect(res.status).toBe(401);
    expect((await User.findById(session.user.id))?.email).toBe('shopper@example.com');
  });

  it('accepts a fresh Google token for a Google-only account, and refuses a stale one', async () => {
    googleSignsIn({ sub: 'google-sub-shopper', email: 'shopper@example.com' });
    const signedIn = await request.post(api('/auth/google')).send({ idToken: 'id-token' });
    const token = signedIn.body.data.accessToken;

    // Minted ten minutes ago: valid for Google, too old to prove presence now.
    googleSignsIn({
      sub: 'google-sub-shopper',
      email: 'shopper@example.com',
      iat: Math.floor(Date.now() / 1000) - 600,
    });
    const stale = await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new@example.com', googleIdToken: 'stale-token' });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('REAUTH_REQUIRED');

    googleSignsIn({ sub: 'google-sub-shopper', email: 'shopper@example.com' });
    const fresh = await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new@example.com', googleIdToken: 'fresh-token' });
    expect(fresh.status).toBe(200);
  });

  it('refuses a Google token that belongs to a different Google account', async () => {
    googleSignsIn({ sub: 'google-sub-shopper', email: 'shopper@example.com' });
    const signedIn = await request.post(api('/auth/google')).send({ idToken: 'id-token' });

    googleSignsIn({ sub: 'google-sub-SOMEONE-ELSE', email: 'someone@example.com' });
    const res = await request
      .post(api('/auth/email/request-code'))
      .set('Authorization', `Bearer ${signedIn.body.data.accessToken}`)
      .send({ email: 'new@example.com', googleIdToken: 'other-token' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REAUTH_FAILED');
  });
});

describe('The role endpoint can never grant admin', () => {
  it('rejects accountType admin and leaves the account as it was', async () => {
    const admin = await adminSession();
    const shopper = await register('shopper@example.com');

    const res = await request
      .patch(api(`/admin/users/${shopper.user.id}/role`))
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ accountType: 'admin' });

    expect(res.status).toBe(422);
    expect((await User.findById(shopper.user.id))?.accountType).toBe('retail');
    expect(await RoleChange.countDocuments()).toBe(0);
    // Nothing happened, so nothing was revoked either.
    expect((await me(shopper.accessToken)).status).toBe(200);
  });
});
