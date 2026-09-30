/**
 * The boot log says whether SMTP is configured — one line, like Razorpay's and
 * Cloudinary's — and never prints the account or the password.
 */

const SMTP_USER = 'shop.mailbox@example.com';
const SMTP_APP_PASSWORD = 'abcd efgh ijkl mnop';

function bootEmailService(configured: boolean) {
  const logged = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
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
    require('../services/email.service');
  });
  return logged;
}

/** Everything written to the log, as one string. */
const allLogged = (logged: ReturnType<typeof bootEmailService>) =>
  JSON.stringify([logged.info.mock.calls, logged.warn.mock.calls, logged.error.mock.calls]);

describe('SMTP startup line', () => {
  it('says SMTP is configured, without the account or the password', () => {
    const logged = bootEmailService(true);

    expect(logged.info).toHaveBeenCalledWith('SMTP configured');
    const text = allLogged(logged);
    expect(text).not.toContain(SMTP_USER);
    expect(text).not.toContain('shop.mailbox');
    expect(text).not.toContain('abcd');
    expect(text).not.toContain(SMTP_APP_PASSWORD.replace(/\s+/g, ''));
  });

  it('warns when SMTP is not configured', () => {
    const logged = bootEmailService(false);

    expect(logged.warn).toHaveBeenCalledWith(expect.stringMatching(/^SMTP not configured/));
    expect(logged.info).not.toHaveBeenCalledWith('SMTP configured');
  });
});
