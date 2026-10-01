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
import { User } from '../models/user.model';
import { razorpayContact } from '../services/payment.service';

/**
 * The Razorpay sheet is prefilled with the order's delivery phone, so it does
 * not ask the customer for a number the order already has. For India Razorpay
 * expects +91 and the ten digits; anything that isn't a usable Indian mobile
 * number is left empty rather than sent. Runs against a fake Razorpay.
 */

jest.mock('../config/env', () => {
  const actual = jest.requireActual('../config/env');
  return {
    ...actual,
    razorpayConfigured: true,
    env: {
      ...actual.env,
      RAZORPAY_KEY_ID: 'rzp_test_prefill_suite',
      RAZORPAY_KEY_SECRET: 'test_key_secret',
    },
  };
});

jest.mock('../config/razorpay', () => {
  let seq = 0;
  return {
    razorpayConfigured: true,
    getRazorpay: () => ({
      orders: {
        create: async (input: { amount: number; currency: string }) => {
          seq += 1;
          return { id: `order_prefill_${seq}`, amount: input.amount, currency: input.currency };
        },
      },
    }),
  };
});

describe('razorpayContact', () => {
  it.each([
    ['a bare ten-digit number', '9876543210'],
    ['+91 in front', '+919876543210'],
    ['91 in front, without the +', '919876543210'],
    ['spaces', '+91 98765 43210'],
    ['spaces and no country code', '98765 43210'],
    ['a leading 0', '09876543210'],
    ['a leading 0 and spaces', '0 98765 43210'],
    ['dashes and brackets', '(+91) 98765-43210'],
  ])('gives +91 and the ten digits for %s', (_label, input) => {
    expect(razorpayContact(input)).toBe('+919876543210');
  });

  it.each([
    ['no phone', undefined],
    ['null', null],
    ['an empty string', ''],
    ['only spaces', '   '],
    ['too few digits', '98765 4321'],
    ['too many digits', '98765432101'],
    ['a number no Indian mobile starts with', '5876543210'],
    ['a landline with its STD code', '044 2345 6789'],
    ['another country', '+1 415 555 2671'],
    ['letters', '98765abcde'],
  ])('leaves contact empty for %s', (_label, input) => {
    expect(razorpayContact(input)).toBe('');
  });
});

describe('the handle the app opens Razorpay with', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  afterEach(clearTestDb);

  /** An online checkout; `deliveryPhone` overwrites the saved address's phone first. */
  async function checkoutOnline(deliveryPhone?: string) {
    const customer = await createTestUser({ address: { state: 'Kerala' } });
    if (deliveryPhone !== undefined) {
      // Straight onto the document, past the API's validation — as an address
      // saved in another format, or before that validation existed, would be.
      await User.updateOne({ _id: customer.id }, { $set: { 'addresses.0.phone': deliveryPhone } });
    }
    const product = await createTestProduct({ retailPrice: 50_000, stock: 5 });
    await seedCart(customer.id, product.id, 1);
    const res = await request
      .post(api('/orders/checkout'))
      .set('Authorization', customer.auth)
      .send({ addressId: customer.addressId, paymentMethod: 'razorpay' })
      .expect(201);
    return { customer, order: res.body.data.order, payment: res.body.data.payment };
  }

  const reopen = (customer: { auth: string }, orderId: string) =>
    request.get(api(`/orders/${orderId}/payment`)).set('Authorization', customer.auth).expect(200);

  it("carries the order's delivery phone, not the account's", async () => {
    const { customer, order, payment } = await checkoutOnline();
    expect(order.shippingAddress.phone).toBe('+919876500000');
    expect(payment.contact).toBe('+919876500000');
    expect(customer.document.phone).not.toBe('+919876500000');
  });

  it('carries the same phone when the payment is reopened from the order', async () => {
    const { customer, order } = await checkoutOnline();
    const res = await reopen(customer, order.id);
    expect(res.body.data.contact).toBe('+919876500000');
  });

  it('normalises a delivery phone stored with spaces and a leading 0', async () => {
    const { customer, order, payment } = await checkoutOnline('098765 00000');
    expect(payment.contact).toBe('+919876500000');
    expect((await reopen(customer, order.id)).body.data.contact).toBe('+919876500000');
  });

  it('leaves contact empty for a delivery phone that is not an Indian mobile', async () => {
    const { customer, order, payment } = await checkoutOnline('+1 415 555 2671');
    expect(payment.contact).toBe('');
    expect((await reopen(customer, order.id)).body.data.contact).toBe('');
  });
});
