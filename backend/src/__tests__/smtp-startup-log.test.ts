import fs from 'fs';
import path from 'path';

/**
 * The boot log says whether SMTP is configured — one line, like Razorpay's and
 * Cloudinary's — then whether Gmail accepted the sign-in. Never the account or
 * the password, and a failed sign-in only warns.
 */

const SMTP_USER = 'shop.mailbox@example.com';
const SMTP_APP_PASSWORD = 'abcd efgh ijkl mnop';

type EmailService = typeof import('../services/email.service');

function bootEmailService(configured: boolean, verify: jest.Mock = jest.fn()) {
  const logged = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  let service!: EmailService;
  jest.isolateModules(() => {
    jest.doMock('../config/logger', () => ({ logger: logged }));
    jest.doMock('../config/env', () => {
      const actual = jest.requireActual('../config/env');
      return {
        ...actual,
        emailConfigured: configured,
        env: {
          ...actual.env,
          SMTP_USER: configured ? SMTP_USER : undefined,
          SMTP_APP_PASSWORD: configured ? SMTP_APP_PASSWORD : undefined,
        },
      };
    });
    // A stand-in for Gmail: nothing here touches the network.
    jest.doMock('nodemailer', () => ({
      createTransport: () => ({ verify, sendMail: jest.fn() }),
    }));
    service = require('../services/email.service');
  });
  return { logged, service };
}

/** Everything written to the log, as one string. */
const allLogged = (logged: ReturnType<typeof bootEmailService>['logged']) =>
  JSON.stringify([logged.info.mock.calls, logged.warn.mock.calls, logged.error.mock.calls]);

const credentialsIn = (text: string) =>
  [SMTP_USER, 'shop.mailbox', SMTP_APP_PASSWORD, SMTP_APP_PASSWORD.replace(/\s+/g, '')].filter(
    (secret) => text.includes(secret),
  );

describe('SMTP startup line', () => {
  it('says SMTP is configured, without the account or the password', () => {
    const { logged } = bootEmailService(true);

    expect(logged.info).toHaveBeenCalledWith('SMTP configured');
    expect(credentialsIn(allLogged(logged))).toEqual([]);
  });

  it('warns when SMTP is not configured', () => {
    const { logged } = bootEmailService(false);

    expect(logged.warn).toHaveBeenCalledWith(expect.stringMatching(/^SMTP not configured/));
    expect(logged.info).not.toHaveBeenCalledWith('SMTP configured');
  });
});

describe('SMTP verification at startup', () => {
  it('logs "SMTP verified with Gmail" when Gmail accepts the sign-in', async () => {
    const verify = jest.fn().mockResolvedValue(true);
    const { logged, service } = bootEmailService(true, verify);

    await service.verifySmtpConnection();

    expect(verify).toHaveBeenCalledTimes(1);
    expect(logged.info).toHaveBeenCalledWith('SMTP verified with Gmail');
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it('warns with the error message, never the credentials, and does not throw', async () => {
    // A failure whose message happens to echo both credentials back.
    const verify = jest
      .fn()
      .mockRejectedValue(
        new Error(
          `Invalid login: 535-5.7.8 Username and Password not accepted for ${SMTP_USER} using ${SMTP_APP_PASSWORD.replace(/\s+/g, '')} / ${SMTP_APP_PASSWORD}`,
        ),
      );
    const { logged, service } = bootEmailService(true, verify);

    await expect(service.verifySmtpConnection()).resolves.toBeUndefined();

    expect(logged.warn).toHaveBeenCalledTimes(1);
    const [warning] = logged.warn.mock.calls[0];
    expect(warning).toMatch(/^SMTP could not be verified with Gmail: Invalid login: 535-5\.7\.8/);
    expect(warning).toContain('Username and Password not accepted');
    expect(credentialsIn(allLogged(logged))).toEqual([]);
    expect(logged.info).not.toHaveBeenCalledWith('SMTP verified with Gmail');
  });

  it('does nothing when SMTP is not configured', async () => {
    const verify = jest.fn();
    const { service } = bootEmailService(false, verify);

    await service.verifySmtpConnection();

    expect(verify).not.toHaveBeenCalled();
  });

  it('is started without being awaited, so it never delays the server listening', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');

    expect(server).toContain('void verifySmtpConnection();');
    expect(server).not.toMatch(/await\s+verifySmtpConnection/);
    expect(server.indexOf('void verifySmtpConnection();')).toBeLessThan(server.indexOf('app.listen('));
  });
});
