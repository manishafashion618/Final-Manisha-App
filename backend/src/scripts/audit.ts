/**
 * Full-surface audit: exercises every endpoint the mobile app calls, focusing
 * on the surface `smoke.ts` does not already cover, and asserts the RESPONSE
 * SHAPES that mobile/src/api/endpoints.ts declares.
 *
 * Run from backend/: npx tsx <path>/audit.ts
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Server } from 'http';

let failures = 0;
let checks = 0;
const failed: string[] = [];

function check(label: string, condition: boolean, detail?: unknown) {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    failed.push(label);
    console.error(`  XX  ${label}`);
    if (detail !== undefined) console.error('        got:', JSON.stringify(detail));
  }
}

function section(title: string) {
  console.log(`\n== ${title} ==`);
}

async function main(): Promise<void> {
  const mongod = await MongoMemoryServer.create();

  process.env.NODE_ENV = 'development';
  process.env.MONGODB_URI = mongod.getUri('manisha_audit');
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
  process.env.PORT = '4601';
  process.env.API_PREFIX = '/api/v1';
  process.env.JWT_ACCESS_SECRET = 'audit-test-access-secret-value-0123456789';
  process.env.JWT_REFRESH_SECRET = 'audit-test-refresh-secret-value-0123456789';
  process.env.COD_SHIPPING_CHARGE = '5000';
  process.env.PREPAID_SHIPPING_CHARGE = '0';
  process.env.RATE_LIMIT_GENERAL_PER_MIN = '100000';
  process.env.RATE_LIMIT_WRITE_PER_MIN = '100000';
  process.env.RATE_LIMIT_AUTH_PER_MIN = '100000';

  const { createApp } = await import('../app');
  const { connectScriptDatabase, disconnectDatabase } = await import('../config/database');
  const { initStore } = await import('../config/store');
  const { User } = await import('../models/user.model');
  const { Category } = await import('../models/category.model');
  const { Product } = await import('../models/product.model');

  initStore();
  await connectScriptDatabase();

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(4601, () => resolve(listener));
  });

  const base = 'http://127.0.0.1:4601/api/v1';

  interface ApiResponse<T = any> {
    status: number;
    body: { success: boolean; data?: T; error?: { code: string; message: string }; meta?: any };
  }

  async function call(
    method: string,
    path: string,
    options: { body?: unknown; token?: string } = {},
  ): Promise<ApiResponse> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body: body as ApiResponse['body'] };
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
    /* ── Set up an admin and a retail customer ────────────────────────── */
    const adminSeed = await login('admin');
    await User.updateOne(
      { email: adminSeed.email },
      { $set: { accountType: 'admin', email: RUN_ADMIN_EMAIL, emailVerified: true } },
    );
    const adminSession = await reLogin(RUN_ADMIN_EMAIL, adminSeed.password);
    const adminToken = adminSession.accessToken;

    const retail = await login('user9812300001');
    const retailToken = retail.accessToken;

    /* ── /config ──────────────────────────────────────────────────────── */
    section('Store config (CheckoutScreen)');
    const cfgGuest = await call('GET', '/config');
    check('config requires a token (guest gets 401)', cfgGuest.status === 401, cfgGuest.body);

    const cfg = await call('GET', '/config', { token: retailToken });
    check('config returns 200 for a signed-in customer', cfg.status === 200, cfg.body);
    const c = cfg.body.data ?? {};
    check('config.currency present', typeof c.currency === 'string', c);
    check('config.codShippingCharge is a number', typeof c.codShippingCharge === 'number', c);
    check('config.prepaidShippingCharge is a number', typeof c.prepaidShippingCharge === 'number', c);
    check('config.razorpayEnabled is a boolean', typeof c.razorpayEnabled === 'boolean', c);
    check('config.razorpayKeyId key exists (null when unconfigured)', 'razorpayKeyId' in c, c);

    /* ── Categories CRUD (AdminCategoriesScreen) ──────────────────────── */
    section('Categories CRUD (AdminCategoriesScreen)');
    const createCat = await call('POST', '/products/categories', {
      token: adminToken,
      body: { name: 'Audit Necklaces', description: 'audit', sortOrder: 1 },
    });
    check('admin can create a category', createCat.status === 201, createCat.body);
    const catId = createCat.body.data?.id ?? createCat.body.data?._id;
    check('created category returns an id', Boolean(catId), createCat.body.data);

    const listCats = await call('GET', '/products/categories', { token: adminToken });
    check('category list returns an array', Array.isArray(listCats.body.data), listCats.body.data);

    const updateCat = await call('PATCH', `/products/categories/${catId}`, {
      token: adminToken,
      body: { name: 'Audit Necklaces Renamed' },
    });
    check('admin can rename a category', updateCat.status === 200, updateCat.body);
    check(
      'rename is reflected in the response',
      updateCat.body.data?.name === 'Audit Necklaces Renamed',
      updateCat.body.data,
    );

    const catRetail = await call('POST', '/products/categories', {
      token: retailToken,
      body: { name: 'Nope' },
    });
    check('a retail customer cannot create a category', catRetail.status === 403, catRetail.body);

    /* ── Products (CatalogScreen filters / ProductDetail) ──────────────── */
    section('Catalog browse, filter, paginate');
    const mk = async (name: string, retailPrice: number, stock: number, tags: string[]) =>
      call('POST', '/products', {
        token: adminToken,
        body: {
          name,
          description: 'Audit fixture product',
          category: catId,
          retailPrice,
          wholesalePrice: Math.round(retailPrice * 0.8),
          stock,
          tags,
        },
      });

    const p1 = await mk('Audit Kundan Set', 500000, 10, ['kundan', 'bridal']);
    const p2 = await mk('Audit Jhumka', 150000, 5, ['jhumka']);
    const p3 = await mk('Audit Bangle', 250000, 0, ['bangle']);
    check('admin can create products', p1.status === 201 && p2.status === 201, {
      p1: p1.status,
      p2: p2.status,
    });
    const p1Id = p1.body.data?.id ?? p1.body.data?._id;

    const detail = await call('GET', `/products/${p1Id}`);
    check('guest can read a product detail', detail.status === 200, detail.body);
    check(
      'wholesalePrice is stripped for a guest viewer',
      detail.body.data?.wholesalePrice === undefined,
      detail.body.data,
    );

    const search = await call('GET', '/products?search=Jhumka');
    check('search returns a filtered list', search.status === 200, search.body);
    check(
      'search matches the expected product',
      Array.isArray(search.body.data) && search.body.data.some((p: any) => /Jhumka/.test(p.name)),
      search.body.data,
    );

    const paged = await call('GET', '/products?page=1&limit=2');
    check('pagination meta is returned', paged.body.meta?.limit === 2, paged.body.meta);
    check('pagination meta has totalPages', typeof paged.body.meta?.totalPages === 'number', paged.body.meta);

    const priceFilter = await call('GET', '/products?minPrice=200000&maxPrice=600000');
    check('price-range filter responds 200', priceFilter.status === 200, priceFilter.body);

    const sorted = await call('GET', '/products?sort=price_asc');
    check('sort=price_asc responds 200', sorted.status === 200, sorted.body);

    /* ── Wishlist (WishlistScreen) ─────────────────────────────────────── */
    section('Wishlist toggle + list');
    const wlEmpty = await call('GET', '/wishlist', { token: retailToken });
    check('wishlist starts as an array', Array.isArray(wlEmpty.body.data), wlEmpty.body.data);

    const wlOn = await call('POST', `/wishlist/${p1Id}/toggle`, { token: retailToken });
    check('toggle on responds 200', wlOn.status === 200, wlOn.body);
    check(
      'toggle returns { wishlisted } as the client expects',
      typeof wlOn.body.data?.wishlisted === 'boolean',
      wlOn.body.data,
    );
    check('toggle on sets wishlisted=true', wlOn.body.data?.wishlisted === true, wlOn.body.data);
    check(
      'toggle returns { items } as the client expects',
      Array.isArray(wlOn.body.data?.items),
      wlOn.body.data,
    );

    const wlAfter = await call('GET', '/wishlist', { token: retailToken });
    check('wishlist now contains the product', wlAfter.body.data?.length === 1, wlAfter.body.data);

    const wlOff = await call('POST', `/wishlist/${p1Id}/toggle`, { token: retailToken });
    check('toggle off sets wishlisted=false', wlOff.body.data?.wishlisted === false, wlOff.body.data);

    /* ── Addresses (AddressesScreen / AddressFormScreen) ───────────────── */
    section('Address book CRUD');
    const addr1 = await call('POST', '/auth/addresses', {
      token: retailToken,
      body: {
        label: 'Home',
        fullName: 'Audit User',
        phone: '9812300001',
        line1: '402 Anand Residency',
        city: 'Surat',
        state: 'Gujarat',
        pincode: '395002',
      },
    });
    check('address can be added', addr1.status === 201, addr1.body);
    check('add returns the full address array', Array.isArray(addr1.body.data), addr1.body.data);
    check('first address is defaulted', addr1.body.data?.[0]?.isDefault === true, addr1.body.data);
    const addrId = addr1.body.data?.[0]?.id;

    const addr2 = await call('POST', '/auth/addresses', {
      token: retailToken,
      body: {
        label: 'Shop',
        fullName: 'Audit User',
        phone: '9812300001',
        line1: 'Ring Road',
        city: 'Surat',
        state: 'Gujarat',
        pincode: '395003',
        isDefault: true,
      },
    });
    check('a second address can be added', addr2.status === 201, addr2.body);
    const defaults = (addr2.body.data ?? []).filter((a: any) => a.isDefault);
    check('exactly one address stays default', defaults.length === 1, addr2.body.data);

    const addrUpd = await call('PATCH', `/auth/addresses/${addrId}`, {
      token: retailToken,
      body: { city: 'Vadodara' },
    });
    check('address can be updated', addrUpd.status === 200, addrUpd.body);
    check(
      'update is reflected',
      (addrUpd.body.data ?? []).some((a: any) => a.city === 'Vadodara'),
      addrUpd.body.data,
    );

    const addrDel = await call('DELETE', `/auth/addresses/${addrId}`, { token: retailToken });
    check('address can be deleted', addrDel.status === 200, addrDel.body);
    check('list shrank after delete', (addrDel.body.data ?? []).length === 1, addrDel.body.data);

    /* ── Profile (ProfileScreen) ───────────────────────────────────────── */
    section('Profile update');
    const prof = await call('PATCH', '/auth/me', {
      token: retailToken,
      body: { name: 'Audit Customer', email: 'audit@example.com' },
    });
    check('profile can be updated', prof.status === 200, prof.body);
    check('name persisted', prof.body.data?.name === 'Audit Customer', prof.body.data);
    // Email is a verified credential now: PATCH /auth/me ignores it (it
    // changes only through /auth/email/request-code → confirm).
    check('email is NOT changed by a profile update', prof.body.data?.email === retail.email, prof.body.data);

    const emailOnly = await call('PATCH', '/auth/me', {
      token: retailToken,
      body: { email: 'not-an-email' },
    });
    check(
      'an email-only profile update changes nothing',
      emailOnly.status === 200 && emailOnly.body.data?.email === retail.email,
      emailOnly.body,
    );

    /* ── Admin: users (AdminUsersScreen) ───────────────────────────────── */
    section('Admin user management');
    const users = await call('GET', '/admin/users', { token: adminToken });
    check('admin can list users', users.status === 200, users.body);
    check('user list is an array', Array.isArray(users.body.data), users.body.data);
    check('user list is paginated', typeof users.body.meta?.total === 'number', users.body.meta);

    // Accounts are email-based now (no phone at signup); the admin search
    // covers name, phone and business name, so search by the name set above.
    const userSearch = await call('GET', '/admin/users?search=Audit%20Customer', { token: adminToken });
    check('admin can search users', userSearch.status === 200, userSearch.body);
    check(
      'search finds the retail customer',
      (userSearch.body.data ?? []).some((u: any) => u.email === retail.email),
      userSearch.body.data,
    );

    const roleTarget = retail.user.id;
    const setStaff = await call('PATCH', `/admin/users/${roleTarget}/role`, {
      token: adminToken,
      body: { accountType: 'staff' },
    });
    check('admin can promote a user to staff', setStaff.status === 200, setStaff.body);
    check('role change is reflected', setStaff.body.data?.accountType === 'staff', setStaff.body.data);

    const setBack = await call('PATCH', `/admin/users/${roleTarget}/role`, {
      token: adminToken,
      body: { accountType: 'retail' },
    });
    check('admin can demote back to retail', setBack.body.data?.accountType === 'retail', setBack.body.data);

    const deactivate = await call('PATCH', `/admin/users/${roleTarget}/active`, {
      token: adminToken,
      body: { isActive: false },
    });
    check('admin can deactivate a user', deactivate.status === 200, deactivate.body);
    check('isActive reflected as false', deactivate.body.data?.isActive === false, deactivate.body.data);

    const deadToken = await call('GET', '/auth/me', { token: retailToken });
    check('a deactivated user is refused', deadToken.status === 401 || deadToken.status === 403, {
      status: deadToken.status,
      body: deadToken.body,
    });

    await call('PATCH', `/admin/users/${roleTarget}/active`, {
      token: adminToken,
      body: { isActive: true },
    });

    /* ── Admin: wholesale approvals (AdminWholesaleScreen) ─────────────── */
    section('Wholesale application + approval');
    const ws = await login('user9812300055', 'wholesale');
    // Registration carries accountType; the business details go through the
    // dedicated apply endpoint rather than riding along with the credentials.
    await call('POST', '/auth/wholesale/apply', {
      token: ws.accessToken,
      body: { businessName: 'Audit Traders', gstNumber: '24AAAAA0000A1Z5' },
    });
    check('wholesale signup succeeds', Boolean(ws.accessToken), ws.user);
    check('wholesale starts pending', ws.user.wholesaleStatus === 'pending', ws.user);

    const wsBlocked = await call('GET', '/products', { token: ws.accessToken });
    check('a pending wholesale account is blocked from browsing', wsBlocked.status === 403, wsBlocked.body);
    check(
      'the block carries the WHOLESALE_NOT_APPROVED code the client checks',
      wsBlocked.body.error?.code === 'WHOLESALE_NOT_APPROVED',
      wsBlocked.body.error,
    );

    const wsList = await call('GET', '/admin/wholesale?status=pending', { token: adminToken });
    check('admin can list pending applications', wsList.status === 200, wsList.body);
    check(
      'the pending applicant appears',
      (wsList.body.data ?? []).some((u: any) => u.id === ws.user.id),
      wsList.body.data,
    );

    const approve = await call('POST', `/admin/wholesale/${ws.user.id}/review`, {
      token: adminToken,
      body: { decision: 'approved' },
    });
    check('admin can approve an application', approve.status === 200, approve.body);
    check('status becomes approved', approve.body.data?.wholesaleStatus === 'approved', approve.body.data);

    // Sign the approved applicant back in (login() would register a new one).
    const wsSession = await reLogin(ws.email, ws.password);
    const wsProducts = await call('GET', '/products', { token: wsSession.accessToken });
    check('an approved wholesaler can browse', wsProducts.status === 200, wsProducts.body);
    check(
      'wholesalePrice is now visible to the wholesaler',
      (wsProducts.body.data ?? []).every((p: any) => typeof p.wholesalePrice === 'number'),
      wsProducts.body.data?.[0],
    );

    const reject = await call('POST', `/admin/wholesale/${ws.user.id}/review`, {
      token: adminToken,
      body: { decision: 'rejected', reason: 'Audit rejection path' },
    });
    check('admin can reject an application', reject.status === 200, reject.body);
    check('status becomes rejected', reject.body.data?.wholesaleStatus === 'rejected', reject.body.data);

    /* ── Admin: order detail (AdminOrderDetailScreen) ──────────────────── */
    section('Admin order views');
    const retail2 = await login('user9812300001');
    await call('POST', '/auth/addresses', {
      token: retail2.accessToken,
      body: {
        label: 'Home',
        fullName: 'Audit User',
        phone: '9812300001',
        line1: 'Ring Road',
        city: 'Surat',
        state: 'Gujarat',
        pincode: '395002',
      },
    });
    const addrList = await call('GET', '/auth/addresses', { token: retail2.accessToken });
    const useAddr = addrList.body.data?.find((a: any) => a.isDefault)?.id ?? addrList.body.data?.[0]?.id;

    await call('POST', '/cart/items', {
      token: retail2.accessToken,
      body: { productId: p1Id, quantity: 2 },
    });
    const order = await call('POST', '/orders/checkout', {
      token: retail2.accessToken,
      body: { addressId: useAddr, paymentMethod: 'cod' },
    });
    check('COD checkout succeeds', order.status === 201, order.body);
    const orderId = order.body.data?.order?.id ?? order.body.data?.id;

    const adminOrder = await call('GET', `/admin/orders/${orderId}`, { token: adminToken });
    check('admin can read any order', adminOrder.status === 200, adminOrder.body);

    const adminOrders = await call('GET', '/admin/orders', { token: adminToken });
    check('admin can list all orders', adminOrders.status === 200, adminOrders.body);
    check('order list is paginated', typeof adminOrders.body.meta?.total === 'number', adminOrders.body.meta);

    const orderSearch = await call('GET', '/admin/orders?status=placed', { token: adminToken });
    check('admin can filter orders by status', orderSearch.status === 200, orderSearch.body);

    const statusFlow = await call('PATCH', `/admin/orders/${orderId}/status`, {
      token: adminToken,
      body: { status: 'processing', note: 'Audit note' },
    });
    check('admin can advance order status', statusFlow.status === 200, statusFlow.body);

    /* ── Razorpay degradation (RazorpayCheckoutScreen) ─────────────────── */
    section('Razorpay unconfigured degradation');
    await call('POST', '/cart/items', {
      token: retail2.accessToken,
      body: { productId: p1Id, quantity: 1 },
    });
    const rzp = await call('POST', '/orders/checkout', {
      token: retail2.accessToken,
      body: { addressId: useAddr, paymentMethod: 'razorpay' },
    });
    check(
      'razorpay checkout fails cleanly (not 500) when unconfigured',
      rzp.status === 503 || rzp.status === 400 || rzp.status === 422,
      { status: rzp.status, body: rzp.body },
    );

    /* ── Cloudinary degradation (AdminProductFormScreen) ───────────────── */
    section('Image upload unconfigured degradation');
    const upload = await fetch(`${base}/products/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: (() => {
        const form = new FormData();
        form.append('images', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'a.jpg');
        return form;
      })(),
    });
    check(
      'image upload fails cleanly (not 500) when Cloudinary is unconfigured',
      upload.status === 503 || upload.status === 400,
      { status: upload.status },
    );

    /* ── Dashboard (AdminDashboardScreen) ──────────────────────────────── */
    section('Admin dashboard shape');
    const dash = await call('GET', '/admin/dashboard', { token: adminToken });
    check('dashboard responds 200', dash.status === 200, dash.body);
    const d = dash.body.data ?? {};
    // Field names asserted against mobile/src/api/types.ts DashboardSummary.
    check('dashboard.todaysOrders is a number', typeof d.todaysOrders === 'number', d);
    check('dashboard.todaysRevenue is a number', typeof d.todaysRevenue === 'number', d);
    check(
      'dashboard.pendingWholesaleApprovals is a number',
      typeof d.pendingWholesaleApprovals === 'number',
      d,
    );
    check('dashboard.totalProducts is a number', typeof d.totalProducts === 'number', d);
    check('dashboard.lowStockThreshold is a number', typeof d.lowStockThreshold === 'number', d);
    check('dashboard.lowStockProducts is an array', Array.isArray(d.lowStockProducts), d);
    check('dashboard.ordersByStatus is an object', typeof d.ordersByStatus === 'object', d);

    /* ── Staff restrictions (PRD 8.9) ──────────────────────────────────── */
    section('Staff permission boundaries');
    await login('user9812300077');
    const staffSeed = await login('staff');
    await User.updateOne({ email: staffSeed.email }, { $set: { accountType: 'staff' } });
    const staff = await reLogin(staffSeed.email, staffSeed.password);

    const staffPrice = await call('PATCH', `/products/${p1Id}`, {
      token: staff.accessToken,
      body: { retailPrice: 1 },
    });
    check('staff cannot change a price', staffPrice.status === 403, staffPrice.body);

    const staffOrders = await call('GET', '/admin/orders', { token: staff.accessToken });
    check('staff can still see orders', staffOrders.status === 200, staffOrders.body);

    const staffUsers = await call('GET', '/admin/users', { token: staff.accessToken });
    check('staff cannot manage users', staffUsers.status === 403, staffUsers.body);

    const staffWholesale = await call('GET', '/admin/wholesale', { token: staff.accessToken });
    check('staff cannot review wholesale applications', staffWholesale.status === 403, staffWholesale.body);


    /* ── Storefront visibility (retail vs trade) ───────────────────────── */
    section('Storefront visibility — retail vs wholesale');

    const mkVisible = async (name: string, visibility: string) => {
      const created = await call('POST', '/products', {
        token: adminToken,
        body: {
          name,
          description: 'Visibility fixture',
          category: catId,
          retailPrice: 300000,
          wholesalePrice: 200000,
          stock: 10,
          visibility,
        },
      });
      return created.body.data?.id;
    };

    const bothId = await mkVisible('Visibility Both', 'both');
    const retailOnlyId = await mkVisible('Visibility RetailOnly', 'retail');
    const tradeOnlyId = await mkVisible('Visibility TradeOnly', 'wholesale');
    check(
      'admin can create products for each storefront',
      Boolean(bothId && retailOnlyId && tradeOnlyId),
      { bothId, retailOnlyId, tradeOnlyId },
    );

    const createdTrade = await call('GET', `/products/${tradeOnlyId}`, { token: adminToken });
    check(
      'visibility is echoed back on the product',
      createdTrade.body.data?.visibility === 'wholesale',
      createdTrade.body.data,
    );

    const namesFor = async (token?: string) => {
      const res = await call('GET', '/products?limit=100', token ? { token } : {});
      return ((res.body.data ?? []) as Array<{ name: string }>).map((entry) => entry.name);
    };

    // A fresh retail buyer on its own account: the staff account created
    // earlier sees every storefront by design and would mask the check.
    const buyer = await login('user9812300123');
    const buyerToken = buyer.accessToken;

    // An approved trade buyer, created fresh so its status is unambiguous.
    const trade = await login('user9812300088', 'wholesale');
    await call('POST', `/admin/wholesale/${trade.user.id}/review`, {
      token: adminToken,
      body: { decision: 'approved' },
    });
    const tradeSession = await reLogin(trade.email, trade.password);

    const guestNames = await namesFor();
    check('guest sees the "both" product', guestNames.includes('Visibility Both'), guestNames);
    check('guest sees the retail-only product', guestNames.includes('Visibility RetailOnly'));
    check(
      'guest does NOT see the trade-only product',
      !guestNames.includes('Visibility TradeOnly'),
      guestNames,
    );

    const shopperNames = await namesFor(buyerToken);
    check(
      'a retail customer sees the retail-only product',
      shopperNames.includes('Visibility RetailOnly'),
    );
    check(
      'a retail customer does NOT see the trade-only product',
      !shopperNames.includes('Visibility TradeOnly'),
      shopperNames,
    );

    const tradeNames = await namesFor(tradeSession.accessToken);
    check(
      'an approved trade buyer sees the trade-only product',
      tradeNames.includes('Visibility TradeOnly'),
      tradeNames,
    );
    check('an approved trade buyer sees the "both" product', tradeNames.includes('Visibility Both'));
    check(
      'an approved trade buyer does NOT see the retail-only product',
      !tradeNames.includes('Visibility RetailOnly'),
      tradeNames,
    );

    const adminNames = await namesFor(adminToken);
    check(
      'admin still sees every product regardless of storefront',
      ['Visibility Both', 'Visibility RetailOnly', 'Visibility TradeOnly'].every((entry) =>
        adminNames.includes(entry),
      ),
      adminNames,
    );

    // A shared link must not bypass the list filter.
    const tradeDirect = await call('GET', `/products/${tradeOnlyId}`, { token: buyerToken });
    check(
      'a direct link to a trade-only product 404s for a retail customer',
      tradeDirect.status === 404,
      { status: tradeDirect.status, body: tradeDirect.body },
    );
    const retailDirect = await call('GET', `/products/${retailOnlyId}`, {
      token: tradeSession.accessToken,
    });
    check(
      'a direct link to a retail-only product 404s for a trade buyer',
      retailDirect.status === 404,
      { status: retailDirect.status, body: retailDirect.body },
    );

    // Switching a product between storefronts takes effect immediately.
    // Opening a trade-only product to retail needs its retail price, set
    // explicitly — a trade-only product has none, and none is derived.
    await call('PATCH', `/products/${tradeOnlyId}`, {
      token: adminToken,
      body: { visibility: 'both', retailPrice: 300000 },
    });
    const afterSwitch = await namesFor(buyerToken);
    check(
      'switching a product to "both" reveals it to retail immediately',
      afterSwitch.includes('Visibility TradeOnly'),
      afterSwitch,
    );

    const badVisibility = await call('POST', '/products', {
      token: adminToken,
      body: {
        name: 'Bad visibility',
        description: 'fixture',
        category: catId,
        retailPrice: 1000,
        wholesalePrice: 900,
        stock: 1,
        visibility: 'nobody',
      },
    });
    check('an invalid visibility value is rejected', badVisibility.status === 422, badVisibility.body);

    /* ── Reviews & ratings (PDP) ───────────────────────────────────────── */
    section('Reviews & ratings');

    const revProdId = await mkVisible('Reviewable Product', 'both');

    const emptyReviews = await call('GET', `/products/${revProdId}/reviews`);
    check('reviews are readable by a guest', emptyReviews.status === 200, emptyReviews.body);
    check('empty product has zero reviews', emptyReviews.body.data?.summary?.count === 0, emptyReviews.body.data);
    check('empty average is 0, not null', emptyReviews.body.data?.summary?.average === 0, emptyReviews.body.data);

    const postReview = await call('POST', `/products/${revProdId}/reviews`, {
      token: buyerToken,
      body: { rating: 5, comment: 'Beautiful piece, exactly as pictured.' },
    });
    check('a signed-in customer can post a review', postReview.status === 201, postReview.body);
    check('the review echoes its rating', postReview.body.data?.rating === 5, postReview.body.data);
    check(
      'verifiedPurchase is false without a delivered order',
      postReview.body.data?.verifiedPurchase === false,
      postReview.body.data,
    );
    check('the author is named, never the raw phone', 
      typeof postReview.body.data?.author === 'string' &&
        !/\d{10}/.test(postReview.body.data.author),
      postReview.body.data);

    const guestPost = await call('POST', `/products/${revProdId}/reviews`, {
      body: { rating: 4 },
    });
    check('a guest cannot post a review', guestPost.status === 401, guestPost.body);

    const badRating = await call('POST', `/products/${revProdId}/reviews`, {
      token: buyerToken,
      body: { rating: 9 },
    });
    check('a rating outside 1-5 is rejected', badRating.status === 422, badRating.body);

    // Second review from the same customer updates rather than duplicating.
    const second = await call('POST', `/products/${revProdId}/reviews`, {
      token: buyerToken,
      body: { rating: 3, comment: 'Changed my mind.' },
    });
    check('re-reviewing succeeds', second.status === 201, second.body);

    const afterEdit = await call('GET', `/products/${revProdId}/reviews`);
    check('re-reviewing updates in place, not duplicates', afterEdit.body.data?.summary?.count === 1, afterEdit.body.data);
    check('the updated rating replaces the old one', afterEdit.body.data?.summary?.average === 3, afterEdit.body.data);

    // A different customer adds a second review; the average moves.
    const other = await login('user9812300124');
    await call('POST', `/products/${revProdId}/reviews`, {
      token: other.accessToken,
      body: { rating: 5 },
    });
    const twoReviews = await call('GET', `/products/${revProdId}/reviews`);
    check('a second customer adds a distinct review', twoReviews.body.data?.summary?.count === 2, twoReviews.body.data);
    check('the average is the mean of both', twoReviews.body.data?.summary?.average === 4, twoReviews.body.data);
    check(
      'the star breakdown counts each rating',
      Array.isArray(twoReviews.body.data?.summary?.breakdown) &&
        twoReviews.body.data.summary.breakdown[2] === 1 &&
        twoReviews.body.data.summary.breakdown[4] === 1,
      twoReviews.body.data?.summary?.breakdown,
    );
    check(
      'a viewer sees which review is theirs',
      (twoReviews.body.data?.items ?? []).every((r: any) => r.mine === false),
      twoReviews.body.data?.items,
    );
    const mineFlagged = await call('GET', `/products/${revProdId}/reviews`, { token: buyerToken });
    check(
      'the signed-in author gets mine=true on their own review',
      (mineFlagged.body.data?.items ?? []).some((r: any) => r.mine === true),
      mineFlagged.body.data?.items,
    );

    // The product itself now carries the aggregate.
    const ratedProduct = await call('GET', `/products/${revProdId}`);
    check('product detail exposes the rating average', ratedProduct.body.data?.rating?.average === 4, ratedProduct.body.data?.rating);
    check('product detail exposes the rating count', ratedProduct.body.data?.rating?.count === 2, ratedProduct.body.data?.rating);

    const ratedInList = await call('GET', '/products?limit=100');
    const listed = (ratedInList.body.data ?? []).find((p: any) => p.id === revProdId);
    check('the catalogue list carries ratings too', listed?.rating?.count === 2, listed?.rating);
    check(
      'an unreviewed product reports zero, not null',
      (ratedInList.body.data ?? []).some((p: any) => p.rating?.count === 0),
      true,
    );

    const removed = await call('DELETE', `/products/${revProdId}/reviews`, { token: buyerToken });
    check('a customer can delete their own review', removed.status === 200, removed.body);
    const afterDelete = await call('GET', `/products/${revProdId}/reviews`);
    check('deleting drops the count', afterDelete.body.data?.summary?.count === 1, afterDelete.body.data);

    const reviewMissing = await call('GET', '/products/6a7e00000000000000000000/reviews');
    check('reviews for a missing product 404', reviewMissing.status === 404, reviewMissing.body);

    /* ── Category delete last (it has products attached) ───────────────── */
    section('Category deletion guard');
    const delCat = await call('DELETE', `/products/categories/${catId}`, { token: adminToken });
    check(
      'deleting a category in use responds deliberately (not 500)',
      delCat.status < 500,
      { status: delCat.status, body: delCat.body },
    );

    /* ── Product delete ────────────────────────────────────────────────── */
    const delProd = await call('DELETE', `/products/${p2.body.data?.id}`, { token: adminToken });
    check('admin can delete a product', delProd.status === 200, delProd.body);
  } finally {
    console.log(`\n${'='.repeat(56)}`);
    console.log(`${checks - failures}/${checks} checks passed`);
    if (failed.length) {
      console.log('\nFAILED:');
      failed.forEach((f) => console.log(`  - ${f}`));
    }
    console.log('='.repeat(56));

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
    await mongod.stop();
  }

  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
