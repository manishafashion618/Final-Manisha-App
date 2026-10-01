import { scrubText, scrubUrl, scrubValue } from '../scrubPii';

/** F17 — nothing personal may reach an error report from the app. */
describe('scrubPii (mobile)', () => {
  it('removes emails, phones, tokens, codes and Razorpay ids from text', () => {
    const scrubbed = scrubText(
      'priya@example.com called 98765 43210 with Bearer abc.def and code 482913 for pay_Nx8k2LmQ9vRt',
    );
    expect(scrubbed).toBe('[email] called [phone] with Bearer [token] and code [6-digit] for [razorpay-id]');
  });

  it('drops the query string from URLs', () => {
    expect(scrubUrl('https://api.example.com/api/v1/admin/users?search=Priya')).toBe(
      'https://api.example.com/api/v1/admin/users',
    );
  });

  it('redacts personal keys at any depth', () => {
    const scrubbed = scrubValue({ order: { shippingAddress: { line1: '12 MG Road' }, note: 'x@y.in' } });
    expect(JSON.stringify(scrubbed)).not.toMatch(/MG Road|x@y\.in/);
  });

  it.each([
    '+919876543210',
    '919876543210',
    '9876543210',
    '09876543210',
    '+91 9876543210',
    '98765 43210',
    '+91 98765 43210',
    '+91-98765-43210',
  ])('replaces the mobile number %s whole', (phone) => {
    expect(scrubText(`{"contact":"${phone}"}`)).toBe('{"contact":"[phone]"}');
  });

  // Six-digit amounts aren't here: 150000 paise looks exactly like a reset
  // code or a PIN code, and the 6-digit rule keeps hiding all three.
  it.each([
    ['an order id', 'https://api.example.com/api/v1/orders/6a1f9876543210abcdef0123/payment'],
    ['another order id', 'Order 6a1fbc482913de0f1a2b3c4d is not awaiting payment'],
    ['order numbers', 'MF-20261001-A1B2C3 and MF-20261001-482913'],
    ['amounts', 'Paid 50000 of 1250000 paise (₹12,500.00); limit 100000000'],
    ['timestamps', '2026-10-01T17:13:56.627Z at 1790812836627 (1790812836)'],
  ])('leaves %s alone', (_label, text) => {
    expect(scrubText(text)).toBe(text);
  });
});
