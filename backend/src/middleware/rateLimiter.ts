import rateLimit, { type IncrementResponse, type Options, type Store } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { RateLimitHit } from '../models/rateLimitHit.model';

/**
 * Fixed-window counters in MongoDB (`ratelimits`), so a limit holds across a
 * restart, an idle spin-down, and more than one instance. One atomic update
 * per hit: a window that has elapsed restarts at 1.
 */
export class MongoRateLimitStore implements Store {
  prefix: string;
  localKeys = false;
  private windowMs = 60_000;

  constructor(prefix: string) {
    this.prefix = `${prefix}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const now = new Date();
    const live = { $gt: ['$resetAt', now] };
    const hit = await RateLimitHit.findOneAndUpdate(
      { _id: this.prefix + key },
      [
        {
          $set: {
            count: { $cond: [live, { $add: ['$count', 1] }, 1] },
            resetAt: { $cond: [live, '$resetAt', new Date(now.getTime() + this.windowMs)] },
          },
        },
      ],
      { upsert: true, new: true },
    ).lean();
    return { totalHits: hit?.count ?? 1, resetTime: hit?.resetAt };
  }

  async decrement(key: string): Promise<void> {
    await RateLimitHit.updateOne({ _id: this.prefix + key, resetAt: { $gt: new Date() } }, { $inc: { count: -1 } });
  }

  async resetKey(key: string): Promise<void> {
    await RateLimitHit.deleteOne({ _id: this.prefix + key });
  }
}

/**
 * PRD 8.6 / 8.11 — Rate Limiter stage.
 *
 * Applied to every public endpoint, not just OTP: ~100 req/min per IP
 * generally, with much tighter limits on the auth endpoints.
 *
 * Counters live in express-rate-limit's in-process store. Redis was removed
 * from this project, so they reset on restart and are per-instance — correct
 * for a single instance, but a second one would each keep its own counts.
 */
interface LimiterOptions {
  windowMs: number;
  limit: number;
  /** Namespaces this limiter's counters in the shared store. */
  prefix: string;
  message?: string;
  /**
   * Keep counters in MongoDB (default) or in process memory. Memory is used
   * only for the coarse general limiter, which runs on every request: a
   * database round trip per API read is not worth it for a flood guard whose
   * state may reset on a restart without harm.
   */
  store?: 'mongo' | 'memory';
  /**
   * Answers the refused request instead of the JSON envelope — for a public
   * HTML page, where a JSON 429 would be meaningless to the visitor.
   */
  handler?: (req: Request, res: Response) => void;
}

/**
 * Limiters are keyed by IP, not by user. The pipeline order in PRD 8.6 is
 * fixed — rate limiting runs *before* JWT authentication — so req.user does
 * not exist yet at this stage and cannot be part of the key.
 */
export function createRateLimiter({
  windowMs,
  limit,
  message,
  prefix,
  store = 'mongo',
  handler,
}: LimiterOptions) {
  return rateLimit({
    windowMs,
    limit,
    ...(store === 'mongo' ? { store: new MongoRateLimitStore(prefix) } : {}),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request) => `ip:${req.ip ?? 'unknown'}`,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: message ?? 'Too many requests, please try again later.',
      },
    },
    ...(handler ? { handler: (req: Request, res: Response) => handler(req, res) } : {}),
  });
}

/** ~100 req/min per IP across the API (PRD 8.11). */
export const generalLimiter = createRateLimiter({
  windowMs: 60_000,
  limit: env.RATE_LIMIT_GENERAL_PER_MIN,
  prefix: 'general',
  store: 'memory',
});

/**
 * Tighter ceiling on auth endpoints. The precise per-phone OTP quota
 * (PRD 8.7 — max 5/hour) is enforced separately in the OTP service, keyed by
 * phone number as well as IP, so an attacker cannot rotate IPs to bypass it.
 */
export const authLimiter = createRateLimiter({
  windowMs: 60_000,
  limit: env.RATE_LIMIT_AUTH_PER_MIN,
  prefix: 'auth',
  message: 'Too many authentication attempts. Please wait a minute and try again.',
});

/** Writes are cheaper to abuse than reads; keep mutations bounded too. */
export const writeLimiter = createRateLimiter({
  windowMs: 60_000,
  limit: 60,
  prefix: 'write',
});
