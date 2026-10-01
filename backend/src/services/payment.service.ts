import crypto from 'crypto';
import { env, isProduction, razorpayConfigured } from '../config/env';
import { getRazorpay } from '../config/razorpay';
import { logger } from '../config/logger';
import { ApiError } from '../utils/ApiError';

/**
 * PRD 4.4 / 8.4 — Razorpay for UPI, cards, netbanking and wallets. COD skips
 * the gateway entirely and adds a shipping charge instead — see cod.service,
 * which owns whether COD is offered at all and what it costs in each state.
 */

export interface RazorpayOrderHandle {
  razorpayOrderId: string;
  amount: number;
  currency: string;
  keyId: string;
  /**
   * The order's delivery phone, for the checkout's prefill.contact — so the
   * sheet doesn't ask for a number the order already has. Empty when that
   * phone isn't a usable Indian mobile number (see razorpayContact).
   */
  contact: string;
}

/**
 * A phone number as Razorpay's checkout prefills it for India: +91 and the ten
 * digits, nothing else. Spaces, dashes and brackets, a +91 (or 91) country
 * code and a leading 0 are all tolerated. Anything that doesn't come down to a
 * ten-digit Indian mobile number gives '' — an empty field the customer fills
 * in, rather than a value Razorpay would reject.
 */
export function razorpayContact(phone: string | null | undefined): string {
  if (!phone) return '';
  const match = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(phone.replace(/[\s()-]/g, ''));
  return match ? `+91${match[1]}` : '';
}

export async function createRazorpayOrder(
  amountInPaise: number,
  receipt: string,
  deliveryPhone: string,
): Promise<RazorpayOrderHandle> {
  const razorpay = getRazorpay();
  if (!razorpay || !razorpayConfigured) {
    throw ApiError.serviceUnavailable(
      'Online payment is not available right now. Please choose Cash on Delivery.',
    );
  }

  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency: env.CURRENCY,
    receipt,
    payment_capture: true,
  });

  return {
    razorpayOrderId: order.id,
    amount: Number(order.amount),
    currency: order.currency,
    keyId: env.RAZORPAY_KEY_ID as string,
    contact: razorpayContact(deliveryPhone),
  };
}

/** Whether an order that owes money online can be taken right now. */
export function onlinePaymentAvailable(): boolean {
  return Boolean(getRazorpay() && razorpayConfigured);
}

/** The handle the app opens Razorpay with, for an existing Razorpay order. */
export function handleFor(
  razorpayOrderId: string,
  amountInPaise: number,
  deliveryPhone: string,
): RazorpayOrderHandle {
  return {
    razorpayOrderId,
    amount: amountInPaise,
    currency: env.CURRENCY,
    keyId: env.RAZORPAY_KEY_ID as string,
    contact: razorpayContact(deliveryPhone),
  };
}

/**
 * Verifies the checkout handshake signature.
 * The client cannot forge this: it is an HMAC over order_id|payment_id keyed
 * with the secret, which never leaves the server.
 */
export function verifyPaymentSignature(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): boolean {
  if (!env.RAZORPAY_KEY_SECRET) return false;

  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
    .digest('hex');

  return timingSafeEqual(expected, input.razorpaySignature);
}

/** PRD 4.4 — webhook signature check, computed over the raw request body. */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    logger.warn('RAZORPAY_WEBHOOK_SECRET not set — rejecting webhook.');
    return false;
  }

  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  return timingSafeEqual(expected, signature);
}

/* ── Refunds ────────────────────────────────────────────────────────────── */

export interface RefundOutcome {
  razorpayRefundId: string;
  status: 'pending' | 'processed' | 'failed';
  amount: number;
}

function refundStatus(status: unknown): RefundOutcome['status'] {
  return status === 'processed' || status === 'failed' ? status : 'pending';
}

/**
 * A refund already raised against this payment for this order, if any.
 *
 * The idempotency check behind every refund attempt: if an earlier call
 * reached Razorpay but its response was lost (timeout, crash), retrying must
 * adopt that refund rather than send the money twice.
 */
export async function findExistingRefund(
  razorpayPaymentId: string,
  orderNumber: string,
): Promise<RefundOutcome | null> {
  const razorpay = getRazorpay();
  if (!razorpay) return null;
  const { items } = await razorpay.payments.fetchMultipleRefund(razorpayPaymentId, { count: 100 });
  const match = items.find(
    (refund) => refund.notes?.orderNumber === orderNumber && refundStatus(refund.status) !== 'failed',
  );
  return match
    ? { razorpayRefundId: match.id, status: refundStatus(match.status), amount: Number(match.amount) }
    : null;
}

/** Full refund of a captured payment, tagged with the order it belongs to. */
export async function refundPayment(input: {
  razorpayPaymentId: string;
  amountInPaise: number;
  orderNumber: string;
}): Promise<RefundOutcome> {
  const razorpay = getRazorpay();
  if (!razorpay || !razorpayConfigured) {
    throw ApiError.serviceUnavailable('Online payments are not configured, so this refund cannot be sent.');
  }
  const refund = await razorpay.payments.refund(input.razorpayPaymentId, {
    amount: input.amountInPaise,
    speed: 'normal',
    receipt: input.orderNumber,
    notes: { orderNumber: input.orderNumber },
  });
  return { razorpayRefundId: refund.id, status: refundStatus(refund.status), amount: Number(refund.amount) };
}

/**
 * Whether Razorpay holds a captured payment for this Razorpay order — asked
 * before expiring an unpaid order, in case the webhook is merely late.
 * Resolves null when it cannot tell (not configured, or the API failed).
 */
export async function capturedPaymentFor(razorpayOrderId: string): Promise<string | null | undefined> {
  const razorpay = getRazorpay();
  if (!razorpay) return undefined;
  try {
    const { items } = await razorpay.orders.fetchPayments(razorpayOrderId);
    return items.find((payment) => payment.status === 'captured')?.id ?? null;
  } catch (error) {
    logger.warn(`Could not ask Razorpay about order ${razorpayOrderId}`, error);
    return undefined;
  }
}

/* ── Startup configuration check ────────────────────────────────────────── */

/**
 * Logs, at boot, anything about the Razorpay setup that would break or
 * mislead: half-set keys, a malformed key id, test keys in production (or live
 * keys elsewhere), a missing webhook secret, and — by making one read-only API
 * call — a key id and secret that do not belong together (e.g. a test key with
 * a live secret). Keys come only from the environment; nothing is hardcoded,
 * and the app receives the key id from GET /config.
 */
export async function checkRazorpayConfig(): Promise<void> {
  const keyId = env.RAZORPAY_KEY_ID ?? '';
  const hasSecret = Boolean(env.RAZORPAY_KEY_SECRET);
  const hasWebhookSecret = Boolean(env.RAZORPAY_WEBHOOK_SECRET);

  if (!keyId && !hasSecret) {
    if (env.COD_SHIPPING_PAID_ONLINE) {
      logger.error(
        '[razorpay] Not configured, but COD_SHIPPING_PAID_ONLINE is on: Cash on Delivery orders with a shipping ' +
          'charge CANNOT be placed (their charge is paid online). Configure Razorpay, or set COD_SHIPPING_PAID_ONLINE=false.',
      );
    }
    logger.warn('[razorpay] Not configured: online payment is OFF, customers can only choose Cash on Delivery.');
    if (hasWebhookSecret) logger.warn('[razorpay] RAZORPAY_WEBHOOK_SECRET is set but the API keys are not.');
    return;
  }
  if (!keyId || !hasSecret) {
    logger.error('[razorpay] Only one of RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET is set — online payment is OFF.');
    return;
  }

  const mode = keyId.startsWith('rzp_live_') ? 'live' : keyId.startsWith('rzp_test_') ? 'test' : null;
  if (!mode) {
    logger.error('[razorpay] RAZORPAY_KEY_ID does not start with rzp_live_ or rzp_test_ — check it was copied whole.');
  } else if (isProduction && mode === 'test') {
    logger.warn('[razorpay] TEST keys in production: payments are simulated and no money moves.');
  } else if (!isProduction && mode === 'live') {
    logger.warn('[razorpay] LIVE keys outside production: real money will move from this environment.');
  } else {
    logger.info(`[razorpay] ${mode.toUpperCase()} mode.`);
  }

  if (!hasWebhookSecret) {
    logger.error(
      '[razorpay] RAZORPAY_WEBHOOK_SECRET is not set: webhooks are rejected, so a payment completed after the app ' +
        'closes, and refund results, are never recorded. Set it to the secret of the webhook in the Razorpay dashboard ' +
        `(${mode ?? 'matching'} mode).`,
    );
  }

  const razorpay = getRazorpay();
  if (!razorpay) return;
  try {
    await razorpay.orders.all({ count: 1 });
    logger.info('[razorpay] Key id and secret verified with Razorpay.');
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 401) {
      logger.error(
        '[razorpay] Razorpay rejected RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET: they do not belong together ' +
          '(e.g. a test key id with a live secret, or a regenerated secret). Online checkout will fail.',
      );
    } else {
      logger.warn('[razorpay] Could not verify the keys with Razorpay right now', error);
    }
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}
