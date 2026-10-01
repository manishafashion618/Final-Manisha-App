import fs from 'fs';
import path from 'path';

/**
 * How mail leaves the server: Brevo's HTTPS API when BREVO_API_KEY is set,
 * Gmail SMTP otherwise, the dev log when neither. Also the startup line, the
 * startup check, and that no key, password or recipient ever reaches the log.
 *
 * Nothing here touches the network: fetch and nodemailer are stand-ins.
 */

const BREVO_KEY = 'xkeysib-0123456789abcdef0123456789abcdef-TESTKEYZ';
const SMTP_USER = 'shop.mailbox@example.com';
const SMTP_APP_PASSWORD = 'abcd efgh ijkl mnop';
const RECIPIENT = 'customer.person@example.org';

type EmailService = typeof import('../services/email.service');

interface Boot {
  brevo?: boolean;
  smtp?: boolean;
  verify?: jest.Mock;
  sendMail?: jest.Mock;
}

const realFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

function bootEmailService({ brevo = false, smtp = false, verify = jest.fn(), sendMail = jest.fn() }: Boot) {
  const logged = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  let service!: EmailService;
  jest.isolateModules(() => {
    jest.doMock('../config/logger', () => ({ logger: logged }));
    jest.doMock('../config/env', () => {
      const actual = jest.requireActual('../config/env');
      return {
        ...actual,
        brevoConfigured: brevo,
        smtpConfigured: smtp,
        emailConfigured: brevo || smtp,
        isProduction: false,
        env: {
          ...actual.env,
          BREVO_API_KEY: brevo ? BREVO_KEY : undefined,
          SMTP_USER: smtp ? SMTP_USER : undefined,
          SMTP_APP_PASSWORD: smtp ? SMTP_APP_PASSWORD : undefined,
        },
      };
    });
    jest.doMock('nodemailer', () => ({ createTransport: () => ({ verify, sendMail }) }));
    service = require('../services/email.service');
  });
  return { logged, service, verify, sendMail };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Everything written to the log, as one string. */
const allLogged = (logged: ReturnType<typeof bootEmailService>['logged']) =>
  JSON.stringify([
    logged.info.mock.calls,
    logged.warn.mock.calls,
    logged.error.mock.calls,
    logged.debug.mock.calls,
  ]);

/** Any secret or recipient that made it into the log. Must stay empty. */
const leaksIn = (text: string) =>
  [
    BREVO_KEY,
    'xkeysib',
    SMTP_USER,
    SMTP_APP_PASSWORD,
    SMTP_APP_PASSWORD.replace(/\s+/g, ''),
    RECIPIENT,
    'customer.person',
  ].filter((secret) => text.includes(secret));

const resetInput = { to: RECIPIENT, code: '482913', expiresInMinutes: 10 };

describe('the startup line', () => {
  it('says "Email: Brevo API" when the key is set — even if SMTP is set too', () => {
    const { logged } = bootEmailService({ brevo: true, smtp: true });
    expect(logged.info).toHaveBeenCalledWith('Email: Brevo API');
    expect(logged.info).not.toHaveBeenCalledWith('Email: SMTP');
    expect(leaksIn(allLogged(logged))).toEqual([]);
  });

  it('says "Email: SMTP" without a key', () => {
    const { logged } = bootEmailService({ smtp: true });
    expect(logged.info).toHaveBeenCalledWith('Email: SMTP');
    expect(leaksIn(allLogged(logged))).toEqual([]);
  });

  it('warns when neither is configured', () => {
    const { logged } = bootEmailService({});
    expect(logged.warn).toHaveBeenCalledWith(expect.stringMatching(/^Email: not configured/));
  });
});

describe('sending through Brevo', () => {
  it('posts the real template to Brevo and reports it delivered', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { messageId: '<abc@smtp-relay.mailin.fr>' }));
    const { service, sendMail, logged } = bootEmailService({ brevo: true, smtp: true });

    const result = await service.sendPasswordResetEmail(resetInput);

    expect(result).toEqual({ delivered: true });
    expect(sendMail).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe(BREVO_KEY);
    const body = JSON.parse(init.body);
    expect(body.sender).toEqual({ email: 'manishafashion618@gmail.com', name: 'Manisha Fashions' });
    expect(body.to).toEqual([{ email: RECIPIENT }]);
    expect(body.subject).toBe('Reset your Manisha Fashions password');
    expect(body.htmlContent).toContain('482913');
    expect(body.textContent).toContain('482913');
    expect(leaksIn(allLogged(logged))).toEqual([]);
  });

  it.each([
    ['password reset', (s: EmailService) => s.sendPasswordResetEmail(resetInput), 'Reset your Manisha Fashions password'],
    [
      'email verification',
      (s: EmailService) => s.sendEmailVerificationCode({ ...resetInput, purpose: 'verify' }),
      'Verify your Manisha Fashions email',
    ],
    [
      'email change',
      (s: EmailService) => s.sendEmailVerificationCode({ ...resetInput, purpose: 'change' }),
      'Confirm your new Manisha Fashions email',
    ],
    [
      'account deletion',
      (s: EmailService) => s.sendAccountDeletionCode(resetInput),
      'Confirm deleting your Manisha Fashions account',
    ],
    [
      'email-changed notice',
      (s: EmailService) => s.sendEmailChangedNotice(RECIPIENT, 'new.address@example.net'),
      'Your Manisha Fashions email address was changed',
    ],
  ])('keeps the %s subject and template', async (_label, send, subject) => {
    fetchMock.mockResolvedValue(jsonResponse(201, { messageId: 'x' }));
    const { service } = bootEmailService({ brevo: true });

    await send(service);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toBe(subject);
    expect(body.htmlContent).toContain('Manisha Fashions');
    expect(body.textContent.length).toBeGreaterThan(20);
  });

  it('logs a Brevo error with its status and message — no key, no recipient', async () => {
    // A rejection whose message happens to echo the recipient and the key.
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        code: 'invalid_parameter',
        message: `sender not valid for ${RECIPIENT} using ${BREVO_KEY}`,
      }),
    );
    const { service, logged } = bootEmailService({ brevo: true });

    const result = await service.sendPasswordResetEmail(resetInput);

    expect(result.delivered).toBe(false);
    expect(logged.error).toHaveBeenCalledTimes(1);
    const [line] = logged.error.mock.calls[0];
    expect(line).toMatch(/^Email \(reset\) failed to send via Brevo: HTTP 400 invalid_parameter: sender not valid/);
    expect(leaksIn(allLogged(logged))).toEqual([]);
  });

  it('logs a network failure too, never silently', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const { service, logged } = bootEmailService({ brevo: true });

    const result = await service.sendAccountDeletionCode(resetInput);

    expect(result.delivered).toBe(false);
    expect(logged.error).toHaveBeenCalledWith('Email (delete) failed to send via Brevo: fetch failed');
    expect(leaksIn(allLogged(logged))).toEqual([]);
  });
});

describe('the SMTP path, without a Brevo key', () => {
  it('is still used, with the same subject and template', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'x' });
    const { service } = bootEmailService({ smtp: true, sendMail });

    const result = await service.sendPasswordResetEmail(resetInput);

    expect(result).toEqual({ delivered: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: RECIPIENT,
        subject: 'Reset your Manisha Fashions password',
        text: expect.stringContaining('482913'),
        html: expect.stringContaining('482913'),
      }),
    );
  });

  it('logs an SMTP failure without the account, password or recipient', async () => {
    const sendMail = jest
      .fn()
      .mockRejectedValue(new Error(`Invalid login for ${SMTP_USER} (${SMTP_APP_PASSWORD}) sending to ${RECIPIENT}`));
    const { service, logged } = bootEmailService({ smtp: true, sendMail });

    const result = await service.sendPasswordResetEmail(resetInput);

    expect(result.delivered).toBe(false);
    expect(logged.error).toHaveBeenCalledWith(expect.stringMatching(/^Email \(reset\) failed to send via SMTP: Invalid login/));
    expect(leaksIn(allLogged(logged))).toEqual([]);
  });
});

describe('the startup check', () => {
  it('logs "Brevo verified" on success, and skips the Gmail sign-in', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { email: 'owner@example.com', plan: [] }));
    const verify = jest.fn();
    const { service, logged } = bootEmailService({ brevo: true, smtp: true, verify });

    await service.verifyEmailTransport();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.brevo.com/v3/account',
      expect.objectContaining({ headers: expect.objectContaining({ 'api-key': BREVO_KEY }) }),
    );
    expect(logged.info).toHaveBeenCalledWith('Brevo verified');
    expect(verify).not.toHaveBeenCalled();
    expect(leaksIn(allLogged(logged))).toEqual([]);
    // The account's own details are not logged either.
    expect(allLogged(logged)).not.toContain('owner@example.com');
  });

  it('warns with Brevo\'s error on failure, never the key, and does not throw', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { code: 'unauthorized', message: `Key not found: ${BREVO_KEY}` }));
    const { service, logged } = bootEmailService({ brevo: true });

    await expect(service.verifyEmailTransport()).resolves.toBeUndefined();

    expect(logged.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Brevo could not be verified: HTTP 401 unauthorized: Key not found/),
    );
    expect(logged.info).not.toHaveBeenCalledWith('Brevo verified');
    expect(leaksIn(allLogged(logged))).toEqual([]);
  });

  it('warns when Brevo cannot be reached, and does not throw', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const { service, logged } = bootEmailService({ brevo: true });

    await expect(service.verifyEmailTransport()).resolves.toBeUndefined();
    expect(logged.warn).toHaveBeenCalledWith('Brevo could not be verified: fetch failed');
  });

  it('still signs in to Gmail when there is no Brevo key', async () => {
    const verify = jest.fn().mockResolvedValue(true);
    const { service, logged } = bootEmailService({ smtp: true, verify });

    await service.verifyEmailTransport();

    expect(verify).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.info).toHaveBeenCalledWith('SMTP verified with Gmail');
  });

  it('warns on a failed Gmail sign-in without the credentials', async () => {
    const verify = jest
      .fn()
      .mockRejectedValue(new Error(`Invalid login: 535-5.7.8 not accepted for ${SMTP_USER} / ${SMTP_APP_PASSWORD}`));
    const { service, logged } = bootEmailService({ smtp: true, verify });

    await expect(service.verifyEmailTransport()).resolves.toBeUndefined();

    expect(logged.warn).toHaveBeenCalledWith(expect.stringMatching(/^SMTP could not be verified with Gmail: Invalid login/));
    expect(leaksIn(allLogged(logged))).toEqual([]);
  });

  it('is started from server.ts without being awaited, before it listens', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');

    expect(server).toContain('void verifyEmailTransport();');
    expect(server).not.toMatch(/await\s+verifyEmailTransport/);
    expect(server.indexOf('void verifyEmailTransport();')).toBeLessThan(server.indexOf('app.listen('));
  });
});

describe('production boot', () => {
  const strong = 'k3Jq9vX2mP8wR4tY7uZ1aB6cD0eF5gH-prod';

  function bootProduction(overrides: Record<string, string>) {
    const saved = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'production',
      GOOGLE_WEB_CLIENT_ID: 'prod-test.apps.googleusercontent.com',
      JWT_ACCESS_SECRET: strong,
      JWT_REFRESH_SECRET: `${strong}-refresh-Zq8`,
      BREVO_API_KEY: '',
      SMTP_USER: '',
      SMTP_APP_PASSWORD: '',
      ...overrides,
    });
    try {
      jest.isolateModules(() => {
        require('../config/env');
      });
    } finally {
      process.env = saved;
    }
  }

  it('starts with a Brevo key and no SMTP settings', () => {
    expect(() => bootProduction({ BREVO_API_KEY: BREVO_KEY })).not.toThrow();
  });

  it('still starts with SMTP settings and no Brevo key', () => {
    expect(() => bootProduction({ SMTP_USER, SMTP_APP_PASSWORD })).not.toThrow();
  });

  it('refuses to start with neither', () => {
    expect(() => bootProduction({})).toThrow(/SMTP_USER \(or BREVO_API_KEY\)/);
  });
});
