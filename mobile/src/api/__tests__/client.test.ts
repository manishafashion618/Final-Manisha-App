import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// Imported after the mock above so tokenStorage.ts picks up the mocked
// expo-secure-store rather than the real native module.
import { api, API_BASE_URL, retryPolicy, setSessionExpiredHandler } from '../client';
import { getConnectionState, subscribeConnection } from '../connection';
import { saveTokens, getAccessToken, getRefreshToken } from '../tokenStorage';

/**
 * Two MockAdapters: `api` is the instance client.ts attaches its interceptors
 * to; the token-refresh call inside client.ts deliberately uses the bare
 * `axios.post(...)` (not `api`) so a failed refresh can't re-enter the same
 * response interceptor — that needs its own adapter on the raw axios import.
 */
describe('API client: refresh-on-401', () => {
  let apiMock: MockAdapter;
  let rawAxiosMock: MockAdapter;

  beforeEach(() => {
    apiMock = new MockAdapter(api);
    rawAxiosMock = new MockAdapter(axios);
    setSessionExpiredHandler(() => {});
  });

  afterEach(() => {
    apiMock.restore();
    rawAxiosMock.restore();
  });

  function authHeaderOf(config: { headers?: unknown }): string | undefined {
    const headers = config.headers as { Authorization?: string; get?: (key: string) => string } | undefined;
    return typeof headers?.get === 'function' ? headers.get('Authorization') : headers?.Authorization;
  }

  it('three concurrent requests that all hit an expired token trigger exactly one refresh call, and all three retries succeed', async () => {
    await saveTokens('expired-access-token', 'a-valid-refresh-token');

    apiMock.onGet('/protected').reply((config) => {
      const auth = authHeaderOf(config);
      if (auth === 'Bearer new-access-token') {
        return [200, { success: true, data: { ok: true } }];
      }
      return [401, { success: false, error: { code: 'TOKEN_EXPIRED', message: 'Access token expired' } }];
    });

    let refreshCallCount = 0;
    rawAxiosMock.onPost(`${API_BASE_URL}/auth/refresh`).reply(() => {
      refreshCallCount += 1;
      return [
        200,
        {
          success: true,
          data: {
            accessToken: 'new-access-token',
            refreshToken: 'new-refresh-token',
            user: {},
            accessTokenExpiresIn: 1800,
            refreshTokenExpiresAt: new Date().toISOString(),
          },
        },
      ];
    });

    const responses = await Promise.all([
      api.get('/protected'),
      api.get('/protected'),
      api.get('/protected'),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.data.data.ok).toBe(true);
    }
    expect(refreshCallCount).toBe(1);
    expect(getAccessToken()).toBe('new-access-token');
  });

  it('when the refresh call itself fails, the session is cleared and the handler fires exactly once', async () => {
    await saveTokens('expired-access-token', 'a-dead-refresh-token');
    const sessionExpiredHandler = jest.fn();
    setSessionExpiredHandler(sessionExpiredHandler);

    apiMock.onGet('/protected').reply(401, {
      success: false,
      error: { code: 'TOKEN_EXPIRED', message: 'Access token expired' },
    });
    rawAxiosMock.onPost(`${API_BASE_URL}/auth/refresh`).reply(401, {
      success: false,
      error: { code: 'REFRESH_TOKEN_INVALID', message: 'Session expired, please sign in again' },
    });

    await expect(api.get('/protected')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });

    expect(sessionExpiredHandler).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('TOKEN_REVOKED (password reset, role change, deactivation elsewhere) signs the app out when the refresh token died too', async () => {
    await saveTokens('revoked-access-token', 'revoked-refresh-token');
    const sessionExpiredHandler = jest.fn();
    setSessionExpiredHandler(sessionExpiredHandler);

    apiMock.onGet('/protected').reply(401, {
      success: false,
      error: { code: 'TOKEN_REVOKED', message: 'Session ended, please sign in again' },
    });
    rawAxiosMock.onPost(`${API_BASE_URL}/auth/refresh`).reply(401, {
      success: false,
      error: { code: 'REFRESH_TOKEN_INVALID', message: 'Session expired, please sign in again' },
    });

    await expect(api.get('/protected')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(sessionExpiredHandler).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
  });

  it('TOKEN_REVOKED carries on when this device already holds a newer pair', async () => {
    await saveTokens('stale-access-token', 'fresh-refresh-token');

    apiMock.onGet('/protected').reply((config) =>
      authHeaderOf(config) === 'Bearer current-access-token'
        ? [200, { success: true, data: { ok: true } }]
        : [401, { success: false, error: { code: 'TOKEN_REVOKED', message: 'Session ended' } }],
    );
    rawAxiosMock.onPost(`${API_BASE_URL}/auth/refresh`).reply(200, {
      success: true,
      data: {
        accessToken: 'current-access-token',
        refreshToken: 'next-refresh-token',
        user: {},
        accessTokenExpiresIn: 1800,
        refreshTokenExpiresAt: new Date().toISOString(),
      },
    });

    await expect(api.get('/protected')).resolves.toMatchObject({ status: 200 });
    expect(getAccessToken()).toBe('current-access-token');
  });

  it('a 403 (wrong role, not an expired token) is surfaced as-is and does not trigger a refresh or a session clear', async () => {
    await saveTokens('a-valid-access-token', 'a-valid-refresh-token');
    const sessionExpiredHandler = jest.fn();
    setSessionExpiredHandler(sessionExpiredHandler);

    apiMock.onGet('/admin-only').reply(403, {
      success: false,
      error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
    });
    rawAxiosMock.onPost(`${API_BASE_URL}/auth/refresh`).reply(() => {
      throw new Error('refresh should never be called for a 403');
    });

    await expect(api.get('/admin-only')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(sessionExpiredHandler).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('a-valid-access-token');
  });
});

/*
  F8 — the backend can take ~30 s to wake. Safe requests retry through it and
  the UI is told "connecting" instead of failing; writes are never repeated.
*/
describe('API client: cold starts and flaky networks', () => {
  let apiMock: MockAdapter;
  const originalDelays = retryPolicy.delaysMs;

  beforeEach(() => {
    apiMock = new MockAdapter(api);
    retryPolicy.delaysMs = [0, 0, 0];
    setSessionExpiredHandler(() => {});
  });

  afterEach(() => {
    apiMock.restore();
    retryPolicy.delaysMs = originalDelays;
  });

  it('retries a GET through network errors and reports connecting → online', async () => {
    const states: string[] = [];
    const unsubscribe = subscribeConnection((state) => states.push(state));
    apiMock
      .onGet('/products')
      .networkErrorOnce()
      .onGet('/products')
      .timeoutOnce()
      .onGet('/products')
      .reply(200, { success: true, data: ['ok'] });

    const response = await api.get('/products');

    expect(response.data.data).toEqual(['ok']);
    expect(apiMock.history.get).toHaveLength(3);
    expect(states).toContain('connecting');
    expect(getConnectionState()).toBe('online');
    unsubscribe();
  });

  it("retries Render's own 502/503 (no API envelope) while the host wakes", async () => {
    apiMock
      .onGet('/products')
      .replyOnce(503, '<html>Service Unavailable</html>')
      .onGet('/products')
      .reply(200, { success: true, data: [] });

    await expect(api.get('/products')).resolves.toMatchObject({ status: 200 });
    expect(apiMock.history.get).toHaveLength(2);
  });

  it("surfaces the API's own 503 (with an envelope) without retrying", async () => {
    apiMock.onGet('/config').reply(503, {
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Online payment is not available right now.' },
    });

    await expect(api.get('/config')).rejects.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(apiMock.history.get).toHaveLength(1);
  });

  it('never retries a write, so an order cannot be placed twice', async () => {
    apiMock.onPost('/orders/checkout').networkError();

    await expect(api.post('/orders/checkout', {})).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(apiMock.history.post).toHaveLength(1);
    expect(getConnectionState()).toBe('offline');
  });

  it('gives up after the last retry with a friendly message', async () => {
    apiMock.onGet('/products').networkError();

    await expect(api.get('/products')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      message: expect.stringContaining("couldn't reach the store"),
    });
    expect(apiMock.history.get).toHaveLength(1 + retryPolicy.delaysMs.length);
  });

  it('a 401 that is not about the session (wrong code or password) keeps the user signed in', async () => {
    await saveTokens('a-valid-access-token', 'a-valid-refresh-token');
    const sessionExpiredHandler = jest.fn();
    setSessionExpiredHandler(sessionExpiredHandler);
    apiMock.onPost('/auth/login').reply(401, {
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' },
    });

    await expect(api.post('/auth/login', {})).rejects.toMatchObject({ status: 401 });
    expect(sessionExpiredHandler).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('a-valid-access-token');
  });
});
