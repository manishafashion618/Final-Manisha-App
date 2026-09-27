import { Router } from 'express';
import * as adminController from '../controllers/admin.controller';
import * as codController from '../controllers/cod.controller';
import * as orderController from '../controllers/order.controller';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { writeLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { objectIdParam } from '../validators/common';
import {
  codStateParam,
  reviewWholesaleSchema,
  setActiveSchema,
  setRoleSchema,
  upsertCodStateSchema,
  userListQuery,
  wholesaleListQuery,
} from '../validators/admin.validator';
import { orderListQuery, updateOrderStatusSchema } from '../validators/order.validator';
import { userIdParam } from '../validators/auth.validator';
import { PERMISSIONS } from '../utils/rbac';

const router = Router();

// Everything under /admin requires a signed-in staff or admin account.
router.use(authenticate);

router.get('/dashboard', requirePermission(PERMISSIONS.DASHBOARD_VIEW), adminController.dashboard);

/* ── Order management — staff and admin (PRD 8.9) ───────────────────────── */

router.get(
  '/orders',
  validate({ query: orderListQuery }),
  requirePermission(PERMISSIONS.ORDER_READ_ALL),
  orderController.listAll,
);

router.get(
  '/orders/:id',
  validate({ params: objectIdParam() }),
  requirePermission(PERMISSIONS.ORDER_READ_ALL),
  orderController.detailForAdmin,
);

router.post(
  '/orders/:id/refund',
  validate({ params: objectIdParam() }),
  writeLimiter,
  requirePermission(PERMISSIONS.ORDER_REFUND),
  orderController.retryRefund,
);

router.patch(
  '/orders/:id/status',
  validate({ params: objectIdParam(), body: updateOrderStatusSchema }),
  writeLimiter,
  requirePermission(PERMISSIONS.ORDER_STATUS_UPDATE),
  orderController.updateStatus,
);

/* ── Wholesale approvals — admin only ───────────────────────────────────── */

router.get(
  '/wholesale',
  validate({ query: wholesaleListQuery }),
  requirePermission(PERMISSIONS.WHOLESALE_APPROVE),
  adminController.listWholesale,
);

router.post(
  '/wholesale/:userId/review',
  validate({ params: userIdParam, body: reviewWholesaleSchema }),
  writeLimiter,
  requirePermission(PERMISSIONS.WHOLESALE_APPROVE),
  adminController.reviewWholesale,
);

/* ── Accounts — admin only ──────────────────────────────────────────────── */

router.get(
  '/users',
  validate({ query: userListQuery }),
  requirePermission(PERMISSIONS.USER_MANAGE),
  adminController.listUsers,
);

router.patch(
  '/users/:userId/role',
  validate({ params: userIdParam, body: setRoleSchema }),
  writeLimiter,
  requirePermission(PERMISSIONS.USER_MANAGE),
  adminController.setRole,
);

// Who changed whose role or activation, and when (newest first).
router.get(
  '/role-changes',
  requirePermission(PERMISSIONS.USER_MANAGE),
  adminController.roleChanges,
);

router.patch(
  '/users/:userId/active',
  validate({ params: userIdParam, body: setActiveSchema }),
  writeLimiter,
  requirePermission(PERMISSIONS.USER_MANAGE),
  adminController.setActive,
);

/* ── COD settings — admin only (PRD 4.4 / 6) ────────────────────────────── */

// Admin, not staff: this sets what a customer pays and whether they can order
// on COD at all, which sits with pricing rather than with order handling.
router.get(
  '/cod-config',
  requirePermission(PERMISSIONS.COD_CONFIG_MANAGE),
  codController.list,
);

router.put(
  '/cod-config/:state',
  validate({ params: codStateParam, body: upsertCodStateSchema }),
  writeLimiter,
  requirePermission(PERMISSIONS.COD_CONFIG_MANAGE),
  codController.upsert,
);

router.delete(
  '/cod-config/:state',
  validate({ params: codStateParam }),
  writeLimiter,
  requirePermission(PERMISSIONS.COD_CONFIG_MANAGE),
  codController.remove,
);

export default router;
