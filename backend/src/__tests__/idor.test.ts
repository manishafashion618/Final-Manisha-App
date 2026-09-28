import { Types } from 'mongoose';
import {
  api,
  clearTestDb,
  connectTestDb,
  createTestProduct,
  createTestUser,
  disconnectTestDb,
  request,
  seedCart,
  type TestUser,
} from './helpers/testServer';
import { Cart } from '../models/cart.model';
import { Order } from '../models/order.model';
import { Review } from '../models/review.model';
import { User } from '../models/user.model';
import { Wishlist } from '../models/wishlist.model';

/**
 * S-6 — one user can never read or change another user's things through an
 * `:id` route. Every case pairs an owner (A) with someone else (B) who knows
 * the id, and checks both the response and that A's data did not move.
 */

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

let seq = 0;
function orderFor(user: TestUser, overrides: Record<string, unknown> = {}) {
  seq += 1;
  return Order.create({
    orderNumber: `MF-IDOR-${seq}`,
    userId: user.id,
    items: [
      {
        productId: new Types.ObjectId(),
        name: 'Kundan set',
        quantity: 1,
        priceAtOrder: 50000,
        priceTier: 'retail',
        lineTotal: 50000,
      },
    ],
    shippingAddress: {
      fullName: 'Owner',
      phone: '+919876500000',
      line1: '1 Owner Street',
      city: 'Madurai',
      state: 'Tamil Nadu',
      pincode: '625001',
    },
    paymentMethod: 'razorpay',
    paymentStatus: 'pending',
    subtotal: 50000,
    shippingCharge: 0,
    totalAmount: 50000,
    orderStatus: 'placed',
    statusHistory: [{ status: 'placed', at: new Date() }],
    payment: { razorpayOrderId: `order_idor_${seq}` },
    ...overrides,
  });
}

let owner: TestUser;
let other: TestUser;

beforeEach(async () => {
  owner = await createTestUser({ address: { state: 'Tamil Nadu' } });
  other = await createTestUser({ address: { state: 'Kerala' } });
});

describe("orders — another customer's order id", () => {
  it('cannot be read', async () => {
    const order = await orderFor(owner);
    const res = await request.get(api(`/orders/${order._id.toString()}`)).set('Authorization', other.auth);
    expect(res.status).toBe(404);
  });

  it('cannot be cancelled', async () => {
    const order = await orderFor(owner, { paymentMethod: 'cod' });
    const res = await request
      .post(api(`/orders/${order._id.toString()}/cancel`))
      .set('Authorization', other.auth)
      .send({ reason: 'not mine' });
    expect(res.status).toBe(404);
    expect((await Order.findById(order._id))?.orderStatus).toBe('placed');
  });

  it('does not hand out its payment', async () => {
    const order = await orderFor(owner, { orderStatus: 'pending_payment' });
    const res = await request
      .get(api(`/orders/${order._id.toString()}/payment`))
      .set('Authorization', other.auth);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('order_idor_');
  });

  it('is left out of their order list', async () => {
    await orderFor(owner);
    const res = await request.get(api('/orders')).set('Authorization', other.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe("addresses — another customer's address id", () => {
  it('cannot be edited', async () => {
    const res = await request
      .patch(api(`/auth/addresses/${owner.addressId}`))
      .set('Authorization', other.auth)
      .send({ line1: 'Hijacked Road' });
    expect([403, 404]).toContain(res.status);
    const stored = await User.findById(owner.id);
    expect(stored?.addresses[0].line1).toBe('12 Test Street');
  });

  it('cannot be deleted', async () => {
    const res = await request
      .delete(api(`/auth/addresses/${owner.addressId}`))
      .set('Authorization', other.auth);
    expect([403, 404]).toContain(res.status);
    expect((await User.findById(owner.id))?.addresses).toHaveLength(1);
  });
});

describe('reviews — deleting on a product only ever touches your own', () => {
  it("leaves another customer's review in place", async () => {
    const product = await createTestProduct();
    await Review.create({ productId: product.id, userId: owner.id, rating: 5, comment: 'Mine' });

    const res = await request
      .delete(api(`/products/${product.id}/reviews`))
      .set('Authorization', other.auth);

    expect(res.status).not.toBe(500);
    expect(await Review.countDocuments({ productId: product.id, userId: owner.id })).toBe(1);
  });
});

describe('cart and wishlist — keyed by the caller, never by the id', () => {
  it("changing or removing a product id changes only the caller's cart", async () => {
    const product = await createTestProduct();
    await seedCart(owner.id, product.id, 2);

    await request
      .patch(api(`/cart/items/${product.id}`))
      .set('Authorization', other.auth)
      .send({ quantity: 5 });
    await request.delete(api(`/cart/items/${product.id}`)).set('Authorization', other.auth);
    await request.delete(api('/cart')).set('Authorization', other.auth);

    const cart = await Cart.findOne({ userId: owner.id });
    expect(cart?.items).toHaveLength(1);
    expect(cart?.items[0].quantity).toBe(2);
  });

  it("toggling a product only touches the caller's wishlist", async () => {
    const product = await createTestProduct();
    await request
      .post(api(`/wishlist/${product.id}/toggle`))
      .set('Authorization', owner.auth)
      .expect(200);

    await request.post(api(`/wishlist/${product.id}/toggle`)).set('Authorization', other.auth).expect(200);

    const mine = await Wishlist.findOne({ userId: owner.id });
    expect(mine?.productIds.map(String)).toContain(product.id);
  });
});

describe('a customer is refused every admin :id route', () => {
  it.each([
    ['get', (id: string) => `/admin/orders/${id}`],
    ['post', (id: string) => `/admin/orders/${id}/refund`],
    ['patch', (id: string) => `/admin/orders/${id}/status`],
    ['patch', (id: string) => `/admin/users/${id}/role`],
    ['patch', (id: string) => `/admin/users/${id}/active`],
    ['post', (id: string) => `/admin/wholesale/${id}/review`],
    ['patch', (id: string) => `/products/${id}`],
    ['delete', (id: string) => `/products/${id}`],
    ['patch', (id: string) => `/products/categories/${id}`],
    ['delete', (id: string) => `/products/categories/${id}`],
  ] as const)('%s %s', async (method, path) => {
    const id = new Types.ObjectId().toString();
    const res = await request[method](api(path(id)))
      .set('Authorization', other.auth)
      .send({ accountType: 'staff', isActive: false, decision: 'approved', status: 'shipped', name: 'Valid name' });
    expect(res.status).toBe(403);
  });
});

describe('a guest is refused every signed-in :id route', () => {
  it.each([
    ['get', '/orders/ID'],
    ['post', '/orders/ID/cancel'],
    ['get', '/orders/ID/payment'],
    ['patch', '/auth/addresses/ID'],
    ['delete', '/auth/addresses/ID'],
    ['patch', '/cart/items/ID'],
    ['delete', '/cart/items/ID'],
    ['post', '/wishlist/ID/toggle'],
    ['post', '/products/ID/reviews'],
    ['delete', '/products/ID/reviews'],
    ['get', '/admin/orders/ID'],
  ] as const)('%s %s', async (method, path) => {
    // A valid body, so the request reaches authentication instead of stopping
    // at validation (which runs first on these routes).
    const res = await request[method](api(path.replace('ID', new Types.ObjectId().toString()))).send({
      rating: 5,
      quantity: 1,
      line1: '1 Road',
      reason: 'x',
    });
    expect(res.status).toBe(401);
  });
});
