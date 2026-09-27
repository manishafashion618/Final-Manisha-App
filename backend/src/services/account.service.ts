import { getStore } from '../config/store';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { Cart } from '../models/cart.model';
import { Order } from '../models/order.model';
import { RoleChange } from '../models/roleChange.model';
import { User, type IUser } from '../models/user.model';
import { Wishlist } from '../models/wishlist.model';
import { ApiError } from '../utils/ApiError';
import { isAdminEmail, requireRecentAuth } from './auth.service';
import * as emailService from './email.service';
import * as orderService from './order.service';
import * as passwordService from './password.service';
import * as tokenService from './token.service';

/**
 * Account deletion (Google Play policy): in the app, and from a public web
 * page for someone who no longer has the app.
 *
 * "Deleted" means anonymised, not removed. The user row stays as an empty
 * shell because orders point at it, and orders are kept because the store
 * needs them for its accounts and tax records. Everything that identifies the
 * person goes: name, email, phone, photo, Google link, password, saved
 * addresses, cart and wishlist, and the name, phone and street on past
 * orders. Their reviews stay, shown as "Customer".
 *
 * What is kept on an order is the city, state and PIN code — the place of
 * supply a GST record needs — plus the items, amounts and dates.
 */

/** What replaces the personal parts of an order's delivery address. */
const ANONYMISED_ADDRESS = {
  'shippingAddress.fullName': 'Deleted customer',
  'shippingAddress.phone': 'removed',
  'shippingAddress.line1': 'removed',
};

export const OPEN_ORDER_MESSAGE =
  'You have an order that is still being delivered, or a payment the store has not yet ' +
  'settled or refunded. Please contact the store to close it, then delete your account.';

export const ADMIN_ACCOUNT_MESSAGE =
  "This is a store administrator account and can't be deleted here. Remove the address " +
  'from ADMIN_EMAILS first, then delete it.';

/**
 * Refuses a deletion that would lose something the store still needs.
 *
 * Wider than "paid but not delivered": ANY delivery still under way blocks
 * it, paid or not. A cash-on-delivery parcel in transit would otherwise be
 * heading to an address that has just been erased.
 */
async function assertDeletable(user: IUser): Promise<void> {
  // The admin set is governed by ADMIN_EMAILS. An admin deleting their own
  // account here would leave that list pointing at an address nobody holds —
  // exactly the unclaimed-admin-address hole the audit closed.
  if (user.accountType === 'admin' || isAdminEmail(user.email)) {
    throw ApiError.forbidden(ADMIN_ACCOUNT_MESSAGE);
  }

  const open = await Order.exists({
    userId: user._id,
    $or: [
      { orderStatus: { $in: ['placed', 'processing', 'shipped'] } },
      // Cancelled but the money not yet returned — the refund is still owed.
      { paymentStatus: 'paid', orderStatus: { $ne: 'delivered' } },
    ],
  });
  if (open) throw ApiError.conflict(OPEN_ORDER_MESSAGE);
}

/** The shared erase, used by the app and the web page alike. */
async function eraseAccount(user: IUser): Promise<void> {
  await assertDeletable(user);

  // An unpaid order is not an order yet. Cancelled now, so its stock comes
  // back and a payment completed later cannot quietly place it for an
  // account that no longer exists (a late capture on a cancelled order is
  // refunded automatically).
  const unpaid = await Order.find({ userId: user._id, orderStatus: 'pending_payment' }).select('_id');
  for (const order of unpaid) {
    await orderService.cancelMyOrder(user._id.toString(), order._id.toString(), 'Account deleted');
  }

  const userId = user._id;

  await User.updateOne(
    { _id: userId },
    {
      $set: {
        addresses: [],
        authProviders: [],
        emailVerified: false,
        isActive: false,
        accountType: 'retail',
        wholesaleStatus: 'none',
        deletedAt: new Date(),
      },
      $unset: {
        name: 1,
        email: 1,
        phone: 1,
        avatar: 1,
        googleId: 1,
        passwordHash: 1,
        pendingEmail: 1,
        emailCodeHash: 1,
        emailCodeExpiresAt: 1,
        passwordResetOtpHash: 1,
        passwordResetOtpExpiresAt: 1,
        passwordResetTokenHash: 1,
        passwordResetTokenExpiresAt: 1,
        business: 1,
        wholesaleReview: 1,
        lastAuthAt: 1,
      },
    },
  );

  // Signs every device out on its next request, and kills refresh tokens.
  await tokenService.revokeEverySession(userId);

  await Promise.all([
    Cart.deleteOne({ userId }),
    Wishlist.deleteOne({ userId }),
    Order.updateMany({ userId }, { $set: ANONYMISED_ADDRESS, $unset: { 'shippingAddress.line2': 1 } }),
    // The trail keeps who-did-what by id; the email snapshot is personal data.
    RoleChange.updateMany({ targetId: userId }, { $unset: { targetEmail: 1 } }),
    RoleChange.updateMany({ actorId: userId }, { $unset: { actorEmail: 1 } }),
  ]);

  logger.info(`Account ${userId.toString()} deleted and anonymised.`);
}

/**
 * In-app deletion. Demands the credential itself — the same proof as an
 * email change — because a signed-in phone is not proof of the owner.
 */
export async function deleteOwnAccount(
  userId: string,
  proof: { password?: string; googleIdToken?: string },
): Promise<void> {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || user.deletedAt) throw ApiError.notFound('Account not found');
  await requireRecentAuth(user, proof);
  await eraseAccount(user);
}

/* ── The public web page: delete by emailed code ──────────────────────── */

const CODE_KEY = (email: string) => `acctdel:code:${email}`;
const QUOTA_KEY = (email: string) => `acctdel:quota:${email}`;
const ATTEMPT_KEY = (email: string) => `acctdel:attempts:${email}`;
const LOCK_KEY = (email: string) => `acctdel:lock:${email}`;
const MAX_CODES_PER_HOUR = 3;

const normalise = (email: string) => email.trim().toLowerCase();

/**
 * Emails a 6-digit code when an account uses this address.
 *
 * Says nothing about whether one does: the caller shows the same page either
 * way, and the bcrypt work is done either way, so neither the response nor
 * its timing tells a visitor which addresses are registered.
 */
export async function requestDeletionCode(rawEmail: string): Promise<void> {
  const email = normalise(rawEmail);
  const store = getStore();

  // Counted for every address, registered or not, so the quota is not a
  // signal either.
  const sent = await store.incr(QUOTA_KEY(email));
  if (sent === 1) await store.expire(QUOTA_KEY(email), 3600);
  if (sent > MAX_CODES_PER_HOUR) return;

  const otp = await passwordService.createResetOtp();
  const user = await User.findOne({ email, deletedAt: { $exists: false } }).select('_id');
  if (!user) return;

  await store.set(CODE_KEY(email), otp.codeHash, env.PASSWORD_RESET_OTP_TTL_MINUTES * 60);
  await store.del(ATTEMPT_KEY(email));
  // Not awaited: waiting on SMTP would make a registered address measurably slower.
  void Promise.resolve()
    .then(() =>
      emailService.sendAccountDeletionCode({
        to: email,
        code: otp.code,
        expiresInMinutes: env.PASSWORD_RESET_OTP_TTL_MINUTES,
      }),
    )
    .catch(() => undefined);
}

/** Checks the code and, if it is right, deletes the account. */
export async function confirmDeletionByCode(rawEmail: string, code: string): Promise<void> {
  const email = normalise(rawEmail);
  const store = getStore();

  if (await store.get(LOCK_KEY(email))) {
    throw ApiError.tooManyRequests(
      `Too many incorrect codes. Please request a new code in ${env.PASSWORD_RESET_LOCKOUT_MINUTES} minutes.`,
    );
  }

  const codeHash = await store.get(CODE_KEY(email));
  const matches = codeHash ? await passwordService.verifyResetOtp(code, codeHash) : false;

  if (!matches) {
    const attempts = await store.incr(ATTEMPT_KEY(email));
    if (attempts === 1) await store.expire(ATTEMPT_KEY(email), env.PASSWORD_RESET_OTP_TTL_MINUTES * 60);
    if (attempts >= env.PASSWORD_RESET_MAX_ATTEMPTS) {
      await store.set(LOCK_KEY(email), '1', env.PASSWORD_RESET_LOCKOUT_MINUTES * 60);
      // Burned as well, so waiting out the lock does not reopen it.
      await store.del(CODE_KEY(email));
      await store.del(ATTEMPT_KEY(email));
    }
    throw ApiError.badRequest('That code is not correct, or it has expired. Please request a new one.');
  }

  // Single use, whatever happens next.
  await store.del(CODE_KEY(email));
  await store.del(ATTEMPT_KEY(email));

  const user = await User.findOne({ email, deletedAt: { $exists: false } });
  if (!user) throw ApiError.notFound('No account uses this email address any more.');
  await eraseAccount(user);
}
