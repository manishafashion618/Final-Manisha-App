import {
  api,
  clearTestDb,
  connectTestDb,
  createTestProduct,
  createTestUser,
  disconnectTestDb,
  request,
  seedCart,
} from './helpers/testServer';
import { Order } from '../models/order.model';
import { Review } from '../models/review.model';
import { User } from '../models/user.model';

/**
 * S-4 — regression tests for two defences that are sound today but invisible:
 *
 *  - NoSQL operator injection: `{ "$ne": null }` where a string belongs. Zod
 *    types every field, so an operator object is a 422 before Mongo sees it.
 *  - Mass assignment: fields a client should never set (role, verification,
 *    tokenVersion, prices, statuses, paid flags) are never written. Two layers
 *    give that today: controllers hand services named fields, never req.body
 *    wholesale; and validate() replaces the body with zod's parsed output,
 *    which drops undeclared keys. (Checked: with the second layer disabled,
 *    these still pass — the first carries them.)
 *
 * These pin the observable result, whichever layer provides it. They fail if a
 * route ever starts writing a client-supplied field it should not.
 */

// Cash on delivery without the online shipping step, so checkout needs no
// Razorpay here; that flow has its own suite.
jest.mock('../config/env', () => {
  const actual = jest.requireActual('../config/env');
  return { ...actual, env: { ...actual.env, COD_SHIPPING_PAID_ONLINE: false } };
});

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const PASSWORD = 'Marigold42';

describe('NoSQL operator injection is refused before it reaches the database', () => {
  it.each([
    ['login email + password', '/auth/login', { email: { $ne: null }, password: { $ne: null } }],
    ['login password only', '/auth/login', { email: 'someone@example.com', password: { $gt: '' } }],
    ['register', '/auth/register', { email: { $gt: '' }, password: PASSWORD }],
    ['forgot password', '/auth/forgot-password', { email: { $ne: null } }],
    ['verify reset code', '/auth/verify-reset-otp', { email: 'a@example.com', otp: { $ne: null } }],
    ['reset password', '/auth/reset-password', { token: { $ne: null }, password: PASSWORD }],
    ['refresh', '/auth/refresh', { refreshToken: { $ne: null } }],
    ['google', '/auth/google', { idToken: { $where: 'sleep(1000)' } }],
  ])('%s', async (_label, path, body) => {
    const res = await request.post(api(path)).send(body);
    expect(res.status).toBe(422);
  });

  it('in the query string of the catalogue', async () => {
    for (const query of ['search[$ne]=x', 'category[$gt]=', 'minPrice[$where]=1', 'sort[$ne]=x']) {
      const res = await request.get(api(`/products?${query}`));
      expect([400, 422]).toContain(res.status);
    }
  });

  it('in an authenticated body (cart) and an admin query string', async () => {
    const customer = await createTestUser();
    const cart = await request
      .post(api('/cart/items'))
      .set('Authorization', customer.auth)
      .send({ productId: { $where: 'sleep(1000)' }, quantity: 1 });
    expect(cart.status).toBe(422);

    const admin = await createTestUser({ accountType: 'admin' });
    const users = await request.get(api('/admin/users?search[$regex]=.*')).set('Authorization', admin.auth);
    expect([400, 422]).toContain(users.status);
  });

  it('in a route parameter', async () => {
    const customer = await createTestUser();
    const res = await request.get(api('/orders/%7B%22%24ne%22%3Anull%7D')).set('Authorization', customer.auth);
    expect([400, 404, 422]).toContain(res.status);
  });
});

describe('Mass assignment: fields a client must never set are dropped', () => {
  it('register cannot ask for admin', async () => {
    const res = await request
      .post(api('/auth/register'))
      .send({ email: 'sneaky@example.com', password: PASSWORD, accountType: 'admin' });
    expect(res.status).toBe(422);
    expect(await User.countDocuments({ email: 'sneaky@example.com' })).toBe(0);
  });

  it('register cannot pre-verify, pre-approve, or set its own tokenVersion', async () => {
    const res = await request.post(api('/auth/register')).send({
      email: 'sneaky@example.com',
      password: PASSWORD,
      accountType: 'wholesale',
      wholesaleStatus: 'approved',
      emailVerified: true,
      tokenVersion: 99,
      isActive: false,
      googleId: 'google-sub-victim',
      role: 'admin',
    });
    expect(res.status).toBe(200);

    const user = await User.findOne({ email: 'sneaky@example.com' });
    expect(user?.wholesaleStatus).toBe('pending');
    expect(user?.emailVerified).toBe(false);
    expect(user?.tokenVersion).toBe(0);
    expect(user?.isActive).toBe(true);
    expect(user?.googleId).toBeUndefined();
    expect(user?.get('role')).toBeUndefined();
  });

  it('PATCH /auth/me changes the name and nothing else', async () => {
    const customer = await createTestUser();
    const res = await request.patch(api('/auth/me')).set('Authorization', customer.auth).send({
      name: 'New Name',
      accountType: 'admin',
      wholesaleStatus: 'approved',
      emailVerified: true,
      tokenVersion: 42,
      isActive: false,
      email: 'owner@example.com',
    });
    expect(res.status).toBe(200);

    const user = await User.findById(customer.id);
    expect(user?.name).toBe('New Name');
    expect(user?.accountType).toBe('retail');
    expect(user?.wholesaleStatus).toBe('none');
    expect(user?.emailVerified).toBe(false);
    expect(user?.tokenVersion).toBe(0);
    expect(user?.isActive).toBe(true);
    expect(user?.email).toBe(customer.document.email);
  });

  it('checkout ignores client prices, totals, statuses and paid flags', async () => {
    const customer = await createTestUser({ address: { state: 'Kerala' } });
    const product = await createTestProduct({ retailPrice: 150000, stock: 5 });
    await seedCart(customer.id, product.id, 2);

    const res = await request.post(api('/orders/checkout')).set('Authorization', customer.auth).send({
      addressId: customer.addressId,
      paymentMethod: 'cod',
      paymentStatus: 'paid',
      orderStatus: 'delivered',
      subtotal: 1,
      shippingCharge: 0,
      totalAmount: 1,
      amountPaidOnline: 999999,
      items: [{ productId: product.id, quantity: 2, priceAtOrder: 1 }],
      userId: '000000000000000000000000',
    });
    expect(res.status).toBe(201);

    const order = await Order.findById(res.body.data.order.id);
    expect(order?.paymentStatus).toBe('pending');
    expect(order?.orderStatus).toBe('placed');
    expect(order?.subtotal).toBe(300000);
    expect(order?.items[0].priceAtOrder).toBe(150000);
    expect(order?.totalAmount).toBe(300000 + (order?.shippingCharge ?? 0));
    expect(String(order?.userId)).toBe(customer.id);
  });

  it('a review cannot claim a verified purchase or another author', async () => {
    const customer = await createTestUser();
    const victim = await createTestUser();
    const product = await createTestProduct();

    const res = await request
      .post(api(`/products/${product.id}/reviews`))
      .set('Authorization', customer.auth)
      .send({ rating: 5, comment: 'Great', verifiedPurchase: true, userId: victim.id });
    expect(res.status).toBeLessThan(300);

    const review = await Review.findOne({ productId: product.id });
    expect(review?.verifiedPurchase).toBe(false);
    expect(String(review?.userId)).toBe(customer.id);
  });

  it('adding to the cart cannot set a price', async () => {
    const customer = await createTestUser();
    const product = await createTestProduct({ retailPrice: 150000 });

    const res = await request
      .post(api('/cart/items'))
      .set('Authorization', customer.auth)
      .send({ productId: product.id, quantity: 1, price: 1, unitPrice: 1, lineTotal: 1 });
    expect(res.status).toBeLessThan(300);
    expect(res.body.data.subtotal).toBe(150000);
  });

  it("an admin's role change cannot also verify the account or reset its sessions", async () => {
    const admin = await createTestUser({ accountType: 'admin' });
    const customer = await createTestUser();
    const before = (await User.findById(customer.id))?.tokenVersion ?? 0;

    const res = await request
      .patch(api(`/admin/users/${customer.id}/role`))
      .set('Authorization', admin.auth)
      .send({ accountType: 'staff', emailVerified: true, tokenVersion: 0, wholesaleStatus: 'approved' });
    expect(res.status).toBe(200);

    const user = await User.findById(customer.id);
    expect(user?.accountType).toBe('staff');
    expect(user?.emailVerified).toBe(false);
    expect(user?.wholesaleStatus).toBe('none');
    // Moved on by the server (the role change ends sessions), never set by the client.
    expect(user?.tokenVersion).toBe(before + 1);
  });
});
