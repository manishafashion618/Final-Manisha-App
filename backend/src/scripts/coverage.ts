/**
 * Route coverage harness.
 *
 * Wraps the real app in a recorder that logs which Express route each request
 * actually matched, then drives every registered route. Answers one question:
 * is any route dead, unreachable, or crashing?
 *
 * Semantics are asserted by smoke.ts and audit.ts; this proves *reach*.
 *
 * Run from backend/: npm run coverage
 */
import express from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Server } from 'http';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp;
}

function mountPath(layer: Layer): string {
  if (!layer.regexp) return '';
  const match = layer.regexp.source.match(/^\^\\\/((?:[\w\-]|\\.)*)/);
  if (!match || !match[1]) return '';
  return `/${match[1].replace(/\\(.)/g, '$1')}`;
}

function collectRoutes(stack: Layer[], prefix: string, out: Set<string>): void {
  for (const layer of stack) {
    if (layer.route) {
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`;
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled) out.add(`${method.toUpperCase()} ${path.replace(/\/+/g, '/')}`);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collectRoutes(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
}

async function main(): Promise<void> {
  const mongod = await MongoMemoryServer.create();

  process.env.NODE_ENV = 'development';
  process.env.MONGODB_URI = mongod.getUri('manisha_coverage');
  // ADMIN_EMAILS grants admin only to a listed AND verified address, and is
  // re-applied at every sign-in — so the admin this run promotes must be both,
  // or the next login demotes it. Fixed here, before config/env.ts is read.
  const RUN_ADMIN_EMAIL = `run-admin.${Date.now()}@example.test`;
  process.env.ADMIN_EMAILS = RUN_ADMIN_EMAIL;
  // A script run never touches real third-party services. Blank, not deleted:
  // dotenv would refill a deleted variable from backend/.env.
  for (const name of [
    'SMTP_USER',
    'SMTP_APP_PASSWORD',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'SENTRY_DSN',
  ]) {
    process.env[name] = '';
  }
  // Razorpay is blanked above, so COD runs all-cash here (the online-shipping
  // rule is covered by the jest suite cod-online-shipping.test.ts).
  process.env.COD_SHIPPING_PAID_ONLINE = 'false';
  process.env.PORT = '4603';
  process.env.API_PREFIX = '/api/v1';
  process.env.JWT_ACCESS_SECRET = 'coverage-access-secret-value-0123456789';
  process.env.JWT_REFRESH_SECRET = 'coverage-refresh-secret-value-0123456789';
  process.env.RATE_LIMIT_GENERAL_PER_MIN = '100000';
  process.env.RATE_LIMIT_WRITE_PER_MIN = '100000';
  process.env.RATE_LIMIT_AUTH_PER_MIN = '100000';
  // Never upload to the real Cloudinary account from a test run. Blanking the
  // credentials makes /products/images answer deterministically from its own
  // "not configured" guard instead of hitting the network.
  process.env.CLOUDINARY_CLOUD_NAME = '';
  process.env.CLOUDINARY_API_KEY = '';
  process.env.CLOUDINARY_API_SECRET = '';

  const { createApp } = await import('../app');
  const { connectScriptDatabase, disconnectDatabase } = await import('../config/database');
  const { initStore } = await import('../config/store');
  const { User } = await import('../models/user.model');

  initStore();
  await connectScriptDatabase();

  const inner = createApp();

  const declared = new Set<string>();
  collectRoutes((inner as never as { _router: { stack: Layer[] } })._router.stack, '', declared);

  /**
   * Record the concrete URL, not req.route — Express restores req.route and
   * req.baseUrl as the stack unwinds, so reading them on 'finish' silently
   * misattributes requests. Concrete URLs are matched to declared patterns
   * afterwards.
   */
  const requested: Array<{ method: string; url: string; status: number }> = [];

  const app = express();
  app.use((req, res, next) => {
    res.on('finish', () => {
      requested.push({
        method: req.method,
        url: (req.originalUrl ?? req.url).split('?')[0],
        status: res.statusCode,
      });
    });
    next();
  });
  app.use(inner);

  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(4603, () => resolve(listener));
  });

  const base = 'http://127.0.0.1:4603/api/v1';

  async function call(
    method: string,
    path: string,
    options: { body?: unknown; token?: string; raw?: FormData; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.raw ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.headers ?? {}),
      },
      ...(options.raw ? { body: options.raw } : options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  }

  /**
   * Registers a throwaway email/password account and returns its session plus
   * the credentials, so a caller that changes the role can sign in again and
   * pick the change up. Phone+OTP login was removed; these scripts no longer
   * have a number to key on.
   */
  async function login(
    label: string,
    accountType: 'retail' | 'wholesale' = 'retail',
  ): Promise<{ accessToken: string; refreshToken: string; user: any; email: string; password: string }> {
    const email = `${label.replace(/[^a-z0-9]/gi, '').toLowerCase()}.${Date.now()}@example.test`;
    const password = 'SmokeTest123';
    const registered = await call('POST', '/auth/register', {
      body: { email, password, accountType },
    });
    if (!registered.body.data?.accessToken) {
      throw new Error(`Registration failed for ${email}: ${JSON.stringify(registered.body)}`);
    }
    return { ...registered.body.data, email, password };
  }

  /** Signs an existing account back in — used after a role change. */
  async function reLogin(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: any }> {
    const res = await call('POST', '/auth/login', { body: { email, password } });
    if (!res.body.data?.accessToken) {
      throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
    }
    return res.body.data;
  }

  try {
    /* ── Actors — each concern gets its own user so no call poisons another ─ */
    const adminSeed = await login('admin');
    await User.updateOne(
      { email: adminSeed.email },
      { $set: { accountType: 'admin', email: RUN_ADMIN_EMAIL, emailVerified: true } },
    );
    const admin = await reLogin(RUN_ADMIN_EMAIL, adminSeed.password);
    const adminToken = admin.accessToken;

    // Shopper: cart, wishlist, orders, addresses, profile. Never role-changed,
    // never applies for wholesale — either would strip its permissions.
    const shopper = await login('user9812000001');
    const shopperToken = shopper.accessToken;

    // Separate throwaway users for the destructive/role-changing routes.
    const applicant = await login('user9812000022');
    const roleTarget = await login('user9812000033');
    const canceller = await login('user9812000044');
    const ws = await login('user9812000055', 'wholesale');

    /* ── Health & config ───────────────────────────────────────────────── */
    await call('GET', '/health');
    await call('GET', '/config', { token: shopperToken });

    /* ── Auth ──────────────────────────────────────────────────────────── */
    await call('GET', '/auth/me', { token: shopperToken });
    await call('PATCH', '/auth/me', { token: shopperToken, body: { name: 'Coverage Shopper' } });
    await call('POST', '/auth/wholesale/apply', {
      token: applicant.accessToken,
      body: { businessName: 'Coverage Traders' },
    });

    const mkAddress = async (token: string, phone: string) => {
      const created = await call('POST', '/auth/addresses', {
        token,
        body: {
          label: 'Home',
          fullName: 'Coverage User',
          phone,
          line1: 'Ring Road',
          city: 'Surat',
          state: 'Gujarat',
          pincode: '395002',
        },
      });
      return created.body.data?.[0]?.id;
    };

    const addrId = await mkAddress(shopperToken, '9812000001');
    await call('GET', '/auth/addresses', { token: shopperToken });
    await call('PATCH', `/auth/addresses/${addrId}`, { token: shopperToken, body: { city: 'Vadodara' } });

    /* ── Catalog ───────────────────────────────────────────────────────── */
    const cat = await call('POST', '/products/categories', {
      token: adminToken,
      body: { name: 'Coverage Category' },
    });
    const catId = cat.body.data?.id;
    const spareCat = await call('POST', '/products/categories', {
      token: adminToken,
      body: { name: 'Coverage Spare Category' },
    });
    await call('GET', '/products/categories');
    await call('PATCH', `/products/categories/${catId}`, {
      token: adminToken,
      body: { name: 'Coverage Renamed' },
    });

    const mkProduct = async (name: string, stock: number) => {
      const created = await call('POST', '/products', {
        token: adminToken,
        body: {
          name,
          description: 'Coverage fixture',
          category: catId,
          retailPrice: 200000,
          wholesalePrice: 150000,
          stock,
        },
      });
      return created.body.data?.id;
    };

    const prodId = await mkProduct('Coverage Product', 50);
    const spareProdId = await mkProduct('Coverage Spare', 5);

    await call('GET', '/products');
    await call('GET', `/products/${prodId}`);
    await call('PATCH', `/products/${prodId}`, { token: adminToken, body: { stock: 60 } });

    // Cloudinary is blanked above, so this exercises the guard, not the network.
    const form = new FormData();
    form.append('images', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'a.jpg');
    await call('POST', '/products/images', { token: adminToken, raw: form });

    /* ── Reviews ───────────────────────────────────────────────────────── */
    await call('GET', `/products/${prodId}/reviews`);
    await call('POST', `/products/${prodId}/reviews`, {
      token: shopperToken,
      body: { rating: 5, comment: 'Coverage review' },
    });
    await call('DELETE', `/products/${prodId}/reviews`, { token: shopperToken });

    /* ── Cart & wishlist ───────────────────────────────────────────────── */
    await call('GET', '/cart', { token: shopperToken });
    await call('POST', '/cart/items', { token: shopperToken, body: { productId: prodId, quantity: 2 } });
    await call('PATCH', `/cart/items/${prodId}`, { token: shopperToken, body: { quantity: 3 } });
    await call('DELETE', `/cart/items/${prodId}`, { token: shopperToken });
    await call('POST', '/cart/items', { token: shopperToken, body: { productId: prodId, quantity: 1 } });
    await call('DELETE', '/cart', { token: shopperToken });

    await call('GET', '/wishlist', { token: shopperToken });
    await call('POST', `/wishlist/${prodId}/toggle`, { token: shopperToken });

    /* ── Orders ────────────────────────────────────────────────────────── */
    await call('POST', '/cart/items', { token: shopperToken, body: { productId: prodId, quantity: 1 } });
    const order = await call('POST', '/orders/checkout', {
      token: shopperToken,
      body: { addressId: addrId, paymentMethod: 'cod' },
    });
    const orderId = order.body.data?.order?.id;
    if (!orderId) throw new Error(`Checkout did not return an order: ${JSON.stringify(order.body)}`);

    await call('GET', '/orders', { token: shopperToken });
    await call('GET', `/orders/${orderId}`, { token: shopperToken });

    // Razorpay is unconfigured — a deliberate refusal, not a crash.
    await call('POST', '/orders/payment/confirm', {
      token: shopperToken,
      body: {
        orderId,
        razorpayPaymentId: 'pay_coverage_fixture',
        razorpaySignature: 'coverage-signature',
      },
    });

    /* ── Admin ─────────────────────────────────────────────────────────── */
    await call('GET', '/admin/dashboard', { token: adminToken });
    await call('GET', '/admin/orders', { token: adminToken });
    await call('GET', `/admin/orders/${orderId}`, { token: adminToken });
    await call('PATCH', `/admin/orders/${orderId}/status`, {
      token: adminToken,
      body: { status: 'processing' },
    });

    await call('GET', '/admin/wholesale', { token: adminToken });
    await call('POST', `/admin/wholesale/${ws.user.id}/review`, {
      token: adminToken,
      body: { decision: 'approved' },
    });

    await call('GET', '/admin/users', { token: adminToken });
    await call('PATCH', `/admin/users/${roleTarget.user.id}/role`, {
      token: adminToken,
      body: { accountType: 'staff' },
    });
    await call('PATCH', `/admin/users/${roleTarget.user.id}/active`, {
      token: adminToken,
      body: { isActive: false },
    });

    /* ── Cancellation (its own buyer and order) ────────────────────────── */
    const cancelAddr = await mkAddress(canceller.accessToken, '9812000044');
    await call('POST', '/cart/items', {
      token: canceller.accessToken,
      body: { productId: prodId, quantity: 1 },
    });
    const cancellable = await call('POST', '/orders/checkout', {
      token: canceller.accessToken,
      body: { addressId: cancelAddr, paymentMethod: 'cod' },
    });
    await call('POST', `/orders/${cancellable.body.data?.order?.id}/cancel`, {
      token: canceller.accessToken,
      body: { reason: 'Coverage run' },
    });

    /* ── Razorpay webhook (unsigned — reachability and clean refusal) ──── */
    await fetch('http://127.0.0.1:4603/api/v1/webhooks/razorpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'coverage' },
      body: JSON.stringify({ event: 'payment.captured' }),
    }).catch(() => undefined);

    /* ── Deletions (spare fixtures, so nothing in use is removed) ──────── */
    await call('DELETE', `/auth/addresses/${addrId}`, { token: shopperToken });
    await call('DELETE', `/products/${spareProdId}`, { token: adminToken });
    await call('DELETE', `/products/categories/${spareCat.body.data?.id}`, { token: adminToken });

    /* ── Session ───────────────────────────────────────────────────────── */
    await call('POST', '/auth/refresh', { body: { refreshToken: canceller.refreshToken } });
    await call('POST', '/auth/logout', { body: { refreshToken: shopper.refreshToken } });

    /* ── Report ────────────────────────────────────────────────────────── */
    const normalise = (path: string) =>
      path.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

    /** `/products/:id` → matches `/products/6a7e...` but not `/products/categories`. */
    const patternToRegex = (route: string) =>
      new RegExp(
        `^${normalise(route)
          .split('/')
          .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
          .join('/')}$`,
      );

    const sorted = [...declared].map(normalise).sort();
    const statuses = new Map<string, number[]>();

    for (const route of sorted) {
      const [method, path] = route.split(' ');
      const regex = patternToRegex(path);
      const matches = requested.filter(
        (r) => r.method === method && regex.test(normalise(r.url)),
      );
      // A concrete URL can match several patterns; the most specific one that
      // has no params wins, so /products/categories is not credited to
      // /products/:id.
      const owned = matches.filter((r) => {
        const competing = sorted.filter((other) => {
          const [m, p] = other.split(' ');
          return m === r.method && patternToRegex(p).test(normalise(r.url));
        });
        const literal = competing.find((c) => !c.includes(':'));
        return literal ? literal === route : true;
      });
      if (owned.length) statuses.set(route, owned.map((r) => r.status));
    }

    const missed = sorted.filter((route) => !statuses.has(route));

    /**
     * Routes whose happy path needs a third-party credential this harness
     * deliberately withholds. A 5xx here is the service's own "not configured"
     * guard answering correctly, not a crash.
     */
    const degradesWithoutCredentials: Record<string, string> = {
      'POST /api/v1/products/images': 'Cloudinary blanked for this run — guard returns 503',
    };

    console.log('\nROUTE COVERAGE\n');
    for (const route of sorted) {
      const seen = statuses.get(route);
      const expected = degradesWithoutCredentials[route];
      const bad = seen?.some((s) => s >= 500) && !expected;
      const mark = !seen ? 'MISS' : bad ? 'FAIL' : ' ok ';
      const note = expected && seen?.some((s) => s >= 500) ? `   (${expected})` : '';
      console.log(`  ${mark}  ${route}${seen ? `  → ${[...new Set(seen)].join(', ')}` : ''}${note}`);
    }

    const server5xx = sorted.filter(
      (r) => (statuses.get(r) ?? []).some((s) => s >= 500) && !degradesWithoutCredentials[r],
    );
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${sorted.length - missed.length}/${sorted.length} routes reached`);
    if (missed.length) {
      console.log('\nNOT REACHED:');
      missed.forEach((r) => console.log(`  - ${r}`));
    }
    console.log(
      server5xx.length
        ? `\nUNEXPECTED 5xx: ${server5xx.length}`
        : '\nNo unexpected 5xx — every route answered deliberately.',
    );
    server5xx.forEach((r) => console.log(`  - ${r} → ${statuses.get(r)?.join(', ')}`));
    console.log('='.repeat(60));

    if (missed.length || server5xx.length) process.exitCode = 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
    await mongod.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
