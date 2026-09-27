import type { Request, Response } from 'express';
import * as orderService from '../services/order.service';
import * as paymentService from '../services/payment.service';
import { logger } from '../config/logger';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import type { OrderStatus } from '../types';

export const checkout = asyncHandler(async (req: Request, res: Response) => {
  res.success(await orderService.checkout(req.user!, req.body), undefined, 201);
});

/** The Razorpay handle for "Try again" on one of the caller's unpaid orders. */
export const paymentHandle = asyncHandler(async (req: Request, res: Response) => {
  res.success(await orderService.getPaymentHandle(req.user!, req.params.id));
});

export const confirmPayment = asyncHandler(async (req: Request, res: Response) => {
  res.success(await orderService.confirmPayment(req.user!, req.body));
});

export const listMine = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };
  const result = await orderService.listMyOrders(req.user!.id, page, limit);
  res.success(result.items, result.pagination);
});

export const detailMine = asyncHandler(async (req: Request, res: Response) => {
  res.success(await orderService.getMyOrder(req.user!.id, req.params.id));
});

export const cancelMine = asyncHandler(async (req: Request, res: Response) => {
  res.success(await orderService.cancelMyOrder(req.user!.id, req.params.id, req.body?.reason));
});

/* ── Admin / staff ──────────────────────────────────────────────────────── */

export const listAll = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    page: number;
    limit: number;
    status?: OrderStatus;
    search?: string;
  };
  const result = await orderService.listAllOrders(query);
  res.success(result.items, result.pagination);
});

export const detailForAdmin = asyncHandler(async (req: Request, res: Response) => {
  res.success(await orderService.getOrderForAdmin(req.params.id));
});

export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  res.success(
    await orderService.updateOrderStatus(req.user!, req.params.id, req.body.status, req.body.note),
  );
});

/* ── Razorpay webhook (PRD 4.4) ─────────────────────────────────────────── */

export const razorpayWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.rawBody;

  if (typeof signature !== 'string' || !rawBody) {
    throw ApiError.badRequest('Missing webhook signature');
  }
  if (!paymentService.verifyWebhookSignature(rawBody, signature)) {
    throw ApiError.unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
  }

  // Process FIRST, acknowledge after. Razorpay retries any non-2xx, so a
  // failure here (database down, a crash mid-update) is answered with a 5xx
  // and the event comes back — instead of being acknowledged and lost, which
  // left paid orders stuck as pending. The handler is idempotent, so a retry
  // of an event that did partly apply is safe.
  try {
    await orderService.handlePaymentWebhook(req.body);
  } catch (error) {
    logger.error('Razorpay webhook processing failed; answering 500 so Razorpay retries', error);
    res.status(500).json({ success: false, error: { code: 'WEBHOOK_PROCESSING_FAILED', message: 'Retry later' } });
    return;
  }
  res.status(200).json({ success: true });
});

/** Admin: send (or re-send) the refund for a cancelled order that was paid online. */
export const retryRefund = asyncHandler(async (req: Request, res: Response) => {
  res.success(await orderService.retryRefund(req.params.id));
});
