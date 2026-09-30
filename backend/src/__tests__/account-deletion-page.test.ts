import { Types } from 'mongoose';
import {
  clearTestDb,
  connectTestDb,
  createTestUser,
  disconnectTestDb,
  request,
} from './helpers/testServer';
import { KvEntry } from '../models/kvEntry.model';
import { Order } from '../models/order.model';
import { User } from '../models/user.model';

/**
 * The public account-deletion page (Google Play's web deletion URL), driven
 * as a browser would: form posts to /account-deletion/code and /confirm,
 * backed by the emailed-code flow in account.service.ts.
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

/** The code is emailed without being awaited; let it go out. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const postForm = (path: string, fields: Record<string, string>) =>
  request.post(path).type('form').send(fields);

const requestCode = (email: string) => postForm('/account-deletion/code', { email });

const confirmCode = (email: string, code: string) =>
  postForm('/account-deletion/confirm', { email, code, confirm: 'yes' });

const deletionCodesSentTo = (email: string) =>
  mockSendCode.mock.calls.filter(([input]) => input.to === email && input.purpose === 'delete');

async function emailedCodeFor(email: string): Promise<string> {
  await requestCode(email).expect(200);
  await flush();
  const sent = deletionCodesSentTo(email);
  if (sent.length === 0) throw new Error(`No deletion code was emailed to ${email}`);
  return sent[sent.length - 1][0].code;
}

async function customer(options: Parameters<typeof createTestUser>[0] = {}) {
  const user = await createTestUser(options);
  return { id: user.id, email: user.document.email as string };
}

const isDeleted = async (id: string) => Boolean((await User.findById(id))?.deletedAt);

let seq = 0;
function orderFor(userId: string, overrides: Record<string, unknown>) {
  seq += 1;
  return Order.create({
    orderNumber: `MF-WEBDEL-${seq}`,
    userId,
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
      fullName: 'Buyer',
      phone: '+919876500000',
      line1: '1 Street',
      city: 'Madurai',
      state: 'Tamil Nadu',
      pincode: '625001',
    },
    paymentMethod: 'cod',
    paymentStatus: 'pending',
    subtotal: 50000,
    shippingCharge: 0,
    totalAmount: 50000,
    orderStatus: 'delivered',
    statusHistory: [{ status: 'placed', at: new Date() }],
    ...overrides,
  });
}

describe('GET /account-deletion', () => {
  it('serves step 1 as public, script-free HTML', async () => {
    const res = await request.get('/account-deletion');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('action="/account-deletion/code"');
    expect(res.text).not.toMatch(/<script/i);
  });
});

describe('POST /account-deletion/code', () => {
  it('gives an unknown email exactly the same page as a registered one, and sends nothing', async () => {
    const known = await customer();

    const knownRes = await requestCode(known.email);
    const unknownRes = await requestCode('nobody@example.com');
    await flush();

    expect(knownRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    // Byte for byte, once the address itself is swapped.
    expect(unknownRes.text).toBe(knownRes.text.split(known.email).join('nobody@example.com'));
    expect(unknownRes.text).toContain('sent it a 6-digit code');
    expect(unknownRes.headers['cache-control']).toBe('no-store');

    expect(deletionCodesSentTo(known.email)).toHaveLength(1);
    expect(deletionCodesSentTo('nobody@example.com')).toHaveLength(0);
  });

  it('escapes an email containing HTML on the code step', async () => {
    const email = 'a"b<i>c</i>@example.com';

    const res = await requestCode(email);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<i>c</i>');
    expect(res.text).not.toContain('value="a"b');
    // Both places it appears: the visible text and the hidden form field.
    const escaped = 'a&quot;b&lt;i&gt;c&lt;/i&gt;@example.com';
    expect(res.text.split(escaped)).toHaveLength(3);
  });
});

describe('POST /account-deletion/confirm', () => {
  it('refuses a wrong code and keeps the account', async () => {
    const user = await customer();
    const code = await emailedCodeFor(user.email);

    const res = await confirmCode(user.email, code === '000000' ? '111111' : '000000');

    expect(res.status).toBe(400);
    expect(res.text).toContain('wrong or has expired');
    expect(await isDeleted(user.id)).toBe(false);
  });

  it('refuses an expired code and keeps the account', async () => {
    const user = await customer();
    const code = await emailedCodeFor(user.email);
    // Past its expiry, as if the 10 minutes had run out.
    await KvEntry.updateOne(
      { _id: `acctdel:code:${user.email}` },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const res = await confirmCode(user.email, code);

    expect(res.status).toBe(400);
    expect(res.text).toContain('wrong or has expired');
    expect(await isDeleted(user.id)).toBe(false);
  });

  it('refuses while a delivery is on its way', async () => {
    const user = await customer();
    await orderFor(user.id, { orderStatus: 'shipped' });
    const code = await emailedCodeFor(user.email);

    const res = await confirmCode(user.email, code);

    expect(res.status).toBe(409);
    expect(res.text).toContain('delivery is on its way');
    expect(await isDeleted(user.id)).toBe(false);
  });

  it('refuses while a refund is due', async () => {
    const user = await customer();
    await orderFor(user.id, { orderStatus: 'cancelled', paymentStatus: 'paid', paymentMethod: 'razorpay' });
    const code = await emailedCodeFor(user.email);

    const res = await confirmCode(user.email, code);

    expect(res.status).toBe(409);
    expect(res.text).toContain('refund is due');
    expect(await isDeleted(user.id)).toBe(false);
  });

  it('refuses an admin account', async () => {
    const admin = await customer({ accountType: 'admin' });
    const code = await emailedCodeFor(admin.email);

    const res = await confirmCode(admin.email, code);

    expect(res.status).toBe(403);
    expect(res.text).toContain('be deleted here');
    expect(await isDeleted(admin.id)).toBe(false);
  });

  it('deletes the account with the right code and the box ticked', async () => {
    const user = await customer();
    const code = await emailedCodeFor(user.email);

    const res = await confirmCode(user.email, code);

    expect(res.status).toBe(200);
    expect(res.text).toContain('has been deleted');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await isDeleted(user.id)).toBe(true);
    expect((await User.findById(user.id))?.email).toBeUndefined();
  });
});
