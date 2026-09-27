import { AWAITING_ONLINE_PAYMENT } from './order.service';
import { Order } from '../models/order.model';
import { User, type IUser } from '../models/user.model';
import { RoleChange } from '../models/roleChange.model';
import { logger } from '../config/logger';
import * as productRepository from '../repositories/product.repository';
import { serializeProducts } from '../serializers/product.serializer';
import { serializeUser, type SerializedUser } from '../serializers/user.serializer';
import { ApiError } from '../utils/ApiError';
import type { AuthenticatedUser, WholesaleStatus } from '../types';
import * as tokenService from './token.service';

const LOW_STOCK_THRESHOLD = 5;

/** India has no daylight saving, so the day boundary is a fixed offset. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Midnight as the shop counts it.
 *
 * `new Date().setHours(0, 0, 0, 0)` reads the server's clock, and the server
 * runs in UTC — so "today" would roll over at 5:30am in the shop, and every
 * morning until then the dashboard would report yesterday's orders and takings
 * as today's.
 */
function startOfDayInIst(): Date {
  const nowInIst = new Date(Date.now() + IST_OFFSET_MS);
  nowInIst.setUTCHours(0, 0, 0, 0);
  return new Date(nowInIst.getTime() - IST_OFFSET_MS);
}

/** PRD 4.7 — basic dashboard: today's orders, pending approvals, low stock. */
export async function getDashboard(viewer: AuthenticatedUser) {
  const startOfDay = startOfDayInIst();

  const [
    todaysOrders,
    todaysRevenueAgg,
    pendingApprovals,
    lowStock,
    totalProducts,
    ordersByStatus,
    pendingPaymentOverHour,
    refundsDue,
  ] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: startOfDay } }),
    Order.aggregate<{ _id: null; total: number }>([
      {
        $match: {
          createdAt: { $gte: startOfDay },
          // Unpaid orders are not revenue: they may never be paid.
          orderStatus: { $nin: ['cancelled', 'pending_payment'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]),
    User.countDocuments({ accountType: 'wholesale', wholesaleStatus: 'pending' }),
    productRepository.findLowStock(LOW_STOCK_THRESHOLD, 10),
    productRepository.countAll(true),
    Order.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
    ]),
    // Online checkouts still unpaid after an hour: abandoned, or a payment
    // whose confirmation never arrived. The expiry sweep cancels them at
    // PENDING_PAYMENT_TTL_MINUTES; a number here that stays up means it is not.
    // Includes COD orders whose shipping charge was never paid.
    Order.countDocuments({
      ...AWAITING_ONLINE_PAYMENT,
      createdAt: { $lt: new Date(Date.now() - 60 * 60 * 1000) },
    }),
    // Money owed back: cancelled after payment with no refund, or a failed one.
    Order.countDocuments({
      paymentStatus: 'paid',
      orderStatus: 'cancelled',
      $or: [{ 'refund.status': { $exists: false } }, { 'refund.status': 'failed' }],
    }),
  ]);

  return {
    todaysOrders,
    todaysRevenue: todaysRevenueAgg[0]?.total ?? 0,
    pendingWholesaleApprovals: pendingApprovals,
    totalProducts,
    lowStockThreshold: LOW_STOCK_THRESHOLD,
    lowStockProducts: serializeProducts(lowStock, viewer),
    ordersByStatus: Object.fromEntries(ordersByStatus.map((row) => [row._id, row.count])),
    pendingPaymentOverHour,
    refundsDue,
  };
}

/* ── Wholesale approvals (PRD 4.7) ──────────────────────────────────────── */

export async function listWholesaleApplications(filters: {
  status?: WholesaleStatus;
  page: number;
  limit: number;
}) {
  const query: Record<string, unknown> = { accountType: 'wholesale' };
  if (filters.status) query.wholesaleStatus = filters.status;

  const skip = (filters.page - 1) * filters.limit;
  const [users, total] = await Promise.all([
    User.find(query).sort({ 'business.appliedAt': -1, createdAt: -1 }).skip(skip).limit(filters.limit),
    User.countDocuments(query),
  ]);

  return {
    items: users.map(serializeUser),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.limit)),
      hasMore: filters.page * filters.limit < total,
    },
  };
}

export async function reviewWholesaleApplication(
  actor: AuthenticatedUser,
  userId: string,
  decision: 'approved' | 'rejected',
  reason?: string,
): Promise<SerializedUser> {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('Account not found');
  if (user.accountType !== 'wholesale') {
    throw ApiError.badRequest('This account has not applied for wholesale pricing.');
  }
  if (user.wholesaleStatus === decision) {
    throw ApiError.conflict(`This application is already ${decision}.`);
  }

  user.wholesaleStatus = decision;
  user.wholesaleReview = {
    reviewedBy: actor.id as never,
    reviewedAt: new Date(),
    reason,
  };
  await user.save();

  // The user's permission set changes with this decision. Their existing access
  // token still carries the old claims, but authenticate() re-reads the user on
  // every request, so the change takes effect immediately.
  return serializeUser(user);
}

/* ── Customer / staff accounts (PRD 8.9 — admin only) ───────────────────── */

export async function listUsers(filters: {
  accountType?: string;
  search?: string;
  page: number;
  limit: number;
}) {
  const query: Record<string, unknown> = {};
  if (filters.accountType) query.accountType = filters.accountType;
  if (filters.search) {
    const pattern = new RegExp(filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ phone: pattern }, { name: pattern }, { 'business.businessName': pattern }];
  }

  const skip = (filters.page - 1) * filters.limit;
  const [users, total] = await Promise.all([
    User.find(query).sort({ createdAt: -1 }).skip(skip).limit(filters.limit),
    User.countDocuments(query),
  ]);

  return {
    items: users.map(serializeUser),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.limit)),
      hasMore: filters.page * filters.limit < total,
    },
  };
}

/**
 * Promotes or demotes a staff account. Admin-only (PRD 8.9: staff cannot manage
 * staff/admin accounts). Changing a role revokes that user's sessions so the
 * new permission set is picked up on a fresh sign-in.
 */
export async function setAccountRole(
  actor: AuthenticatedUser,
  userId: string,
  accountType: 'retail' | 'staff',
): Promise<SerializedUser> {
  if (userId === actor.id) {
    throw ApiError.badRequest('You cannot change your own role.');
  }
  // Belt and braces with the validator: admin is granted only by a verified
  // ADMIN_EMAILS address, never by an API call.
  if ((accountType as string) === 'admin') {
    throw ApiError.badRequest('Admin is granted through ADMIN_EMAILS, not this endpoint.');
  }

  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('Account not found');

  const previousRole = user.accountType;
  user.accountType = accountType;
  // None of the assignable roles carry wholesale pricing — that is granted only
  // through the approval flow — so any prior wholesale state is cleared.
  user.wholesaleStatus = 'none';
  await user.save();
  // Bumps tokenVersion as well as revoking refresh tokens, so the old
  // permission set dies on the next request rather than at token expiry.
  await tokenService.revokeEverySession(user._id);
  await recordAccountChange(actor, user, 'role', previousRole, accountType);

  return serializeUser(user);
}

/**
 * Appends to the role/activation trail. Never allowed to fail the action it
 * describes — a log write that throws must not leave the role half-changed.
 */
async function recordAccountChange(
  actor: AuthenticatedUser,
  target: IUser,
  action: 'role' | 'active',
  from: string,
  to: string,
): Promise<void> {
  try {
    const actorDoc = await User.findById(actor.id).select('email');
    await RoleChange.create({
      actorId: actor.id,
      actorEmail: actorDoc?.email,
      targetId: target._id,
      targetEmail: target.email,
      action,
      from,
      to,
    });
  } catch (error) {
    logger.error('Failed to record an account change in the audit trail', error);
  }
}

/** The newest role/activation changes, for the admin accounts screen. */
export async function listRoleChanges(limit = 50): Promise<
  Array<{
    id: string;
    actorEmail?: string;
    targetEmail?: string;
    action: 'role' | 'active';
    from: string;
    to: string;
    at: string;
  }>
> {
  const rows = await RoleChange.find().sort({ createdAt: -1 }).limit(Math.min(limit, 200));
  return rows.map((row) => ({
    id: row._id.toString(),
    actorEmail: row.actorEmail,
    targetEmail: row.targetEmail,
    action: row.action,
    from: row.from,
    to: row.to,
    at: row.createdAt.toISOString(),
  }));
}

export async function setAccountActive(
  actor: AuthenticatedUser,
  userId: string,
  isActive: boolean,
): Promise<SerializedUser> {
  if (userId === actor.id) {
    throw ApiError.badRequest('You cannot deactivate your own account.');
  }

  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('Account not found');

  const wasActive = user.isActive;
  user.isActive = isActive;
  await user.save();
  // Deactivation must bite immediately, not when the access token expires.
  if (!isActive) await tokenService.revokeEverySession(user._id);
  if (wasActive !== isActive) {
    await recordAccountChange(actor, user, 'active', String(wasActive), String(isActive));
  }

  return serializeUser(user);
}
