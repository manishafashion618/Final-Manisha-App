import { Types } from 'mongoose';
import { Order } from '../models/order.model';
import { Product } from '../models/product.model';
import { Review, type IReview } from '../models/review.model';
import { User } from '../models/user.model';
import { ApiError } from '../utils/ApiError';

export interface SerializedReview {
  id: string;
  rating: number;
  comment?: string;
  verifiedPurchase: boolean;
  /** The customer's name, or "Customer" when they have not set one. */
  author: string;
  /** True for the signed-in viewer's own review, so the client can offer edit. */
  mine: boolean;
  createdAt: string;
}

export interface RatingSummary {
  average: number;
  count: number;
  /** Counts per star, index 0 = 1★ … index 4 = 5★. Drives the histogram. */
  breakdown: [number, number, number, number, number];
}

/**
 * The name shown publicly on a review: the customer's own name, or "Customer".
 *
 * Never any part of a phone number. The last four digits used to stand in for
 * a missing name, which put personal data on a public page and contradicted
 * the privacy policy ("shown publicly with your name"). The phone is not even
 * loaded for reviews any more.
 */
function displayName(user: { name?: string } | null | undefined): string {
  return user?.name?.trim() || 'Customer';
}

function serialize(
  review: IReview & { userId?: unknown },
  viewerId?: string,
): SerializedReview {
  const populated = review.userId as { _id?: Types.ObjectId; name?: string } | null;
  const authorId = populated?._id?.toString() ?? String(review.userId);

  return {
    id: review._id.toString(),
    rating: review.rating,
    ...(review.comment ? { comment: review.comment } : {}),
    verifiedPurchase: review.verifiedPurchase,
    author: displayName(populated),
    mine: Boolean(viewerId && authorId === viewerId),
    createdAt: review.createdAt.toISOString(),
  };
}

/** Ratings for one product, computed rather than denormalised onto Product. */
export async function summaryFor(productId: string): Promise<RatingSummary> {
  const rows = await Review.aggregate<{ _id: number; count: number }>([
    { $match: { productId: new Types.ObjectId(productId) } },
    { $group: { _id: '$rating', count: { $sum: 1 } } },
  ]);

  const breakdown: RatingSummary['breakdown'] = [0, 0, 0, 0, 0];
  let total = 0;
  let weighted = 0;

  for (const row of rows) {
    const star = Math.min(5, Math.max(1, row._id));
    breakdown[star - 1] = row.count;
    total += row.count;
    weighted += star * row.count;
  }

  return {
    // One decimal is all the UI shows; keeping it here avoids every caller
    // rounding differently.
    average: total === 0 ? 0 : Math.round((weighted / total) * 10) / 10,
    count: total,
    breakdown,
  };
}

/** Summaries for many products at once — one query for a whole catalogue page. */
export async function summariesFor(
  productIds: string[],
): Promise<Map<string, { average: number; count: number }>> {
  const result = new Map<string, { average: number; count: number }>();
  if (productIds.length === 0) return result;

  const rows = await Review.aggregate<{ _id: Types.ObjectId; avg: number; count: number }>([
    { $match: { productId: { $in: productIds.map((id) => new Types.ObjectId(id)) } } },
    { $group: { _id: '$productId', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);

  for (const row of rows) {
    result.set(row._id.toString(), {
      average: Math.round(row.avg * 10) / 10,
      count: row.count,
    });
  }
  return result;
}

export interface ReviewListResult {
  items: SerializedReview[];
  summary: RatingSummary;
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
}

export async function listForProduct(
  productId: string,
  page: number,
  limit: number,
  viewerId?: string,
): Promise<ReviewListResult> {
  const exists = await Product.exists({ _id: productId });
  if (!exists) throw ApiError.notFound('Product not found');

  const skip = (page - 1) * limit;
  const [items, total, summary] = await Promise.all([
    Review.find({ productId })
      .populate('userId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec(),
    Review.countDocuments({ productId }),
    summaryFor(productId),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    items: items.map((item) => serialize(item, viewerId)),
    summary,
    pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
  };
}

/**
 * True when this customer has a delivered order containing the product. Only a
 * completed purchase counts — an order still in flight can be cancelled.
 */
async function hasPurchased(userId: string, productId: string): Promise<boolean> {
  const order = await Order.exists({
    userId,
    orderStatus: 'delivered',
    'items.productId': productId,
  });
  return Boolean(order);
}

export async function upsertReview(
  productId: string,
  userId: string,
  input: { rating: number; comment?: string },
): Promise<SerializedReview> {
  const product = await Product.exists({ _id: productId });
  if (!product) throw ApiError.notFound('Product not found');

  const verifiedPurchase = await hasPurchased(userId, productId);

  // An omitted comment clears a previous one rather than silently keeping text
  // the customer thinks they removed. Clearing has to be an explicit $unset:
  // Mongoose strips undefined values out of an update, so `comment: undefined`
  // inside $set is dropped and the old text survives the edit.
  const comment = input.comment?.trim();

  const review = await Review.findOneAndUpdate(
    { productId, userId },
    comment
      ? { $set: { rating: input.rating, verifiedPurchase, comment } }
      : { $set: { rating: input.rating, verifiedPurchase }, $unset: { comment: '' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  const author = await User.findById(userId).select('name');
  return serialize(
    Object.assign(review, { userId: author }) as IReview,
    userId,
  );
}

export async function deleteReview(productId: string, userId: string): Promise<void> {
  const result = await Review.deleteOne({ productId, userId });
  if (result.deletedCount === 0) throw ApiError.notFound('You have not reviewed this product');
}
