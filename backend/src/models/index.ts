import type { Model } from 'mongoose';
import { Cart } from './cart.model';
import { Category } from './category.model';
import { CodStateConfig } from './codStateConfig.model';
import { KvEntry } from './kvEntry.model';
import { Order } from './order.model';
import { Product } from './product.model';
import { RateLimitHit } from './rateLimitHit.model';
import { RefreshToken } from './refreshToken.model';
import { Review } from './review.model';
import { RoleChange } from './roleChange.model';
import { User } from './user.model';
import { Wishlist } from './wishlist.model';

/**
 * Every model, for scripts that act on all of them (scripts/dbIndexes.ts).
 * A new model must be added here, or its indexes are never built in
 * production — autoIndex is off there (config/database.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_MODELS: Array<Model<any>> = [
  User,
  Product,
  Category,
  Cart,
  Wishlist,
  Order,
  Review,
  RefreshToken,
  CodStateConfig,
  KvEntry,
  RateLimitHit,
  RoleChange,
];
