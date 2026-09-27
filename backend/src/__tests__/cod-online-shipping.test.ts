import crypto from 'crypto';
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
} from './helpers/testServer';
import { Cart } from '../models/cart.model';
import { Order } from '../models/order.model';
import { Product } from '../models/product.model';
import { expireStalePendingOrders } from '../services/order.service';

/**
 * Cash on Delivery with the shipping/COD charge paid ONLINE first: the
 * per-state charge goes through Razorpay before the order is confirmed, and
 * only the items are collected in cash. Runs against a fake Razorpay.
 */

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';

jest.mock('../config/env', () => {
  const actual = jest.requireActual('../config/env');
  return {
    ...actual,
    razorpayConfigured: true,
    env: {
      ...actual.env,
      COD_SHIPPING_PAID_ONLINE: true,
      RAZORPAY_KEY_ID: 'rzp_test_cod_suite',
      RAZORPAY_KEY_SECRET: 'test_key_secret',
      RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
    },
  };
});

const mockRazorpay = {
  orders: [] as Array<{ id: string; amount: number; receipt: string }>,
  refunds: [] as Array<{ id: string; payment_id: string; amount: number; notes: Record<string, string> }>,
  captured: new Map<string, string>(),
  available: true,
};

jest.mock('../config/razorpay', () => ({
  razorpayConfigured: true,
  getRazorpay: () =>
    mockRazorpay.available
      ? {
          orders: {
            create: async (input: { amount: number; receipt: string }) => {
              const order = { id: `order_cod_${mockRazorpay.orders.length + 1}`, amount: input.amount, receipt: input.receipt };
              mockRazorpay.orders.push(order);
              return { ...order, currency: 'INR' };
            },
            fetchPayments: async (orderId: string) => ({
              items: mockRazorpay.captured.has(orderId) ? [{ id: mockRazorpay.captured.get(orderId), status: 'captured' }] : [],
            }),
            all: async () => ({ items: [] }),
          },
          payments: {
            refund: async (paymentId: string, params: { amount: number; notes: Record<string, string> }) => {
              const refund = { id: `rfnd_cod_${mockRazorpay.refunds.length + 1}`, payment_id: paymentId, amount: params.amount, notes: params.notes };
              mockRazorpay.refunds.push(refund);
              return { ...refund, status: 'pending' };
            },
            fetchMultipleRefund: async (paymentId: string) => ({
              items: mockRazorpay.refunds.filter((refund) => refund.payment_id === paymentId).map((r) => ({ ...r, status: 'pending' })),
            }),
          },
        }
      : null,
}));

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(async () => {
  Object.assign(mockRazorpay, { orders: [], refunds: [], captured: new Map(), available: true });
  await clearTestDb();
});

const PRICE = 100_000; // ₹1,000 a piece
const TN_CHARGE = 10_000; // ₹100

const sign = (orderId: string, paymentId: string) =>
  crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

function webhook(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  return request
    .post(api('/webhooks/razorpay'))
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex'))
    .send(body);
}

async function setCharge(state: string, codCharge: number) {
  const admin = await createTestUser({ accountType: 'admin' });
  await request
    .put(api(`/admin/cod-config/${encodeURIComponent(state)}`))
    .set('Authorization', admin.auth)
    .send({ codEnabled: true, codCharge })
    .expect(200);
  return admin;
}

async function codCheckout(state = 'Tamil Nadu', quantity = 2) {
  const customer = await createTestUser({ address: { state } });
  const product = await createTestProduct({ retailPrice: PRICE, stock: 5 });
  await seedCart(customer.id, product.id, quantity);
  const res = await request
    .post(api('/orders/checkout'))
    .set('Authorization', customer.auth)
    // Client-sent money fields are not part of the schema and must change nothing.
    .send({ addressId: customer.addressId, paymentMethod: 'cod', totalAmount: 1, shippingCharge: 0, amountPaidOnline: 1 });
  return { customer, product, res };
}

async function paidCodOrder() {
  await setCharge('Tamil Nadu', TN_CHARGE);
  const placed = await codCheckout();
  const { order, payment } = placed.res.body.data;
  const paymentId = `pay_cod_${order.orderNumber}`;
  await request
    .post(api('/orders/payment/confirm'))
    .set('Authorization', placed.customer.auth)
    .send({ orderId: order.id, razorpayPaymentId: paymentId, razorpaySignature: sign(payment.razorpayOrderId, paymentId) })
    .expect(200);
  return { ...placed, order, payment, paymentId };
}

const stockOf = async (id: string) => (await Product.findById(id))?.stock;
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe('COD checkout asks for the shipping charge online, first', () => {
  it("returns a Razorpay order for exactly the state's charge and ignores client totals", async () => {
    await setCharge('Tamil Nadu', TN_CHARGE);
    const { res, product, customer } = await codCheckout();

    expect(res.status).toBe(201);
    const { order, payment } = res.body.data;
    expect(payment).toMatchObject({ amount: TN_CHARGE, razorpayOrderId: 'order_cod_1', keyId: 'rzp_test_cod_suite' });
    expect(mockRazorpay.orders).toEqual([expect.objectContaining({ amount: TN_CHARGE, receipt: order.orderNumber })]);
    expect(order).toMatchObject({
      paymentMethod: 'cod',
      orderStatus: 'pending_payment',
      awaitingPayment: true,
      paymentStatus: 'pending',
      itemsTotal: PRICE * 2,
      shippingCharge: TN_CHARGE,
      totalAmount: PRICE * 2 + TN_CHARGE,
      amountPaidOnline: TN_CHARGE,
      amountDueOnDelivery: PRICE * 2,
    });
    // Stock is held like any online order; the cart is kept until payment.
    expect(await stockOf(product.id)).toBe(3);
    expect((await Cart.findOne({ userId: customer.id }))?.items).toHaveLength(1);
  });

  it('uses the default charge for a state with no rule, via the canonical state name', async () => {
    await setCharge('Tamil Nadu', TN_CHARGE);
    // "Tamilnadu" is the same state; Kerala has no rule and pays the ₹50 default.
    const tn = await codCheckout('Tamilnadu');
    const kerala = await codCheckout('Kerala');

    expect(tn.res.body.data.payment.amount).toBe(TN_CHARGE);
    expect(kerala.res.body.data.payment.amount).toBe(5_000);
  });

  it('refuses COD with a charge when Razorpay is unavailable, before reserving stock', async () => {
    await setCharge('Tamil Nadu', TN_CHARGE);
    mockRazorpay.available = false;
    const { res, product } = await codCheckout();

    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/₹100 shipping charge paid online/);
    expect(await stockOf(product.id)).toBe(5);
    expect(await Order.countDocuments()).toBe(0);
  });
});

describe('the order is confirmed only by a captured payment', () => {
  it('stays unconfirmed until the app confirms the payment', async () => {
    await setCharge('Tamil Nadu', TN_CHARGE);
    const { res, customer } = await codCheckout();
    const { order, payment } = res.body.data;

    const mine = await request.get(api(`/orders/${order.id}`)).set('Authorization', customer.auth).expect(200);
    expect(mine.body.data.orderStatus).toBe('pending_payment');

    const confirmed = await request
      .post(api('/orders/payment/confirm'))
      .set('Authorization', customer.auth)
      .send({ orderId: order.id, razorpayPaymentId: 'pay_1', razorpaySignature: sign(payment.razorpayOrderId, 'pay_1') })
      .expect(200);

    expect(confirmed.body.data).toMatchObject({ orderStatus: 'placed', paymentStatus: 'paid', awaitingPayment: false });
    expect((await Cart.findOne({ userId: customer.id }))?.items).toHaveLength(0);
  });

  it.each([
    ['confirm first, then the webhook', ['confirm', 'webhook']],
    ['the webhook first, then confirm', ['webhook', 'confirm']],
  ])('applies once when they arrive %s', async (_label, sequence) => {
    await setCharge('Tamil Nadu', TN_CHARGE);
    const { res, customer } = await codCheckout();
    const { order, payment } = res.body.data;

    for (const step of sequence) {
      if (step === 'confirm') {
        await request
          .post(api('/orders/payment/confirm'))
          .set('Authorization', customer.auth)
          .send({ orderId: order.id, razorpayPaymentId: 'pay_x', razorpaySignature: sign(payment.razorpayOrderId, 'pay_x') })
          .expect(200);
      } else {
        await webhook({
          event: 'payment.captured',
          payload: { payment: { entity: { id: 'pay_x', order_id: payment.razorpayOrderId } } },
        }).expect(200);
      }
    }

    const saved = await Order.findById(order.id);
    expect(saved).toMatchObject({ orderStatus: 'placed', paymentStatus: 'paid' });
    expect(saved?.statusHistory.filter((event) => event.status === 'placed')).toHaveLength(1);
  });
});

describe('a closed sheet or failed payment never confirms the order', () => {
  it('keeps it unconfirmed after payment.failed, lets the customer retry, then expires it', async () => {
    await setCharge('Tamil Nadu', TN_CHARGE);
    const { res, customer, product } = await codCheckout();
    const { order, payment } = res.body.data;

    await webhook({
      event: 'payment.failed',
      payload: { payment: { entity: { order_id: payment.razorpayOrderId, error_description: 'Card declined' } } },
    }).expect(200);
    const afterFail = await Order.findById(order.id);
    expect(afterFail).toMatchObject({ orderStatus: 'pending_payment', paymentStatus: 'failed' });

    // "Try again": the same Razorpay order, for the same amount — no new order, no new stock hold.
    const retry = await request.get(api(`/orders/${order.id}/payment`)).set('Authorization', customer.auth).expect(200);
    expect(retry.body.data).toMatchObject({ razorpayOrderId: payment.razorpayOrderId, amount: TN_CHARGE });
    expect(await stockOf(product.id)).toBe(3);

    expect(await expireStalePendingOrders(minutesFromNow(10))).toEqual({ expired: 0, paid: 0 });
    expect(await expireStalePendingOrders(minutesFromNow(31))).toEqual({ expired: 1, paid: 0 });
    expect(await Order.findById(order.id)).toMatchObject({ orderStatus: 'cancelled', paymentStatus: 'expired' });
    expect(await stockOf(product.id)).toBe(5);
  });

  it('expires an order whose sheet was simply closed (nothing ever arrives)', async () => {
    await setCharge('Tamil Nadu', TN_CHARGE);
    const { res, product } = await codCheckout();

    await expireStalePendingOrders(minutesFromNow(31));

    expect(await Order.findById(res.body.data.order.id)).toMatchObject({ orderStatus: 'cancelled', paymentStatus: 'expired' });
    expect(await stockOf(product.id)).toBe(5);
  });

  it("will not hand out another customer's payment", async () => {
    await setCharge('Tamil Nadu', TN_CHARGE);
    const { res } = await codCheckout();
    const stranger = await createTestUser();

    await request.get(api(`/orders/${res.body.data.order.id}/payment`)).set('Authorization', stranger.auth).expect(404);
  });
});

describe('a capture after expiry', () => {
  it('is recorded, flagged and refunded — the shipping charge only', async () => {
    await setCharge('Tamil Nadu', TN_CHARGE);
    const { res } = await codCheckout();
    const { order, payment } = res.body.data;
    await expireStalePendingOrders(minutesFromNow(31));

    await webhook({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_late', order_id: payment.razorpayOrderId } } },
    }).expect(200);

    const saved = await Order.findById(order.id);
    expect(saved?.orderStatus).toBe('cancelled');
    expect(saved?.payment?.lateCapture).toBe(true);
    expect(saved?.refund?.status).toBe('pending');
    expect(mockRazorpay.refunds).toEqual([expect.objectContaining({ payment_id: 'pay_late', amount: TN_CHARGE })]);
  });
});

describe('a ₹0 COD charge', () => {
  it('confirms at once without Razorpay, with everything due in cash', async () => {
    await setCharge('Kerala', 0);
    const { res, customer } = await codCheckout('Kerala');

    expect(res.status).toBe(201);
    expect(res.body.data.payment).toBeUndefined();
    expect(mockRazorpay.orders).toHaveLength(0);
    expect(res.body.data.order).toMatchObject({
      orderStatus: 'placed',
      awaitingPayment: false,
      shippingCharge: 0,
      amountPaidOnline: 0,
      amountDueOnDelivery: PRICE * 2,
    });
    expect((await Cart.findOne({ userId: customer.id }))?.items).toHaveLength(0);
  });
});

describe('cancelling a COD order whose shipping was paid', () => {
  it('turns the customer cancel into a request', async () => {
    const { customer, order } = await paidCodOrder();

    const res = await request.post(api(`/orders/${order.id}/cancel`)).set('Authorization', customer.auth).send({}).expect(200);

    expect(res.body.data).toMatchObject({ orderStatus: 'placed', cancellationRequest: expect.any(Object) });
    expect(mockRazorpay.refunds).toHaveLength(0);
  });

  it('refunds only the shipping charge when admin cancels; staff cannot', async () => {
    const { order, paymentId, product } = await paidCodOrder();
    const staff = await createTestUser({ accountType: 'staff' });
    const admin = await createTestUser({ accountType: 'admin' });

    await request.patch(api(`/admin/orders/${order.id}/status`)).set('Authorization', staff.auth).send({ status: 'cancelled' }).expect(403);
    const res = await request
      .patch(api(`/admin/orders/${order.id}/status`))
      .set('Authorization', admin.auth)
      .send({ status: 'cancelled' })
      .expect(200);

    expect(res.body.data).toMatchObject({ orderStatus: 'cancelled', refundState: 'pending' });
    expect(mockRazorpay.refunds).toEqual([expect.objectContaining({ payment_id: paymentId, amount: TN_CHARGE })]);
    expect(await stockOf(product.id)).toBe(5);
  });

  it('lets the customer cancel an unpaid one outright, releasing the stock', async () => {
    await setCharge('Tamil Nadu', TN_CHARGE);
    const { res, customer, product } = await codCheckout();

    const cancelled = await request
      .post(api(`/orders/${res.body.data.order.id}/cancel`))
      .set('Authorization', customer.auth)
      .send({})
      .expect(200);

    expect(cancelled.body.data.orderStatus).toBe('cancelled');
    expect(await stockOf(product.id)).toBe(5);
  });
});

describe('what the customer and admin see', () => {
  it('shows shipping paid online and the cash due, to both', async () => {
    const { customer, order } = await paidCodOrder();
    const admin = await createTestUser({ accountType: 'admin' });

    const mine = await request.get(api(`/orders/${order.id}`)).set('Authorization', customer.auth).expect(200);
    const theirs = await request.get(api(`/admin/orders/${order.id}`)).set('Authorization', admin.auth).expect(200);
    const list = await request.get(api('/admin/orders')).set('Authorization', admin.auth).expect(200);

    for (const view of [mine.body.data, theirs.body.data, list.body.data[0]]) {
      expect(view).toMatchObject({ amountPaidOnline: TN_CHARGE, amountDueOnDelivery: PRICE * 2, paymentStatus: 'paid' });
    }
  });

  it('keeps unpaid COD orders out of revenue and in "awaiting payment" on the dashboard', async () => {
    const admin = await setCharge('Tamil Nadu', TN_CHARGE);
    const { res } = await codCheckout();
    // Through the driver: Mongoose treats createdAt as immutable.
    await Order.collection.updateOne(
      { _id: new Types.ObjectId(res.body.data.order.id) },
      { $set: { createdAt: minutesFromNow(-90) } },
    );

    const dashboard = await request.get(api('/admin/dashboard')).set('Authorization', admin.auth).expect(200);

    expect(dashboard.body.data.pendingPaymentOverHour).toBe(1);
    expect(dashboard.body.data.todaysRevenue).toBe(0);
    expect(dashboard.body.data.ordersByStatus.placed).toBeUndefined();
  });
});
