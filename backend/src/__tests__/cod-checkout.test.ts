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

// These tests cover per-state COD PRICING, which is the same whether the
// charge is collected in cash or online. They run in all-cash mode so no
// payment gateway is involved; paying the charge online before the order is
// confirmed (COD_SHIPPING_PAID_ONLINE, the production default) is covered in
// cod-online-shipping.test.ts.
jest.mock('../config/env', () => {
  const actual = jest.requireActual('../config/env');
  return { ...actual, env: { ...actual.env, COD_SHIPPING_PAID_ONLINE: false } };
});
import { Order } from '../models/order.model';
import { Product } from '../models/product.model';
import { User } from '../models/user.model';

/**
 * Checkout against the per-state COD rules (PRD 4.4 / 6 / 8.2).
 *
 * The rule under test throughout: the server re-derives availability and the
 * charge from the *saved* address every time, so nothing the client sends can
 * change what an order costs or unlock COD where the store has switched it off.
 */

const DEFAULT_COD_CHARGE = 5000; // paise — COD_SHIPPING_CHARGE in helpers/env.ts
const PRICE = 100_000; // ₹1,000 per piece

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

async function setState(state: string, codEnabled: boolean, codCharge: number) {
  const admin = await createTestUser({ accountType: 'admin' });
  await request
    .put(api(`/admin/cod-config/${encodeURIComponent(state)}`))
    .set('Authorization', admin.auth)
    .send({ codEnabled, codCharge })
    .expect(200);
}

async function customerReadyToCheckout(state: string) {
  const customer = await createTestUser({ address: { state } });
  const product = await createTestProduct({ retailPrice: PRICE, stock: 10 });
  await seedCart(customer.id, product.id, 2);
  return { customer, product };
}

describe('COD for a configured state', () => {
  it("charges that state's figure, not the store default", async () => {
    await setState('Tamil Nadu', true, 15_000);
    const { customer } = await customerReadyToCheckout('Tamil Nadu');

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'cod' })
      .expect(201);

    const { order } = response.body.data;
    expect(order.subtotal).toBe(PRICE * 2);
    expect(order.shippingCharge).toBe(15_000);
    expect(order.totalAmount).toBe(PRICE * 2 + 15_000);
  });

  it('applies a zero charge when the state is configured as free COD', async () => {
    await setState('Kerala', true, 0);
    const { customer } = await customerReadyToCheckout('Kerala');

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'cod' })
      .expect(201);

    expect(response.body.data.order.shippingCharge).toBe(0);
    expect(response.body.data.order.totalAmount).toBe(PRICE * 2);
  });

  it('matches a state the customer typed in a different case', async () => {
    await setState('Maharashtra', true, 25_000);
    const { customer } = await customerReadyToCheckout('maharashtra');

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'cod' })
      .expect(201);

    expect(response.body.data.order.shippingCharge).toBe(25_000);
  });
});

describe('COD for a disabled state', () => {
  it('refuses the order with a clear error and reserves no stock', async () => {
    await setState('Assam', false, 0);
    const { customer, product } = await customerReadyToCheckout('Assam');

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'cod' })
      .expect(409);

    expect(response.body.error.code).toBe('COD_UNAVAILABLE');
    expect(response.body.error.message).toContain('Assam');

    // Nothing was written, and the pieces are still on the shelf.
    await expect(Order.countDocuments()).resolves.toBe(0);
    const after = await Product.findById(product.id);
    expect(after?.stock).toBe(10);
  });

  it('still allows Razorpay in that state', async () => {
    await setState('Assam', false, 0);
    const { customer } = await customerReadyToCheckout('Assam');

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'razorpay' })
      // Razorpay keys are unset in tests, so the gateway call is what fails —
      // a 503 from payment.service, never the 409 that would mean the COD rule
      // had leaked across to the prepaid path.
      .expect(503);

    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('COD for an unconfigured state', () => {
  it('falls back to the store default', async () => {
    const { customer } = await customerReadyToCheckout('Bihar');

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'cod' })
      .expect(201);

    expect(response.body.data.order.shippingCharge).toBe(DEFAULT_COD_CHARGE);
  });

  it('falls back for a state name no rule can match — a typo, not a crash', async () => {
    await setState('Tamil Nadu', true, 15_000);
    // Not a spelling of any state, so no rule can claim it.
    const { customer } = await customerReadyToCheckout('Tmil Naddu');

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'cod' })
      .expect(201);

    expect(response.body.data.order.shippingCharge).toBe(DEFAULT_COD_CHARGE);
  });
});

/*
  The production bug: Tamil Nadu was configured at ₹100, but most saved
  addresses spell it "Tamilnadu", which used to normalise to a different key
  and fell through to the ₹50 default.
*/
describe('COD matches the ways a state is actually typed', () => {
  it.each(['Tamilnadu', 'TAMILNADU', 'tamil-nadu', ' Tamil  Nadu ', 'TN', 't.n.'])(
    'charges the Tamil Nadu rule for an address saved as %j',
    async (typed) => {
      await setState('Tamil Nadu', true, 10_000);
      const customer = await createTestUser({ address: { state: 'Kerala' } });
      const product = await createTestProduct({ retailPrice: PRICE, stock: 10 });
      await seedCart(customer.id, product.id, 1);
      // Written straight to the document, bypassing the address API's
      // canonicalisation — the shape of the addresses already in production.
      await User.updateOne(
        { _id: customer.id },
        { $set: { 'addresses.0.state': typed } },
      );

      const options = await request
        .get(api(`/orders/cod-options?addressId=${customer.addressId}`))
        .set('Authorization', customer.auth)
        .expect(200);
      expect(options.body.data.codCharge).toBe(10_000);
      expect(options.body.data.usingDefault).toBe(false);

      const order = await request
        .post(api('/orders/checkout'))
        .set('Authorization', customer.auth)
        .send({ addressId: customer.addressId, paymentMethod: 'cod' })
        .expect(201);
      expect(order.body.data.order.shippingCharge).toBe(10_000);
    },
  );

  it('matches "&" for "and", and a former name', async () => {
    await setState('Jammu and Kashmir', true, 7_000);
    await setState('Odisha', true, 8_000);

    const jk = await customerReadyToCheckout('Jammu & Kashmir');
    const orissa = await customerReadyToCheckout('Orissa');

    const [jkOrder, orissaOrder] = await Promise.all(
      [jk, orissa].map(({ customer }) =>
        request
          .post(api('/orders/checkout'))
          .set('Authorization', customer.auth)
          .send({ addressId: customer.addressId, paymentMethod: 'cod' })
          .expect(201),
      ),
    );
    expect(jkOrder.body.data.order.shippingCharge).toBe(7_000);
    expect(orissaOrder.body.data.order.shippingCharge).toBe(8_000);
  });

  it('keys an admin rule typed as a code onto the same row as the full name', async () => {
    await setState('Tamil Nadu', true, 10_000);
    await setState('TN', true, 12_000);

    await expect(CodStateConfig.countDocuments()).resolves.toBe(1);
    const row = await CodStateConfig.findOne();
    expect(row?.state).toBe('Tamil Nadu');
    expect(row?.codCharge).toBe(12_000);
  });

  it('saves a new address under the catalogue spelling', async () => {
    const customer = await createTestUser();

    const response = await request
      .post(api('/auth/addresses'))
      .set('Authorization', customer.auth)
      .send({
        fullName: 'Test Buyer',
        phone: '+919876500000',
        line1: '12 Test Street',
        city: 'Chennai',
        state: 'Tamilnadu',
        pincode: '600001',
      })
      .expect(201);

    expect(response.body.data[0].state).toBe('Tamil Nadu');
  });

  it('keeps an unrecognised state exactly as typed', async () => {
    const customer = await createTestUser();

    const response = await request
      .post(api('/auth/addresses'))
      .set('Authorization', customer.auth)
      .send({
        fullName: 'Test Buyer',
        phone: '+919876500000',
        line1: '12 Test Street',
        city: 'Somewhere',
        state: 'Tmil Naddu',
        pincode: '600001',
      })
      .expect(201);

    expect(response.body.data[0].state).toBe('Tmil Naddu');
  });
});

describe('the client cannot price its own order', () => {
  it('ignores a shippingCharge, codCharge or totalAmount sent in the body', async () => {
    await setState('Gujarat', true, 20_000);
    const { customer } = await customerReadyToCheckout('Gujarat');

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({
        addressId: customer.addressId,
        paymentMethod: 'cod',
        shippingCharge: 0,
        codCharge: 1,
        totalAmount: 1,
        subtotal: 1,
      })
      .expect(201);

    const { order } = response.body.data;
    expect(order.shippingCharge).toBe(20_000);
    expect(order.totalAmount).toBe(PRICE * 2 + 20_000);
  });

  it('ignores a state sent in the body, pricing from the saved address instead', async () => {
    await setState('Gujarat', true, 20_000);
    await setState('Kerala', true, 0);
    const { customer } = await customerReadyToCheckout('Gujarat');

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'cod', state: 'Kerala' })
      .expect(201);

    expect(response.body.data.order.shippingCharge).toBe(20_000);
    expect(response.body.data.order.shippingAddress.state).toBe('Gujarat');
  });

  it('cannot force COD in a disabled state by overriding the charge', async () => {
    await setState('Assam', false, 0);
    const { customer } = await customerReadyToCheckout('Assam');

    await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({
        addressId: customer.addressId,
        paymentMethod: 'cod',
        codEnabled: true,
        shippingCharge: 5000,
      })
      .expect(409);

    await expect(Order.countDocuments()).resolves.toBe(0);
  });

  it('cannot price an order against somebody else\'s address', async () => {
    await setState('Kerala', true, 0);
    const other = await createTestUser({ address: { state: 'Kerala' } });
    const { customer } = await customerReadyToCheckout('Gujarat');

    await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: other.addressId, paymentMethod: 'cod' })
      .expect(400);
  });

  it('prices a Buy-now order by the same rule', async () => {
    await setState('Rajasthan', true, 30_000);
    const customer = await createTestUser({ address: { state: 'Rajasthan' } });
    const product = await createTestProduct({ retailPrice: PRICE, stock: 10 });

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({
        addressId: customer.addressId,
        paymentMethod: 'cod',
        buyNow: { productId: product.id, quantity: 1 },
      })
      .expect(201);

    expect(response.body.data.order.shippingCharge).toBe(30_000);
    expect(response.body.data.order.totalAmount).toBe(PRICE + 30_000);
  });

  it('applies a charge changed by admin to the very next order', async () => {
    await setState('Odisha', true, 10_000);
    const { customer } = await customerReadyToCheckout('Odisha');

    await setState('Odisha', true, 40_000);

    const response = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'cod' })
      .expect(201);

    expect(response.body.data.order.shippingCharge).toBe(40_000);
  });
});

describe('GET /orders/cod-options', () => {
  it("reports the configured state's charge for the caller's own address", async () => {
    await setState('Telangana', true, 18_000);
    const customer = await createTestUser({ address: { state: 'Telangana' } });

    const response = await request
      .get(api('/orders/cod-options'))
      .query({ addressId: customer.addressId })
      .set('Authorization', customer.auth)
      .expect(200);

    expect(response.body.data).toMatchObject({
      state: 'Telangana',
      codEnabled: true,
      codCharge: 18_000,
      usingDefault: false,
    });
  });

  it('reports the default, flagged as such, for an unconfigured state', async () => {
    const customer = await createTestUser({ address: { state: 'Sikkim' } });

    const response = await request
      .get(api('/orders/cod-options'))
      .query({ addressId: customer.addressId })
      .set('Authorization', customer.auth)
      .expect(200);

    expect(response.body.data).toMatchObject({
      codEnabled: true,
      codCharge: DEFAULT_COD_CHARGE,
      usingDefault: true,
    });
  });

  it('reports COD as unavailable where the store has switched it off', async () => {
    await setState('Assam', false, 0);
    const customer = await createTestUser({ address: { state: 'Assam' } });

    const response = await request
      .get(api('/orders/cod-options'))
      .query({ addressId: customer.addressId })
      .set('Authorization', customer.auth)
      .expect(200);

    expect(response.body.data.codEnabled).toBe(false);
  });

  it("will not answer for another customer's address", async () => {
    const other = await createTestUser({ address: { state: 'Kerala' } });
    const customer = await createTestUser({ address: { state: 'Gujarat' } });

    await request
      .get(api('/orders/cod-options'))
      .query({ addressId: other.addressId })
      .set('Authorization', customer.auth)
      .expect(404);
  });

  it('agrees with what checkout actually charges', async () => {
    await setState('West Bengal', true, 22_000);
    const { customer } = await customerReadyToCheckout('West Bengal');

    const quoted = await request
      .get(api('/orders/cod-options'))
      .query({ addressId: customer.addressId })
      .set('Authorization', customer.auth)
      .expect(200);

    const placed = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'cod' })
      .expect(201);

    expect(placed.body.data.order.shippingCharge).toBe(quoted.body.data.codCharge);
  });
});

describe('the configuration is a collection, not a cache', () => {
  it('reads the rule that is in the database at order time', async () => {
    await setState('Haryana', true, 9000);
    const { customer } = await customerReadyToCheckout('Haryana');

    // Written straight to the collection, bypassing the API entirely.
    await CodStateConfig.updateOne({ stateKey: 'haryana' }, { $set: { codEnabled: false } });

    await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'cod' })
      .expect(409);
  });
});
