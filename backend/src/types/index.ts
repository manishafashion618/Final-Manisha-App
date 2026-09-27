/**
 * Shared domain types.
 *
 * MONEY: every monetary value in this codebase is an integer number of paise
 * (₹1 = 100). Floats are never used for money.
 */

export const ACCOUNT_TYPES = ['retail', 'wholesale', 'staff', 'admin'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const WHOLESALE_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
export type WholesaleStatus = (typeof WHOLESALE_STATUSES)[number];

/**
 * `pending_payment`: created, stock reserved, but the money due ONLINE has not
 * been captured yet — the full amount for an online order, the shipping
 * charge for Cash on Delivery. Not a real order until then: it becomes
 * `placed` only when the payment is captured (app confirm or webhook), and is
 * expired by the pending-payment sweep if it never is.
 */
export const ORDER_STATUSES = [
  'pending_payment',
  'placed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_METHODS = ['razorpay', 'cod'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * `expired`: an online payment that was never completed within
 * PENDING_PAYMENT_TTL_MINUTES; the order was cancelled and its stock released.
 */
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'refunded', 'expired'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Valid forward transitions for the order lifecycle (PRD 4.5). */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // Only a captured payment moves an order to `placed` (never an admin); an
  // unpaid order may be cancelled.
  pending_payment: ['cancelled'],
  placed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export interface JwtAccessPayload {
  sub: string;
  accountType: AccountType;
  wholesaleStatus: WholesaleStatus;
  tokenType: 'access';
}

export interface JwtRefreshPayload {
  sub: string;
  jti: string;
  tokenType: 'refresh';
}

export interface AuthenticatedUser {
  id: string;
  /** Absent on Google-only accounts (see user.model.ts). */
  phone?: string;
  accountType: AccountType;
  wholesaleStatus: WholesaleStatus;
  permissions: string[];
}
