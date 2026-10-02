import { FilterQuery, type SortOrder, type Types } from 'mongoose';
import { Product, type IProduct } from '../models/product.model';

/**
 * Write shape accepted from the service layer. `category` arrives as a string
 * id from the request body; Mongoose casts it to an ObjectId on save.
 */
export type ProductWriteInput = Omit<Partial<IProduct>, 'category'> & {
  category?: string | Types.ObjectId;
};

/**
 * Repository layer (PRD 8.6) — the only place that talks to the Product
 * collection. Services stay free of query syntax.
 */

export interface ProductQuery {
  page: number;
  limit: number;
  category?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  sort: 'newest' | 'price_asc' | 'price_desc' | 'name_asc';
  includeInactive?: boolean;
  inStockOnly?: boolean;
  /**
   * Which storefront the viewer is browsing. 'all' (staff and admin) applies no
   * visibility filter; otherwise only products marked for that storefront —
   * or for both — are returned.
   */
  storefront?: 'retail' | 'wholesale' | 'all';
}

export interface PaginatedProducts {
  items: IProduct[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

/**
 * The price field a viewer is shown, so sorting and the price filter work on
 * the figure on their screen. It also keeps wholesale-only products, which
 * have no retail price, from sorting and filtering as if priced at nothing.
 */
function priceFieldFor(storefront: ProductQuery['storefront']): 'retailPrice' | 'wholesalePrice' {
  return storefront === 'wholesale' ? 'wholesalePrice' : 'retailPrice';
}

function sortFor(query: ProductQuery): Record<string, SortOrder> {
  const priceField = priceFieldFor(query.storefront);
  switch (query.sort) {
    case 'price_asc':
      return { [priceField]: 1 };
    case 'price_desc':
      return { [priceField]: -1 };
    case 'name_asc':
      return { name: 1 };
    default:
      return { createdAt: -1 };
  }
}

function buildFilter(query: ProductQuery): FilterQuery<IProduct> {
  const filter: FilterQuery<IProduct> = {};

  if (!query.includeInactive) filter.isActive = true;
  if (query.category) filter.category = query.category;

  // Retail-only products stay out of the wholesale storefront and vice versa.
  // Enforced here, in the query, so a product the viewer may not see is never
  // loaded — not merely hidden after the fact.
  if (query.storefront && query.storefront !== 'all') {
    filter.visibility = { $in: ['both', query.storefront] };
  }
  if (query.inStockOnly) filter.stock = { $gt: 0 };

  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    const range: { $gte?: number; $lte?: number } = {};
    if (query.minPrice !== undefined) range.$gte = query.minPrice;
    if (query.maxPrice !== undefined) range.$lte = query.maxPrice;
    filter[priceFieldFor(query.storefront)] = range;
  }

  if (query.search) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    filter.$or = [{ name: pattern }, { description: pattern }, { tags: pattern }];
  }

  return filter;
}

export async function findPaginated(query: ProductQuery): Promise<PaginatedProducts> {
  const filter = buildFilter(query);
  const skip = (query.page - 1) * query.limit;

  const [items, total] = await Promise.all([
    Product.find(filter)
      .populate('category', 'name slug')
      .sort(sortFor(query))
      .skip(skip)
      .limit(query.limit)
      .exec(),
    Product.countDocuments(filter),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    items,
    total,
    page: query.page,
    limit: query.limit,
    totalPages,
    hasMore: query.page < totalPages,
  };
}

export async function findById(id: string): Promise<IProduct | null> {
  return Product.findById(id).populate('category', 'name slug').exec();
}

export async function findManyByIds(ids: string[]): Promise<IProduct[]> {
  return Product.find({ _id: { $in: ids } })
    .populate('category', 'name slug')
    .exec();
}

export async function create(data: ProductWriteInput): Promise<IProduct> {
  const product = await Product.create(data);
  return product.populate('category', 'name slug');
}

export async function updateById(
  id: string,
  data: ProductWriteInput,
  unset: Array<'retailPrice' | 'wholesalePrice'> = [],
): Promise<IProduct | null> {
  const update = {
    $set: data,
    ...(unset.length > 0 ? { $unset: Object.fromEntries(unset.map((field) => [field, 1])) } : {}),
  };
  return Product.findByIdAndUpdate(id, update, { new: true, runValidators: true })
    .populate('category', 'name slug')
    .exec();
}

export async function deleteById(id: string): Promise<IProduct | null> {
  return Product.findByIdAndDelete(id).exec();
}

/**
 * Atomically decrements stock only if enough remains, so two concurrent
 * checkouts cannot oversell the same piece.
 */
export async function decrementStock(id: string, quantity: number): Promise<boolean> {
  const result = await Product.updateOne(
    { _id: id, stock: { $gte: quantity } },
    { $inc: { stock: -quantity } },
  );
  return result.modifiedCount === 1;
}

export async function incrementStock(id: string, quantity: number): Promise<void> {
  await Product.updateOne({ _id: id }, { $inc: { stock: quantity } });
}

export async function findLowStock(threshold: number, limit = 20): Promise<IProduct[]> {
  return Product.find({ isActive: true, stock: { $lte: threshold } })
    .sort({ stock: 1 })
    .limit(limit)
    .populate('category', 'name slug')
    .exec();
}

export async function countAll(includeInactive = false): Promise<number> {
  return Product.countDocuments(includeInactive ? {} : { isActive: true });
}

/** What the public home page shows of a product, and nothing more. */
export type ShowcaseProduct = Pick<IProduct, 'name' | 'images' | 'retailPrice' | 'visibility'>;

/**
 * Products on sale to retail customers (the same rule as the retail
 * storefront), newest first. Only the fields the page shows are loaded: the
 * wholesale price never leaves the database.
 */
export async function listRetailShowcase(limit: number): Promise<ShowcaseProduct[]> {
  return Product.find({ isActive: true, visibility: { $in: ['both', 'retail'] } })
    .select({ _id: 0, name: 1, images: 1, retailPrice: 1, visibility: 1 })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<ShowcaseProduct[]>()
    .exec();
}
