import { Types } from 'mongoose';
import { api, clearTestDb, connectTestDb, disconnectTestDb, request } from './helpers/testServer';
import { Cart } from '../models/cart.model';
import { Order } from '../models/order.model';
import { Product } from '../models/product.model';
import { Review } from '../models/review.model';
import { RoleChange } from '../models/roleChange.model';
import { User } from '../models/user.model';
import { Wishlist } from '../models/wishlist.model';
import * as accountService from '../services/account.service';

/**
 * B-1 — account deletion (Google Play policy). The account is anonymised, not
 * removed: orders survive for the store's accounts, stripped of who and where.
 */

interface CodeEmail {
  to: string;
  code: string;
  purpose?: string;
}

const mockSendCode = jest.fn(async (_input: CodeEmail) => ({ delivered: true }));
jest.mock('../services/email.service', () => ({
  sendPasswordResetEmail: (input: CodeEmail) => mockSendCode({ ...input, purpose: 'reset' }),
  sendEmailVerificationCode: (input: CodeEmail) => mockSendCode(input),
  sendEmailChangedNotice: async () => ({ delivered: true }),
  sendAccountDeletionCode: (input: CodeEmail) => mockSendCode({ ...input, purpose: 'delete' }),
}));

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(async () => {
  mockSendCode.mockClear();
  await clearTestDb();
});

const PASSWORD = 'Marigold42';

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string };
}

async function register(email: string): Promise<Session> {
  const res = await request.post(api('/auth/register')).send({ email, password: PASSWORD, name: 'Priya Shopper' });
  expect(res.status).toBe(200);
  return res.body.data;
}

const deleteAccount = (token: string, body: Record<string, unknown> = { password: PASSWORD }) =>
  request.delete(api('/auth/me')).set('Authorization', `Bearer ${token}`).send(body);

const flush = () => new Promise((resolve) => setImmediate(resolve));

let orderSeq = 0;
async function orderFor(
  userId: string,
  overrides: Record<string, unknown> = {},
  productId: Types.ObjectId = new Types.ObjectId(),
) {
  orderSeq += 1;
  return Order.create({
    orderNumber: `MF-TEST-${orderSeq}`,
    userId,
    items: [{ productId, name: 'Kundan set', quantity: 2, priceAtOrder: 50000, priceTier: 'retail', lineTotal: 100000 }],
    shippingAddress: {
      fullName: 'Priya Shopper',
      phone: '+919876543210',
      line1: '12 Temple Street',
      line2: 'Near the tank',
      city: 'Madurai',
      state: 'Tamil Nadu',
      pincode: '625001',
    },
    paymentMethod: 'cod',
    paymentStatus: 'pending',
    subtotal: 100000,
    shippingCharge: 0,
    totalAmount: 100000,
    orderStatus: 'delivered',
    statusHistory: [{ status: 'placed', at: new Date() }],
    ...overrides,
  });
}

async function addAddress(token: string) {
  const res = await request
    .post(api('/auth/addresses'))
    .set('Authorization', `Bearer ${token}`)
    .send({
      fullName: 'Priya Shopper',
      phone: '+919876543210',
      line1: '12 Temple Street',
      city: 'Madurai',
      state: 'Tamil Nadu',
      pincode: '625001',
    });
  expect(res.status).toBe(201);
}

describe('DELETE /auth/me — in-app deletion', () => {
  it('refuses without the password, and with a wrong one, leaving the account untouched', async () => {
    const session = await register('shopper@example.com');

    const missing = await deleteAccount(session.accessToken, {});
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('REAUTH_REQUIRED');

    const wrong = await deleteAccount(session.accessToken, { password: 'NotMine123' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('REAUTH_FAILED');

    const user = await User.findById(session.user.id);
    expect(user?.email).toBe('shopper@example.com');
    expect(user?.deletedAt).toBeUndefined();
  });

  it('anonymises the person and removes their cart, wishlist and addresses', async () => {
    const session = await register('shopper@example.com');
    await addAddress(session.accessToken);
    await Cart.create({ userId: session.user.id, items: [] });
    await Wishlist.create({ userId: session.user.id, products: [] });

    const res = await deleteAccount(session.accessToken);
    expect(res.status).toBe(200);

    const user = await User.findById(session.user.id).select('+passwordHash');
    expect(user).not.toBeNull();
    expect(user?.deletedAt).toBeInstanceOf(Date);
    expect(user?.isActive).toBe(false);
    expect(user?.name).toBeUndefined();
    expect(user?.email).toBeUndefined();
    expect(user?.phone).toBeUndefined();
    expect(user?.googleId).toBeUndefined();
    expect(user?.passwordHash).toBeUndefined();
    expect(user?.addresses).toHaveLength(0);
    expect(await Cart.countDocuments({ userId: session.user.id })).toBe(0);
    expect(await Wishlist.countDocuments({ userId: session.user.id })).toBe(0);
  });

  it('ends every session and the account can no longer sign in', async () => {
    const session = await register('shopper@example.com');
    await deleteAccount(session.accessToken).expect(200);

    const me = await request.get(api('/auth/me')).set('Authorization', `Bearer ${session.accessToken}`);
    expect(me.status).toBe(401);

    const refresh = await request.post(api('/auth/refresh')).send({ refreshToken: session.refreshToken });
    expect(refresh.status).toBe(401);

    const login = await request.post(api('/auth/login')).send({ email: 'shopper@example.com', password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it('frees the email address for a new account', async () => {
    const session = await register('shopper@example.com');
    await deleteAccount(session.accessToken).expect(200);

    const again = await register('shopper@example.com');
    expect(again.user.id).not.toBe(session.user.id);
  });

  it('keeps past orders for the accounts, with the name, phone and street removed', async () => {
    const session = await register('shopper@example.com');
    const order = await orderFor(session.user.id);

    await deleteAccount(session.accessToken).expect(200);

    const kept = await Order.findById(order._id).lean();
    expect(kept).not.toBeNull();
    expect(kept?.totalAmount).toBe(100000);
    expect(kept?.items).toHaveLength(1);
    expect(kept?.shippingAddress).toMatchObject({
      fullName: 'Deleted customer',
      phone: 'removed',
      line1: 'removed',
      // The place of supply a tax record needs.
      city: 'Madurai',
      state: 'Tamil Nadu',
      pincode: '625001',
    });
    expect(kept?.shippingAddress.line2).toBeUndefined();
  });

  it('shows their reviews as "Customer" rather than their name', async () => {
    const session = await register('shopper@example.com');
    const product = await Product.create({
      name: 'Kundan set',
      description: 'Bridal set',
      category: new Types.ObjectId(),
      retailPrice: 50000,
      stock: 5,
      visibility: 'both',
      wholesalePrice: 40000,
    });
    await Review.create({ productId: product._id, userId: session.user.id, rating: 5, comment: 'Lovely' });

    await deleteAccount(session.accessToken).expect(200);

    const res = await request.get(api(`/products/${product._id.toString()}/reviews`));
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({ author: 'Customer', rating: 5 });
    expect(JSON.stringify(res.body)).not.toContain('Priya');
  });

  it('drops the email from the role-change trail but keeps the entry', async () => {
    const session = await register('shopper@example.com');
    const admin = new Types.ObjectId();
    await RoleChange.create({
      actorId: admin,
      actorEmail: 'owner@example.com',
      targetId: session.user.id,
      targetEmail: 'shopper@example.com',
      action: 'role',
      from: 'retail',
      to: 'staff',
    });
    // A staff account is still deletable; only admins are not.
    await deleteAccount(session.accessToken).expect(200);

    const row = await RoleChange.findOne({ targetId: session.user.id }).lean();
    expect(row).not.toBeNull();
    expect(row?.targetEmail).toBeUndefined();
    expect(row?.actorEmail).toBe('owner@example.com');
  });

  describe('refuses while the store still owes or expects something', () => {
    it.each([
      ['a delivery under way (placed)', { orderStatus: 'placed' }],
      ['a delivery under way (shipped, cash on delivery)', { orderStatus: 'shipped' }],
      ['a cancelled order whose refund is still owed', { orderStatus: 'cancelled', paymentStatus: 'paid' }],
    ])('%s', async (_label, overrides) => {
      const session = await register('shopper@example.com');
      await orderFor(session.user.id, overrides);

      const res = await deleteAccount(session.accessToken);

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe(accountService.OPEN_ORDER_MESSAGE);
      expect((await User.findById(session.user.id))?.deletedAt).toBeUndefined();
    });

    it('but allows it once the order is delivered or the refund has gone through', async () => {
      const session = await register('shopper@example.com');
      await orderFor(session.user.id, { orderStatus: 'delivered', paymentStatus: 'paid' });
      await orderFor(session.user.id, { orderStatus: 'cancelled', paymentStatus: 'refunded' });

      await deleteAccount(session.accessToken).expect(200);
    });
  });

  it('cancels an unpaid order and returns its stock', async () => {
    const session = await register('shopper@example.com');
    const product = await Product.create({
      name: 'Kundan set',
      description: 'Bridal set',
      category: new Types.ObjectId(),
      retailPrice: 50000,
      wholesalePrice: 40000,
      stock: 3,
      visibility: 'both',
    });
    const pending = await orderFor(
      session.user.id,
      { orderStatus: 'pending_payment', paymentMethod: 'razorpay' },
      product._id,
    );

    await deleteAccount(session.accessToken).expect(200);

    expect((await Order.findById(pending._id))?.orderStatus).toBe('cancelled');
    // Two were reserved by the order; both come back.
    expect((await Product.findById(product._id))?.stock).toBe(5);
  });

  it('refuses an ADMIN_EMAILS administrator', async () => {
    const session = await register('owner@example.com');
    await User.updateOne({ _id: session.user.id }, { $set: { emailVerified: true } });
    const login = await request.post(api('/auth/login')).send({ email: 'owner@example.com', password: PASSWORD });
    expect(login.body.data.user.accountType).toBe('admin');

    const res = await deleteAccount(login.body.data.accessToken);

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(accountService.ADMIN_ACCOUNT_MESSAGE);
    expect((await User.findById(session.user.id))?.deletedAt).toBeUndefined();
  });
});

/*
  The emailed-code path, for someone without the app. Exercised at the service
  level: the web page that calls it is not written yet (see release notes).
*/
describe('Deletion by emailed code', () => {
  const lastDeleteCode = (email: string) => {
    const call = [...mockSendCode.mock.calls]
      .reverse()
      .find(([input]) => input.to === email && input.purpose === 'delete');
    if (!call) throw new Error(`No deletion code was emailed to ${email}`);
    return call[0].code;
  };

  it('sends nothing, and says nothing, for an address with no account', async () => {
    await expect(accountService.requestDeletionCode('nobody@example.com')).resolves.toBeUndefined();
    await flush();
    expect(mockSendCode).not.toHaveBeenCalled();
  });

  it('deletes the account with the emailed code', async () => {
    const session = await register('shopper@example.com');

    await accountService.requestDeletionCode('  Shopper@Example.com ');
    await flush();
    await accountService.confirmDeletionByCode('shopper@example.com', lastDeleteCode('shopper@example.com'));

    expect((await User.findById(session.user.id))?.deletedAt).toBeInstanceOf(Date);
  });

  it('uses each code once', async () => {
    await register('shopper@example.com');
    await accountService.requestDeletionCode('shopper@example.com');
    await flush();
    const code = lastDeleteCode('shopper@example.com');

    await accountService.confirmDeletionByCode('shopper@example.com', code);
    await expect(accountService.confirmDeletionByCode('shopper@example.com', code)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('locks after 5 wrong codes and burns the real one', async () => {
    const session = await register('shopper@example.com');
    await accountService.requestDeletionCode('shopper@example.com');
    await flush();
    const code = lastDeleteCode('shopper@example.com');
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(accountService.confirmDeletionByCode('shopper@example.com', wrong)).rejects.toMatchObject({
        statusCode: 400,
      });
    }
    await expect(accountService.confirmDeletionByCode('shopper@example.com', code)).rejects.toMatchObject({
      statusCode: 429,
    });
    expect((await User.findById(session.user.id))?.deletedAt).toBeUndefined();
  });

  it('sends at most 3 codes an hour per address', async () => {
    await register('shopper@example.com');
    for (let sent = 0; sent < 4; sent += 1) await accountService.requestDeletionCode('shopper@example.com');
    await flush();
    expect(mockSendCode.mock.calls.filter(([input]) => input.purpose === 'delete')).toHaveLength(3);
  });

  it('applies the same refusals as the app', async () => {
    const session = await register('shopper@example.com');
    await orderFor(session.user.id, { orderStatus: 'processing' });
    await accountService.requestDeletionCode('shopper@example.com');
    await flush();

    await expect(
      accountService.confirmDeletionByCode('shopper@example.com', lastDeleteCode('shopper@example.com')),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await User.findById(session.user.id))?.deletedAt).toBeUndefined();
  });
});
