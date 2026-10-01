import { scrubText, scrubValue } from '../utils/scrubPii';

/** F17 — nothing personal may reach an error report. */
describe('scrubText', () => {
  it.each([
    ['an email', 'Login failed for Priya.S@Example.co.in today', 'priya'],
    ['a mobile number', 'Call +91 9876543210 or 98765 43210? 9876543210', '9876543210'],
    ['a JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_ghi rejected', 'eyJhbGci'],
    ['a bearer header', 'Authorization: Bearer abc.def.ghi', 'abc.def.ghi'],
    ['a reset code', 'password reset code for x → 482913', '482913'],
    ['a Razorpay payment id', 'Refund for pay_Nx8k2LmQ9vRt failed', 'pay_Nx8k2LmQ9vRt'],
  ])('removes %s', (_label, input, secret) => {
    expect(scrubText(input).toLowerCase()).not.toContain(secret.toLowerCase());
  });

  it('removes a mobile number written in the common 5+5 grouping', () => {
    expect(scrubText('call 98765 43210 or 98765-43210')).toBe('call [phone] or [phone]');
  });

  it('keeps ordinary diagnostic text readable', () => {
    expect(scrubText('Cast to ObjectId failed for value "abc" at path "_id"')).toBe(
      'Cast to ObjectId failed for value "abc" at path "_id"',
    );
  });
});

describe('scrubText: a mobile number in any form', () => {
  it.each([
    ['as stored, +91 and no space', '+919876543210'],
    ['91 without the +', '919876543210'],
    ['ten digits alone', '9876543210'],
    ['with a leading 0', '09876543210'],
    ['+91 and a space', '+91 9876543210'],
    ['in the 5+5 grouping', '98765 43210'],
    ['+91 and the 5+5 grouping', '+91 98765 43210'],
    ['with dashes', '+91-98765-43210'],
  ])('is replaced whole when written %s', (_label, phone) => {
    expect(scrubText(`code sent to ${phone}.`)).toBe('code sent to [phone].');
  });

  it.each([
    [
      'a duplicate-key error',
      'E11000 duplicate key error collection: shop.users index: phone_1 dup key: { phone: "+919876543210" }',
      'E11000 duplicate key error collection: shop.users index: phone_1 dup key: { phone: "[phone]" }',
    ],
    ['JSON', '{"contact":"+919876543210","name":"x"}', '{"contact":"[phone]","name":"x"}'],
    ['a query string', 'to=919876543210&tries=2', 'to=[phone]&tries=2'],
    ['a URL-encoded +', 'phone=%2B919876543210', 'phone=%2B[phone]'],
    ['a tel: link', 'tel:+919876543210;ext', 'tel:[phone];ext'],
    ['letters either side', 'ref9876543210x', 'ref[phone]x'],
  ])('is found inside %s', (_label, input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });
});

/*
 * Six-digit numbers are deliberately absent below: an amount of ₹1,500 is
 * 150000 paise, which looks exactly like a reset code or a PIN code, and the
 * 6-digit rule keeps hiding all three.
 */
describe('scrubText: numbers that are not personal are left alone', () => {
  it.each([
    // Order ids — Mongo ObjectIds, here with a phone-length and a six-digit
    // run inside — and order numbers, including an all-digit suffix.
    ['an order id in a URL', '/api/v1/orders/6a1f9876543210abcdef0123/payment'],
    ['an order id in a message', 'Order 6a1fbc482913de0f1a2b3c4d is not awaiting payment'],
    ['an order number', 'Refund for order MF-20261001-A1B2C3 failed'],
    ['an order number ending in digits', 'Payment captured after order MF-20261001-482913 was cancelled; refunding.'],
    // Amounts, in paise and in rupees.
    ['amounts in paise', 'Path `retailPrice` (125000000) is more than maximum allowed value (100000000). Paid 50000 of 1250000.'],
    ['amounts in rupees', 'Total ₹1,23,456.00, paid ₹98,765.50'],
    // Timestamps.
    ['a log line', '[2026-10-01T17:13:56.627Z] WARN  Pending-payment sweep: 0 expired, 1 found paid.'],
    ['epoch milliseconds and seconds', 'at 1790812836627 (1790812836)'],
    ['a local date', 'Thu Oct 01 2026 22:43:56 GMT+0530 (India Standard Time)'],
  ])('%s', (_label, text) => {
    expect(scrubText(text)).toBe(text);
  });
});

describe('scrubValue', () => {
  it('redacts sensitive keys outright and scrubs text elsewhere, at any depth', () => {
    const scrubbed = scrubValue({
      shippingAddress: { fullName: 'Priya S', line1: '12 MG Road', pincode: '560001', phone: '+919876543210' },
      note: 'customer priya@example.com asked for a refund',
      nested: [{ password: 'Secret123', detail: 'otp 123456' }],
    });

    expect(scrubbed.shippingAddress).toBe('[redacted]');
    expect(scrubbed.note).toBe('customer [email] asked for a refund');
    expect(scrubbed.nested[0].password).toBe('[redacted]');
    expect(scrubbed.nested[0].detail).toBe('otp [6-digit]');
    expect(JSON.stringify(scrubbed)).not.toMatch(/Priya|MG Road|560001|9876543210|Secret123/);
  });
});
