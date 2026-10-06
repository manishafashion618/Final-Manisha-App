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
import { CodStateConfig } from '../models/codStateConfig.model';

/**
 * Shipping on PREPAID (online) orders, priced per state (PRD 4.4 / 6).
 *
 * The store's rules, which these tests encode: Tamil Nadu and Puducherry
 * ₹60, everywhere else ₹100, no free-shipping threshold, and the same
 * charges for wholesale buyers. ₹100 is the store default rather than 36
 * rows, so "everywhere else" needs no configuration and a newly added state
 * is priced correctly on day one.
 *
 * Runs against a fake Razorpay: a prepaid order always has money to collect
 * online, so without one every checkout here would 503 before it priced
 * anything.
 */

const DEFAULT_PREPAID = 10_000; // ₹100 — PREPAID_SHIPPING_CHARGE
const SOUTH_PREPAID = 6_000; // ₹60 — Tamil Nadu and Puducherry
const PRICE = 100_000; // ₹1,000 a piece

jest.mock('../config/env', () => {
  const actual = jest.requireActual('../config/env');
  return {
    ...actual,
    razorpayConfigured: true,
    env: {
      ...actual.env,
      PREPAID_SHIPPING_CHARGE: 10_000,
      RAZORPAY_KEY_ID: 'rzp_test_prepaid_suite',
      RAZORPAY_KEY_SECRET: 'test_key_secret',
    },
  };
});

const mockRazorpay = { orders: [] as Array<{ id: string; amount: number }> };

jest.mock('../config/razorpay', () => ({
  razorpayConfigured: true,
  getRazorpay: () => ({
    orders: {
      create: async (input: { amount: number }) => {
        const order = { id: `order_prepaid_${mockRazorpay.orders.length + 1}`, amount: input.amount };
        mockRazorpay.orders.push(order);
        return { ...order, currency: 'INR' };
      },
    },
  }),
}));

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(async () => {
  mockRazorpay.orders = [];
  await clearTestDb();
});

/** Sets a state's prepaid charge the way the admin screen does. */
async function setPrepaid(state: string, prepaidCharge: number) {
  const admin = await createTestUser({ accountType: 'admin' });
  await request
    .put(api(`/admin/cod-config/${encodeURIComponent(state)}`))
    .set('Authorization', admin.auth)
    .send({ codEnabled: true, codCharge: 5_000, prepaidCharge })
    .expect(200);
  return admin;
}

async function prepaidCheckout(
  state: string,
  options: { accountType?: 'retail' | 'wholesale' } = {},
) {
  const customer = await createTestUser({
    address: { state },
    accountType: options.accountType ?? 'retail',
  });
  const product = await createTestProduct({ retailPrice: PRICE, stock: 5 });
  await seedCart(customer.id, product.id, 1);

  const res = await request
    .post(api('/orders/checkout'))
    .set('Authorization', customer.auth)
    .send({ addressId: customer.addressId, paymentMethod: 'razorpay' })
    .expect(201);

  return { customer, order: res.body.data.order, payment: res.body.data.payment };
}

describe("the store's prepaid shipping rules", () => {
  it('charges Tamil Nadu ₹60', async () => {
    await setPrepaid('Tamil Nadu', SOUTH_PREPAID);
    const { order, payment } = await prepaidCheckout('Tamil Nadu');

    expect(order.shippingCharge).toBe(SOUTH_PREPAID);
    expect(order.totalAmount).toBe(PRICE + SOUTH_PREPAID);
    // What Razorpay is actually asked for — the whole total, shipping included.
    expect(payment.amount).toBe(PRICE + SOUTH_PREPAID);
  });

  it('charges Puducherry ₹60, however the address spells it', async () => {
    await setPrepaid('Puducherry', SOUTH_PREPAID);

    // One row, keyed on the catalogue name, covers every spelling that
    // reaches checkout from an address typed by hand or by an older app.
    for (const spelling of ['Puducherry', 'Pondicherry', 'PY', 'puducherry']) {
      const { order } = await prepaidCheckout(spelling);
      expect([spelling, order.shippingCharge]).toEqual([spelling, SOUTH_PREPAID]);
    }
  });

  it('charges every other state ₹100, from the store default', async () => {
    await setPrepaid('Tamil Nadu', SOUTH_PREPAID);

    const { order } = await prepaidCheckout('Maharashtra');

    expect(order.shippingCharge).toBe(DEFAULT_PREPAID);
    expect(order.totalAmount).toBe(PRICE + DEFAULT_PREPAID);
    // Nothing was configured for Maharashtra — the default did this.
    expect(await CodStateConfig.countDocuments()).toBe(1);
  });

  it('falls back to the default for a state with a row but no prepaid amount of its own', async () => {
    // A row written before prepaid was priced per state: COD is configured,
    // prepaidCharge was never set. It must not read as ₹0.
    const admin = await createTestUser({ accountType: 'admin' });
    await request
      .put(api('/admin/cod-config/Kerala'))
      .set('Authorization', admin.auth)
      .send({ codEnabled: true, codCharge: 7_000 })
      .expect(200);
    expect((await CodStateConfig.findOne({ stateKey: 'kerala' }))?.prepaidCharge).toBeNull();

    const { order } = await prepaidCheckout('Kerala');

    expect(order.shippingCharge).toBe(DEFAULT_PREPAID);
  });

  it('charges a wholesale buyer the same shipping as a retail one', async () => {
    await setPrepaid('Tamil Nadu', SOUTH_PREPAID);

    const retail = await prepaidCheckout('Tamil Nadu');
    const wholesale = await prepaidCheckout('Tamil Nadu', { accountType: 'wholesale' });

    // The items are cheaper at the wholesale tier; the shipping is not
    // discounted with them.
    expect(wholesale.order.subtotal).toBeLessThan(retail.order.subtotal);
    expect(wholesale.order.shippingCharge).toBe(SOUTH_PREPAID);
    expect(wholesale.order.shippingCharge).toBe(retail.order.shippingCharge);
  });

  it('prices prepaid orders to a state where COD is switched off', async () => {
    // codEnabled governs COD alone. Turning it off must not make prepaid
    // orders to that state unpriceable — it is the only method left there.
    const admin = await createTestUser({ accountType: 'admin' });
    await request
      .put(api('/admin/cod-config/Assam'))
      .set('Authorization', admin.auth)
      .send({ codEnabled: false, codCharge: 0, prepaidCharge: 12_000 })
      .expect(200);

    const { order } = await prepaidCheckout('Assam');

    expect(order.shippingCharge).toBe(12_000);
  });

  it('ignores a shipping charge sent by the client', async () => {
    await setPrepaid('Tamil Nadu', SOUTH_PREPAID);
    const customer = await createTestUser({ address: { state: 'Tamil Nadu' } });
    const product = await createTestProduct({ retailPrice: PRICE, stock: 5 });
    await seedCart(customer.id, product.id, 1);

    const res = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({
        addressId: customer.addressId,
        paymentMethod: 'razorpay',
        shippingCharge: 0,
        totalAmount: PRICE,
      })
      .expect(201);

    expect(res.body.data.order.shippingCharge).toBe(SOUTH_PREPAID);
    expect(res.body.data.payment.amount).toBe(PRICE + SOUTH_PREPAID);
  });
});

describe('what the checkout screen is told', () => {
  it("quotes the address's own prepaid charge, which is what checkout then bills", async () => {
    await setPrepaid('Tamil Nadu', SOUTH_PREPAID);
    const customer = await createTestUser({ address: { state: 'Tamil Nadu' } });
    const product = await createTestProduct({ retailPrice: PRICE, stock: 5 });
    await seedCart(customer.id, product.id, 1);

    const quote = await request
      .get(api('/orders/cod-options'))
      .query({ addressId: customer.addressId })
      .set('Authorization', customer.auth)
      .expect(200);

    expect(quote.body.data).toMatchObject({
      state: 'Tamil Nadu',
      prepaidShippingCharge: SOUTH_PREPAID,
      usingDefault: false,
    });

    const res = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'razorpay' })
      .expect(201);

    // The quote the screen renders and the amount Razorpay collects are the
    // same figure — this is the agreement the screen's total depends on.
    expect(res.body.data.payment.amount).toBe(PRICE + quote.body.data.prepaidShippingCharge);
  });

  it('quotes the default for an unconfigured state, and says so', async () => {
    const customer = await createTestUser({ address: { state: 'Maharashtra' } });

    const quote = await request
      .get(api('/orders/cod-options'))
      .query({ addressId: customer.addressId })
      .set('Authorization', customer.auth)
      .expect(200);

    expect(quote.body.data).toMatchObject({
      prepaidShippingCharge: DEFAULT_PREPAID,
      usingDefault: true,
    });
  });

  it('advertises per-state prepaid pricing so the client knows to ask', async () => {
    const customer = await createTestUser();

    const res = await request.get(api('/config')).set('Authorization', customer.auth).expect(200);

    expect(res.body.data).toMatchObject({
      prepaidPerStateSupported: true,
      prepaidShippingCharge: DEFAULT_PREPAID,
    });
  });
});
