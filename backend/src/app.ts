import path from 'path';
import compression from 'compression';
import cors from 'cors';
import express, { type Application } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import morgan from 'morgan';
import { env, isProduction } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { generalLimiter } from './middleware/rateLimiter';
import { responseFormatter } from './middleware/responseFormatter';
import routes from './routes';
import publicRoutes from './routes/public.routes';
import webhookRoutes from './routes/webhook.routes';

/**
 * Assembles the middleware pipeline described in PRD 8.6, in this fixed order:
 *
 *   Nginx (SSL/HTTPS, outside this process)
 *     → Express Router
 *     → Request Validation (Zod)      ─┐ per-route, in routes/*.ts
 *     → Rate Limiter                   │
 *     → JWT Authentication             │
 *     → Role & Permission Check (RBAC) ─┘
 *     → Controller → Service → Repository → MongoDB
 *     → Response Formatter → JSON
 */
export function createApp(): Application {
  const app = express();

  // Nginx terminates TLS and forwards; trust its X-Forwarded-* so req.ip is the
  // real client and rate limiting is not keyed on the proxy (PRD 2 / 8.6).
  app.set('trust proxy', Number.isNaN(Number(env.TRUST_PROXY)) ? env.TRUST_PROXY : Number(env.TRUST_PROXY));
  app.disable('x-powered-by');

  // ── Security headers (PRD 8.11) ──
  // Helmet's defaults, except that images may also come from Cloudinary,
  // where product photos live: the public home page shows them.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'https://res.cloudinary.com'] } },
    }),
  );
  app.use(
    cors({
      // The mobile app sends no Origin header and is always served. Browser
      // origins must be on CORS_ORIGINS; an EMPTY list denies every browser
      // origin in production (it used to allow all), and allows all only in
      // development for convenience. A refused origin gets no CORS headers —
      // the browser blocks it — rather than a 500.
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        if (env.CORS_ORIGINS.length === 0 && !isProduction) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
    }),
  );
  /**
   * Render's health check (set the service's Health Check Path to /health).
   * Outside the API prefix and every limiter, so Render's probes never spend a
   * customer's rate-limit budget. 503 while MongoDB is not connected, so a
   * deploy that cannot reach the database is never put in front of traffic.
   */
  app.get('/health', (_req, res) => {
    const connected = mongoose.connection.readyState === 1;
    res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'degraded', database: connected });
  });

  app.use(compression());
  // Request logs would drown the assertions in test output.
  if (env.NODE_ENV !== 'test') app.use(morgan(isProduction ? 'combined' : 'dev'));

  /**
   * Stand-in product photography (PRD 8.3 says images belong in Cloudinary).
   *
   * Cloudinary is the real home for these: it does the resizing and format
   * negotiation, and it keeps image bytes off the API process. Until those
   * credentials exist, the demo catalogue would otherwise render as grey
   * boxes, so the files in public/ are served directly.
   *
   * Lives outside `${env.API_PREFIX}` because it is not part of the API, and
   * outside src/ because tsc only emits .ts — nothing here needs building.
   * Replace with Cloudinary URLs and this mount can go.
   */
  app.use(
    '/static',
    express.static(path.resolve(process.cwd(), 'public'), {
      maxAge: isProduction ? '7d' : 0,
      // The directory holds only product photography; never let a miss fall
      // through to the API's 404 handler as an index listing.
      index: false,
      redirect: false,
    }),
  );

  // Privacy policy and terms: public HTML, outside the API prefix (and so
  // outside its limiter and JSON envelope), linked from the app and Play.
  app.use(publicRoutes);

  // ── Webhooks: mounted before the JSON parser's normal path so the raw body
  // survives for HMAC verification (PRD 4.4). ──
  app.use(
    `${env.API_PREFIX}/webhooks`,
    express.json({
      limit: '1mb',
      verify: (req, _res, buffer) => {
        (req as express.Request).rawBody = Buffer.from(buffer);
      },
    }),
    webhookRoutes,
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use(responseFormatter);

  // ── Rate limiting across all public endpoints (PRD 8.11) ──
  app.use(env.API_PREFIX, generalLimiter);

  app.use(env.API_PREFIX, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
