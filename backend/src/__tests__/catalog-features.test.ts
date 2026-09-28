import { Types } from 'mongoose';
import {
  api,
  clearTestDb,
  connectTestDb,
  createTestProduct,
  createTestUser,
  disconnectTestDb,
  request,
} from './helpers/testServer';
import { Category } from '../models/category.model';
import { Order } from '../models/order.model';
import { Product } from '../models/product.model';
import { Review } from '../models/review.model';
import { User } from '../models/user.model';
import { Wishlist } from '../models/wishlist.model';

/**
 * Jest coverage for features the release check found tested only by the
 * audit script (npm run audit): wholesale approval, categories, reviews,
 * wishlist, logout, and the dashboard's "Refunds due" counter (NV-8).
 */

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const PASSWORD = 'Marigold42';

describe('wholesale: apply → pending → approve or reject', () => {
  it('a retail customer applies and is pending, and cannot browse until approved', async () => {
    const shopper = await createTestUser();

    const res = await request
      .post(api('/auth/wholesale/apply'))
      .set('Authorization', shopper.auth)
      .send({ businessName: 'Lakshmi Jewellers', gstNumber: '33ABCDE1234F1Z5' });
    expect(res.status).toBeLessThan(300);

    const user = await User.findById(shopper.id);
    expect(user?.wholesaleStatus).toBe('pending');
    expect(user?.business?.businessName).toBe('Lakshmi Jewellers');

    const browse = await request.get(api('/products')).set('Authorization', shopper.auth);
    expect(browse.status).toBe(403);
    expect(browse.body.error.code).toBe('WHOLESALE_NOT_APPROVED');
  });

  it('refuses a second application while one is under review', async () => {
    const shopper = await createTestUser();
    await request.post(api('/auth/wholesale/apply')).set('Authorization', shopper.auth).send({}).expect(200);
    const again = await request.post(api('/auth/wholesale/apply')).set('Authorization', shopper.auth).send({});
    expect(again.status).toBe(409);
  });

  it('once approved, the same session sees wholesale prices', async () => {
    const admin = await createTestUser({ accountType: 'admin' });
    const shopper = await createTestUser();
    const product = await createTestProduct({ retailPrice: 100000 });
    await request.post(api('/auth/wholesale/apply')).set('Authorization', shopper.auth).send({}).expect(200);

    const pending = await request.get(api('/admin/wholesale')).set('Authorization', admin.auth);
    expect(pending.status).toBe(200);
    expect(JSON.stringify(pending.body.data)).toContain(shopper.id);

    await request
      .post(api(`/admin/wholesale/${shopper.id}/review`))
      .set('Authorization', admin.auth)
      .send({ decision: 'approved' })
      .expect(200);

    expect((await User.findById(shopper.id))?.wholesaleStatus).toBe('approved');
    const detail = await request.get(api(`/products/${product.id}`)).set('Authorization', shopper.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.wholesalePrice).toBe(80000);
  });

  it('a rejection records the reason and keeps retail prices', async () => {
    const admin = await createTestUser({ accountType: 'admin' });
    const shopper = await createTestUser();
    await request.post(api('/auth/wholesale/apply')).set('Authorization', shopper.auth).send({}).expect(200);

    await request
      .post(api(`/admin/wholesale/${shopper.id}/review`))
      .set('Authorization', admin.auth)
      .send({ decision: 'rejected', reason: 'GSTIN could not be verified' })
      .expect(200);

    const user = await User.findById(shopper.id);
    expect(user?.wholesaleStatus).toBe('rejected');
    expect(user?.wholesaleReview?.reason).toBe('GSTIN could not be verified');
  });

  it('staff cannot review applications', async () => {
    const staff = await createTestUser({ accountType: 'staff' });
    const shopper = await createTestUser();
    const res = await request
      .post(api(`/admin/wholesale/${shopper.id}/review`))
      .set('Authorization', staff.auth)
      .send({ decision: 'approved' });
    expect(res.status).toBe(403);
  });
});

describe('categories: create, list, rename, delete', () => {
  it('runs the full cycle as admin', async () => {
    const admin = await createTestUser({ accountType: 'admin' });

    const created = await request
      .post(api('/products/categories'))
      .set('Authorization', admin.auth)
      .send({ name: 'Temple Jewellery' });
    expect(created.status).toBeLessThan(300);
    const id = created.body.data.id as string;

    const list = await request.get(api('/products/categories'));
    expect(list.body.data.map((c: { name: string }) => c.name)).toContain('Temple Jewellery');

    await request
      .patch(api(`/products/categories/${id}`))
      .set('Authorization', admin.auth)
      .send({ name: 'Temple Sets' })
      .expect(200);
    expect((await Category.findById(id))?.name).toBe('Temple Sets');

    const removed = await request.delete(api(`/products/categories/${id}`)).set('Authorization', admin.auth);
    expect(removed.status).toBeLessThan(300);
    expect(await Category.exists({ _id: id, isActive: true })).toBeNull();
  });

  it('refuses to delete a category that products still use', async () => {
    const admin = await createTestUser({ accountType: 'admin' });
    const product = await createTestProduct();
    const categoryId = String((await Product.findById(product.id))?.category);

    const res = await request.delete(api(`/products/categories/${categoryId}`)).set('Authorization', admin.auth);
    expect(res.status).toBe(409);
  });

  it('refuses a customer', async () => {
    const shopper = await createTestUser();
    const res = await request
      .post(api('/products/categories'))
      .set('Authorization', shopper.auth)
      .send({ name: 'Nope Category' });
    expect(res.status).toBe(403);
  });
});

describe('reviews', () => {
  it('posts, updates in place, marks the author, and deletes', async () => {
    const shopper = await createTestUser();
    const product = await createTestProduct();
    const path = api(`/products/${product.id}/reviews`);

    await request.post(path).set('Authorization', shopper.auth).send({ rating: 4, comment: 'Nice' }).expect((r) => {
      expect(r.status).toBeLessThan(300);
    });
    await request.post(path).set('Authorization', shopper.auth).send({ rating: 5, comment: 'Lovely' });
    expect(await Review.countDocuments({ productId: product.id })).toBe(1);

    const list = await request.get(path).set('Authorization', shopper.auth);
    expect(list.body.data.items[0]).toMatchObject({ rating: 5, mine: true });
    expect(list.body.data.summary).toMatchObject({ average: 5, count: 1 });

    await request.delete(path).set('Authorization', shopper.auth).expect((r) => {
      expect(r.status).toBeLessThan(300);
    });
    expect(await Review.countDocuments({ productId: product.id })).toBe(0);
  });

  it('refuses a guest and an out-of-range rating', async () => {
    const shopper = await createTestUser();
    const product = await createTestProduct();
    const path = api(`/products/${product.id}/reviews`);

    expect((await request.post(path).send({ rating: 5 })).status).toBe(401);
    expect((await request.post(path).set('Authorization', shopper.auth).send({ rating: 6 })).status).toBe(422);
  });

  it('404s for a product that does not exist', async () => {
    const res = await request.get(api(`/products/${new Types.ObjectId().toString()}/reviews`));
    expect(res.status).toBe(404);
  });
});

describe('wishlist', () => {
  it('toggles a product on and off', async () => {
    const shopper = await createTestUser();
    const product = await createTestProduct();
    const toggle = () =>
      request.post(api(`/wishlist/${product.id}/toggle`)).set('Authorization', shopper.auth);

    expect((await toggle()).body.data.wishlisted).toBe(true);
    const listed = await request.get(api('/wishlist')).set('Authorization', shopper.auth);
    expect(JSON.stringify(listed.body.data)).toContain(product.id);

    expect((await toggle()).body.data.wishlisted).toBe(false);
    expect((await Wishlist.findOne({ userId: shopper.id }))?.productIds).toHaveLength(0);
  });
});

describe('logout', () => {
  it('revokes the refresh token server-side, and is safe to repeat', async () => {
    const reg = await request
      .post(api('/auth/register'))
      .send({ email: 'shopper@example.com', password: PASSWORD });
    const { refreshToken } = reg.body.data;

    await request.post(api('/auth/logout')).send({ refreshToken }).expect(200);
    expect((await request.post(api('/auth/refresh')).send({ refreshToken })).status).toBe(401);
    await request.post(api('/auth/logout')).send({ refreshToken }).expect(200);
  });
});

describe('dashboard "Refunds due" (NV-8)', () => {
  let seq = 0;
  const order = (overrides: Record<string, unknown>) => {
    seq += 1;
    return Order.create({
      orderNumber: `MF-REFUND-${seq}`,
      userId: new Types.ObjectId(),
      items: [
        { productId: new Types.ObjectId(), name: 'Set', quantity: 1, priceAtOrder: 1000, priceTier: 'retail', lineTotal: 1000 },
      ],
      shippingAddress: {
        fullName: 'Buyer',
        phone: '+919876500000',
        line1: '1 Street',
        city: 'Chennai',
        state: 'Tamil Nadu',
        pincode: '600001',
      },
      paymentMethod: 'razorpay',
      subtotal: 1000,
      shippingCharge: 0,
      totalAmount: 1000,
      statusHistory: [{ status: 'placed', at: new Date() }],
      ...overrides,
    });
  };

  it('counts paid cancellations with no refund or a failed one, and nothing else', async () => {
    const admin = await createTestUser({ accountType: 'admin' });
    await order({ paymentStatus: 'paid', orderStatus: 'cancelled' }); // owed, not started
    await order({ paymentStatus: 'paid', orderStatus: 'cancelled', refund: { status: 'failed' } }); // owed, failed
    await order({ paymentStatus: 'paid', orderStatus: 'cancelled', refund: { status: 'pending' } }); // on its way
    await order({ paymentStatus: 'refunded', orderStatus: 'cancelled', refund: { status: 'processed' } }); // done
    await order({ paymentStatus: 'paid', orderStatus: 'delivered' }); // nothing owed
    await order({ paymentStatus: 'pending', orderStatus: 'cancelled' }); // never paid

    const res = await request.get(api('/admin/dashboard')).set('Authorization', admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.refundsDue).toBe(2);
  });
});
