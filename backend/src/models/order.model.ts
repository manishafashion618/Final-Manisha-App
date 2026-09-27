import { Schema, model, type Document, type Types } from 'mongoose';
import {
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
} from '../types';

export interface IOrderItem {
  productId: Types.ObjectId;
  /** Name and image are snapshotted so an order still renders if the product is deleted. */
  name: string;
  image?: string;
  quantity: number;
  /** PRD 8.2 — price protection: the price the customer actually paid, in paise. */
  priceAtOrder: number;
  priceTier: 'retail' | 'wholesale';
}

export interface IOrderStatusEvent {
  status: OrderStatus;
  at: Date;
  by?: Types.ObjectId;
  note?: string;
}

export interface IOrder extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  orderNumber: string;
  userId: Types.ObjectId;
  items: IOrderItem[];
  shippingAddress: {
    fullName: string;
    phone: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    pincode: string;
  };
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  payment?: {
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    razorpaySignature?: string;
    failureReason?: string;
    paidAt?: Date;
    /**
     * The payment was captured after the order had already been cancelled or
     * expired. Never silently kept: a refund is started automatically, and the
     * order shows as needing attention until it is processed.
     */
    lateCapture?: boolean;
  };
  /** Money going back for a paid order that was cancelled. */
  refund?: {
    /** initiating: claimed by this server, Razorpay not yet answered. */
    status: 'initiating' | 'pending' | 'processed' | 'failed';
    razorpayRefundId?: string;
    amount?: number;
    attempts: number;
    initiatedAt?: Date;
    processedAt?: Date;
    failureReason?: string;
  };
  /** A paid order the customer asked to cancel; the store decides and refunds. */
  cancellationRequest?: {
    requestedAt: Date;
    reason?: string;
  };
  /** The items total (priceAtOrder × quantity, summed). */
  subtotal: number;
  shippingCharge: number;
  totalAmount: number;
  /**
   * What is collected ONLINE via Razorpay: the full total for an online order,
   * the shipping charge for Cash on Delivery (0 when COD shipping is free).
   * Absent on orders placed before this split existed — see amountsOf().
   */
  amountPaidOnline?: number;
  /** What the courier collects in cash: the items total for COD, 0 online. */
  amountDueOnDelivery?: number;
  currency: string;
  orderStatus: OrderStatus;
  statusHistory: IOrderStatusEvent[];
  /**
   * True when the order came from "Buy now" rather than the saved cart.
   *
   * Payment confirmation empties the cart, and a Buy-now order must not: the
   * customer's cart had nothing to do with it, and clearing it would silently
   * delete items they never checked out.
   */
  fromBuyNow?: boolean;
  /**
   * When the stock this order was holding was credited back.
   *
   * Three paths cancel an order — the customer, the store, and Razorpay's
   * payment.failed webhook — and more than one can fire for the same order: a
   * customer who cancels a pending online payment still gets the webhook
   * afterwards. Without this marker each path restocks independently and
   * inflates the count, so it is set once and checked before every release.
   */
  stockReleasedAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    image: { type: String },
    quantity: { type: Number, required: true, min: 1 },
    priceAtOrder: { type: Number, required: true, min: 0 },
    priceTier: { type: String, enum: ['retail', 'wholesale'], required: true },
  },
  { _id: false },
);

const statusEventSchema = new Schema<IOrderStatusEvent>(
  {
    status: { type: String, enum: ORDER_STATUSES, required: true },
    at: { type: Date, default: Date.now },
    by: { type: Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, maxlength: 300 },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    items: { type: [orderItemSchema], required: true },
    shippingAddress: {
      fullName: { type: String, required: true },
      phone: { type: String, required: true },
      line1: { type: String, required: true },
      line2: { type: String },
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
    },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'pending', required: true },
    payment: {
      razorpayOrderId: { type: String, index: true, sparse: true },
      razorpayPaymentId: { type: String },
      razorpaySignature: { type: String },
      failureReason: { type: String },
      paidAt: { type: Date },
      lateCapture: { type: Boolean },
    },
    refund: {
      status: { type: String, enum: ['initiating', 'pending', 'processed', 'failed'] },
      razorpayRefundId: { type: String },
      amount: { type: Number, min: 0 },
      attempts: { type: Number, default: 0 },
      initiatedAt: { type: Date },
      processedAt: { type: Date },
      failureReason: { type: String, maxlength: 500 },
    },
    cancellationRequest: {
      requestedAt: { type: Date },
      reason: { type: String, maxlength: 300 },
    },
    subtotal: { type: Number, required: true, min: 0 },
    shippingCharge: { type: Number, required: true, min: 0, default: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    // No defaults on purpose: Mongoose would fill them on older orders read
    // back from the database, making a legacy online order look unpaid.
    amountPaidOnline: { type: Number, min: 0 },
    amountDueOnDelivery: { type: Number, min: 0 },
    currency: { type: String, default: 'INR' },
    orderStatus: { type: String, enum: ORDER_STATUSES, default: 'placed', required: true },
    statusHistory: { type: [statusEventSchema], default: [] },
    fromBuyNow: { type: Boolean, default: false },
    stockReleasedAt: { type: Date },
    cancelledAt: { type: Date },
    cancellationReason: { type: String, maxlength: 300 },
  },
  { timestamps: true },
);

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });
// The pending-payment expiry sweep and the admin "awaiting payment" count.
orderSchema.index({ paymentMethod: 1, paymentStatus: 1, createdAt: 1 });
// Refund webhooks find the order by the refund, or failing that the payment.
orderSchema.index({ 'refund.razorpayRefundId': 1 }, { sparse: true });
orderSchema.index({ 'payment.razorpayPaymentId': 1 }, { sparse: true });

export const Order = model<IOrder>('Order', orderSchema);
