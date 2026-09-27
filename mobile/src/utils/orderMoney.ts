import type { Order } from '../api/types';
import { formatPaise } from './money';

/**
 * How an order's money splits between online (Razorpay) and cash at the
 * door. Cash on Delivery pays the shipping charge online and the items in
 * cash. Orders from a server that predates the split fall back to how they
 * worked then: online orders fully online, COD fully in cash.
 */
export function moneySplit(order: Order): { paidOnline: number; dueOnDelivery: number } {
  if (typeof order.amountPaidOnline === 'number' && typeof order.amountDueOnDelivery === 'number') {
    return { paidOnline: order.amountPaidOnline, dueOnDelivery: order.amountDueOnDelivery };
  }
  return order.paymentMethod === 'razorpay'
    ? { paidOnline: order.totalAmount, dueOnDelivery: 0 }
    : { paidOnline: 0, dueOnDelivery: order.totalAmount };
}

/**
 * The line the delivery person needs, for a COD order: what was already paid
 * online and exactly how much cash to collect. Null for online orders.
 */
export function codCollectionLine(order: Order): string | null {
  if (order.paymentMethod !== 'cod') return null;
  const { paidOnline, dueOnDelivery } = moneySplit(order);
  if (order.orderStatus === 'pending_payment') {
    return `Awaiting ${formatPaise(paidOnline)} shipping payment online — not placed yet`;
  }
  const shipping =
    paidOnline > 0
      ? order.paymentStatus === 'refunded'
        ? `Shipping ${formatPaise(paidOnline)} refunded`
        : `Shipping paid ${formatPaise(paidOnline)} online`
      : 'No online payment';
  return `${shipping} • Collect ${formatPaise(dueOnDelivery)} cash on delivery`;
}
