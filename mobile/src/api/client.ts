import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type { ApiEnvelope, ApiErrorBody, AuthResult, Pagination } from './types';
import { clearTokens, getAccessToken, getRefreshToken, saveTokens } from './tokenStorage';
import { setConnectionState } from './connection';

/**
 * Resolves the API base URL.
 *
 * An Android emulator reaches the host machine at 10.0.2.2, not localhost, so
 * the default differs per platform. Override with `extra.apiUrl` in app.json
 * (or EXPO_PUBLIC_API_URL) to point at a deployed backend.
 */
function resolveBaseUrl(): string {
  // Only a non-empty string counts as configured.
  //
  // `"apiUrl": null` in app.json does NOT arrive here as null — Expo serialises
  // it into the manifest and it reads back as `{}`. An empty object is neither
  // nullish (so `??` will not fall through to the env var) nor falsy (so a
  // plain truthiness check accepts it), which previously made API_BASE_URL the
  // object itself. Axios then had a garbage baseURL and every request failed
  // with a network error, on emulator and device alike.
  const candidates: unknown[] = [
    (Constants.expoConfig?.extra as { apiUrl?: unknown } | undefined)?.apiUrl,
    process.env.EXPO_PUBLIC_API_URL,
  ];

  const configured = candidates.find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  if (configured) return configured.trim();

  const host = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
  return `http://${host}:4000/api/v1`;
}

export const API_BASE_URL = resolveBaseUrl();

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: ApiErrorBody['details'];

  constructor(status: number, body?: ApiErrorBody) {
    super(body?.message ?? 'Something went wrong. Please try again.');
    this.status = status;
    this.code = body?.code ?? 'UNKNOWN';
    this.details = body?.details;
  }

  /** True when the server said "you are authenticated but not allowed" (PRD 8.8). */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isWholesalePending(): boolean {
    return this.code === 'WHOLESALE_NOT_APPROVED';
  }
}

/** The store registers this so a dead session can drive the UI back to login. */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(handler: () => void): void {
  onSessionExpired = handler;
}

/**
 * Cold starts. The API runs on Render, which can take ~30 s to wake after
 * being idle — longer than an ordinary request timeout. So:
 *  - until one request has succeeded, requests get a long timeout;
 *  - idempotent requests (GET/HEAD) are retried with backoff on a network
 *    error, a timeout, or a 502/503/504 from the waking host;
 *  - the connection state drives a "Connecting to store…" banner instead of
 *    an error while that happens.
 * Writes (POST/PATCH/…) are never retried automatically: repeating one could
 * place an order twice.
 */
export const retryPolicy = {
  /** Backoff before each retry of an idempotent request. */
  delaysMs: [1_000, 3_000, 6_000],
  /** Until the first success after launch — covers a sleeping backend waking up. */
  firstRequestTimeoutMs: 60_000,
  defaultTimeoutMs: 20_000,
  /** A request slower than this shows "Connecting to store…". */
  slowAfterMs: 2_500,
};

let warmedUp = false;
let pendingRequests = 0;
let slowTimer: ReturnType<typeof setTimeout> | null = null;

function requestStarted(): void {
  pendingRequests += 1;
  if (!slowTimer) {
    slowTimer = setTimeout(() => {
      if (pendingRequests > 0) setConnectionState('connecting');
    }, retryPolicy.slowAfterMs);
  }
}

function requestSettled(reachedServer: boolean): void {
  pendingRequests = Math.max(0, pendingRequests - 1);
  if (reachedServer) {
    warmedUp = true;
    setConnectionState('online');
  }
  if (pendingRequests === 0 && slowTimer) {
    clearTimeout(slowTimer);
    slowTimer = null;
  }
}

function currentTimeout(): number {
  return warmedUp ? retryPolicy.defaultTimeoutMs : retryPolicy.firstRequestTimeoutMs;
}

const IDEMPOTENT = new Set(['get', 'head']);

/**
 * A 502/503/504 WITHOUT our { success, error } envelope is Render's proxy
 * answering for a host that is still waking. One WITH the envelope is the API
 * itself (e.g. "Google sign-in is not configured") and is a real answer.
 */
function isWakingHost(error: AxiosError<ApiEnvelope<never>>): boolean {
  const status = error.response?.status ?? 0;
  return [502, 503, 504].includes(status) && !error.response?.data?.error?.code;
}

function isRetriable(error: AxiosError<ApiEnvelope<never>>): boolean {
  const method = (error.config?.method ?? 'get').toLowerCase();
  if (!IDEMPOTENT.has(method)) return false;
  // No response at all: offline, DNS, reset, or our own timeout.
  return !error.response || isWakingHost(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 401s that mean the SESSION is over. Other 401s (a wrong password on the
 * sign-in form, a Google token that did not verify) leave any session alone.
 */
const SESSION_ENDING_CODES = new Set([
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_INACTIVE',
  'REFRESH_TOKEN_INVALID',
  'REFRESH_TOKEN_REUSED',
  'SESSION_EXPIRED',
  'NO_REFRESH_TOKEN',
]);

export const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: retryPolicy.defaultTimeoutMs,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * PRD 8.10 — the access token is injected into EVERY request without
 * exception. The previous Flutter client omitted it on product requests; that
 * gap is closed here by attaching in a single interceptor rather than
 * per-call.
 */
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getAccessToken();
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  config.timeout = currentTimeout();
  requestStarted();
  return config;
});

/**
 * Refresh-on-401.
 *
 * Concurrent requests that all hit an expired token must not each fire their
 * own refresh — the first one refreshes, the rest wait on the same promise and
 * retry once it resolves.
 */
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new ApiError(401, { code: 'NO_REFRESH_TOKEN', message: 'Session expired' });

  // A bare axios call: using `api` would re-enter this interceptor on failure.
  const response = await axios.post<ApiEnvelope<AuthResult>>(
    `${API_BASE_URL}/auth/refresh`,
    { refreshToken },
    { headers: { 'Content-Type': 'application/json' }, timeout: currentTimeout() },
  );

  const result = response.data.data;
  await saveTokens(result.accessToken, result.refreshToken);
  return result.accessToken;
}

api.interceptors.response.use(
  (response) => {
    requestSettled(true);
    return response;
  },
  async (error: AxiosError<ApiEnvelope<never>>) => {
    const original = error.config as
      | (AxiosRequestConfig & { _retried?: boolean; _attempt?: number })
      | undefined;
    const status = error.response?.status;
    const body = error.response?.data?.error;
    requestSettled(Boolean(error.response) && !isWakingHost(error));

    if (original && isRetriable(error)) {
      const attempt = original._attempt ?? 0;
      if (attempt < retryPolicy.delaysMs.length) {
        original._attempt = attempt + 1;
        setConnectionState('connecting');
        await sleep(retryPolicy.delaysMs[attempt]);
        return api.request(original);
      }
    }

    // TOKEN_REVOKED is the server ending every session at once (password
    // reset, email or role change, deactivation). It goes through the same
    // single refresh: a device that already holds a newer pair carries on,
    // and one whose refresh token died with it is signed out below.
    const isExpiredToken =
      status === 401 &&
      (body?.code === 'TOKEN_EXPIRED' ||
        body?.code === 'TOKEN_REVOKED' ||
        body?.code === 'INVALID_TOKEN' ||
        body?.code === 'NO_TOKEN');

    if (isExpiredToken && original && !original._retried) {
      original._retried = true;
      try {
        refreshPromise = refreshPromise ?? refreshAccessToken().finally(() => {
          refreshPromise = null;
        });
        const token = await refreshPromise;

        original.headers = { ...original.headers, Authorization: `Bearer ${token}` };
        return api.request(original);
      } catch {
        // Refresh token also expired or revoked → log out (PRD 8.10).
        await clearTokens();
        onSessionExpired?.();
        throw new ApiError(401, { code: 'SESSION_EXPIRED', message: 'Please sign in again.' });
      }
    }

    if (status === 401 && !isExpiredToken && SESSION_ENDING_CODES.has(body?.code ?? '')) {
      await clearTokens();
      onSessionExpired?.();
    }

    if (error.response && !isWakingHost(error)) {
      throw new ApiError(error.response.status, body);
    }

    setConnectionState('offline');
    throw new ApiError(0, {
      code: 'NETWORK_ERROR',
      message: "We couldn't reach the store just now. Check your connection and try again.",
    });
  },
);

/* ── Thin helpers that unwrap the { success, data, meta } envelope ──────── */

export async function get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const response = await api.get<ApiEnvelope<T>>(url, config);
  return response.data.data;
}

export async function getPaged<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<{ data: T; pagination?: Pagination }> {
  const response = await api.get<ApiEnvelope<T>>(url, config);
  return { data: response.data.data, pagination: response.data.meta };
}

export async function post<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const response = await api.post<ApiEnvelope<T>>(url, body, config);
  return response.data.data;
}

export async function put<T>(url: string, body?: unknown): Promise<T> {
  const response = await api.put<ApiEnvelope<T>>(url, body);
  return response.data.data;
}

export async function patch<T>(url: string, body?: unknown): Promise<T> {
  const response = await api.patch<ApiEnvelope<T>>(url, body);
  return response.data.data;
}

export async function del<T>(url: string, body?: unknown): Promise<T> {
  const response = await api.delete<ApiEnvelope<T>>(url, { data: body });
  return response.data.data;
}
