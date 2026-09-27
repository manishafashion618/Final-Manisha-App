import { Router } from 'express';
import * as codController from '../controllers/cod.controller';
import * as orderController from '../controllers/order.controller';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { writeLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { objectIdParam, paginationQuery } from '../validators/common';
import {
  cancelOrderSchema,
  checkoutSchema,
  codOptionsQuery,
  confirmPaymentSchema,
} from '../validators/order.validator';
import { PERMISSIONS } from '../utils/rbac';

const router = Router();

router.post(
  '/checkout',
  validate({ body: checkoutSchema }),
  writeLimiter,
  authenticate,
  requirePermission(PERMISSIONS.ORDER_CREATE),
  orderController.checkout,
);

router.post(
  '/payment/confirm',
  validate({ body: confirmPaymentSchema }),
  writeLimiter,
  authenticate,
  requirePermission(PERMISSIONS.ORDER_CREATE),
  orderController.confirmPayment,
);

/**
 * What COD costs for one of the caller's saved addresses, and whether it is
 * offered there at all (PRD 4.4 / 6).
 *
 * Registered before '/:id' so the literal path is not swallowed by the order
 * detail route. Checkout re-resolves the same figures when the order is
 * actually placed — this is only so the screen can show the right number and
 * hide an option the state does not allow.
 */
router.get(
  '/cod-options',
  validate({ query: codOptionsQuery }),
  authenticate,
  requirePermission(PERMISSIONS.ORDER_CREATE),
  codController.optionsForAddress,
);

router.get(
  '/',
  validate({ query: paginationQuery }),
  authenticate,
  requirePermission(PERMISSIONS.ORDER_READ_OWN),
  orderController.listMine,
);

router.get(
  '/:id',
  validate({ params: objectIdParam() }),
  authenticate,
  requirePermission(PERMISSIONS.ORDER_READ_OWN),
  orderController.detailMine,
);

// PRD 4.5 — cancellation is permitted only while the order is still "placed";
// the service enforces that, this route only enforces ownership.
// Re-open payment for an order still awaiting it (closed sheet, failed attempt).
router.get(
  '/:id/payment',
  validate({ params: objectIdParam() }),
  authenticate,
  requirePermission(PERMISSIONS.ORDER_CREATE),
  orderController.paymentHandle,
);

router.post(
  '/:id/cancel',
  validate({ params: objectIdParam(), body: cancelOrderSchema }),
  writeLimiter,
  authenticate,
  requirePermission(PERMISSIONS.ORDER_CANCEL_OWN),
  orderController.cancelMine,
);

export default router;
