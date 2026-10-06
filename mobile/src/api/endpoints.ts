import { del, get, getPaged, patch, post, put } from './client';
import type {
  Address,
  AuthResult,
  Cart,
  Category,
  CheckoutResult,
  DashboardSummary,
  Order,
  OrderStatus,
  Pagination,
  Product,
  ProductFilters,
  ProductVisibility,
  RatingSummary,
  RazorpayHandle,
  Review,
  User,
  WholesaleStatus,
} from './types';

/** Every backend route the app talks to, typed in one place. */

export interface UploadedImage {
  url: string;
  publicId: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
}

export interface StoreConfig {
  currency: string;
  /**
   * The *default* COD shipping charge in paise (PRD 4.4).
   *
   * COD is priced per delivery state, so this only applies to a state the
   * store has not configured. Once an address is chosen the real figure comes
   * from `orderApi.codOptions`.
   */
  codShippingCharge: number;
  /** The default COD availability for an unconfigured state. */
  codDefaultEnabled?: boolean;
  /**
   * True when the API prices COD per state. Optional because a server that
   * predates the feature omits it — the checkout screen then falls back to the
   * single default charge above rather than asking for per-address options.
   */
  codPerStateSupported?: boolean;
  /**
   * The *default* prepaid shipping charge in paise.
   *
   * Used only against a server that does not price prepaid shipping per state
   * (`prepaidPerStateSupported` absent). Otherwise the real figure comes from
   * `orderApi.codOptions`, like the COD one.
   */
  prepaidShippingCharge: number;
  /**
   * True when the API prices PREPAID shipping per state. Optional because a
   * server that predates the feature omits it — the checkout screen then
   * falls back to the single default charge above.
   */
  prepaidPerStateSupported?: boolean;
  /**
   * COD customers pay the shipping/COD charge online (Razorpay) before the
   * order is confirmed, and only the items in cash. Absent on older servers.
   */
  codShippingPaidOnline?: boolean;
  razorpayEnabled: boolean;
  razorpayKeyId: string | null;
  /**
   * True when the API understands "Buy now". Optional because a server that
   * predates the feature simply omits it — and that server would silently
   * check out the whole cart, so its absence has to block the order.
   */
  buyNowSupported?: boolean;
}

export const configApi = {
  get: () => get<StoreConfig>('/config'),
};

/* ── Auth (PRD 4.1 / 8.7) ───────────────────────────────────────────────── */

/**
 * Proof the owner is present, for actions that can take an account away:
 * the password for a password account, a freshly minted Google ID token for
 * a Google-only one (the server refuses one older than five minutes).
 */
export type ReauthProof = { password?: string; googleIdToken?: string };

export interface RoleChange {
  id: string;
  actorEmail?: string;
  targetEmail?: string;
  action: 'role' | 'active';
  from: string;
  to: string;
  at: string;
}

export const authApi = {
  register: (input: {
    email: string;
    password: string;
    name?: string;
    accountType?: 'retail' | 'wholesale';
    deviceId?: string;
  }) => post<AuthResult>('/auth/register', input),

  login: (input: { email: string; password: string; deviceId?: string }) =>
    post<AuthResult>('/auth/login', input),

  /** Exchanges a native Google ID token for the same session a password login gets. */
  google: (input: { idToken: string; deviceId?: string }) =>
    post<AuthResult>('/auth/google', input),

  /**
   * Always resolves with the same generic message, registered or not — the
   * server will not confirm whether an address has an account.
   */
  forgotPassword: (email: string) =>
    post<{ message: string }>('/auth/forgot-password', { email }),

  /** Step 2 of reset — exchanges the emailed code for a short-lived token. */
  verifyResetOtp: (input: { email: string; otp: string }) =>
    post<{ resetToken: string; expiresInSeconds: number }>('/auth/verify-reset-otp', input),

  resetPassword: (input: { token: string; password: string }) =>
    post<{ message: string }>('/auth/reset-password', input),

  refresh: (refreshToken: string) => post<AuthResult>('/auth/refresh', { refreshToken }),

  logout: (refreshToken: string) => post<{ message: string }>('/auth/logout', { refreshToken }),

  me: () => get<User>('/auth/me'),

  /** Name only — the email changes through requestEmailCode → confirmEmailCode. */
  updateProfile: (input: { name?: string }) => patch<User>('/auth/me', input),

  /**
   * Emails a 6-digit code to `email`: the current address to verify it, or a
   * new one to change to it. Nothing changes until confirmEmailCode.
   */
  requestEmailCode: (email: string, proof: ReauthProof) =>
    post<{ email: string; purpose: 'verify' | 'change'; expiresInMinutes: number }>(
      '/auth/email/request-code',
      { email, ...proof },
    ),

  /** Applies the verified email and returns a fresh session (others are revoked on a change). */
  confirmEmailCode: (input: { otp: string; deviceId?: string } & ReauthProof) =>
    post<AuthResult & { changed: boolean }>('/auth/email/confirm', input),

  /** Signs this account out on every device at once. */
  logoutAll: () => post<{ message: string }>('/auth/logout-all'),

  /**
   * Permanently deletes the account (Play policy). Needs the same proof of the
   * owner as an email change; refused while an order is still open.
   */
  deleteAccount: (proof: ReauthProof) => del<{ message: string }>('/auth/me', proof),

  applyForWholesale: (input: { businessName?: string; gstNumber?: string; shopProofUrl?: string }) =>
    post<User>('/auth/wholesale/apply', input),

  listAddresses: () => get<Address[]>('/auth/addresses'),
  addAddress: (input: Omit<Address, 'id' | 'isDefault'> & { isDefault?: boolean }) =>
    post<Address[]>('/auth/addresses', input),
  updateAddress: (id: string, input: Partial<Omit<Address, 'id'>>) =>
    patch<Address[]>(`/auth/addresses/${id}`, input),
  deleteAddress: (id: string) => del<Address[]>(`/auth/addresses/${id}`),
};

/* ── Catalog (PRD 4.2) ──────────────────────────────────────────────────── */

export const productApi = {
  list: (params: ProductFilters & { page?: number; limit?: number; includeInactive?: boolean }) =>
    getPaged<Product[]>('/products', { params }),

  detail: (id: string) => get<Product>(`/products/${id}`),

  categories: (includeInactive = false) =>
    get<Category[]>('/products/categories', { params: { includeInactive } }),

  create: (input: {
    name: string;
    description: string;
    category: string;
    images?: string[];
    /** Required unless visibility is 'wholesale'. */
    retailPrice?: number;
    /** Required unless visibility is 'retail'. */
    wholesalePrice?: number;
    stock: number;
    sku?: string;
    tags?: string[];
    isActive?: boolean;
    visibility?: ProductVisibility;
  }) => post<Product>('/products', input),

  update: (
    id: string,
    input: Partial<{
      name: string;
      description: string;
      category: string;
      images: string[];
      retailPrice: number;
      wholesalePrice: number;
      stock: number;
      sku: string;
      tags: string[];
      isActive: boolean;
      visibility: ProductVisibility;
    }>,
  ) => patch<Product>(`/products/${id}`, input),

  remove: (id: string) => del<{ message: string }>(`/products/${id}`),

  /* ── Reviews ─────────────────────────────────────────────────────────── */

  reviews: (productId: string, page = 1, limit = 10) =>
    getPaged<{ items: Review[]; summary: RatingSummary }>(`/products/${productId}/reviews`, {
      params: { page, limit },
    }),

  /** Creates or replaces the signed-in customer's review for this product. */
  submitReview: (productId: string, input: { rating: number; comment?: string }) =>
    post<Review>(`/products/${productId}/reviews`, input),

  deleteReview: (productId: string) =>
    del<{ message: string }>(`/products/${productId}/reviews`),

  /**
   * PRD 8.3 — uploads go to Cloudinary via the backend, which returns the
   * secure URLs that get saved onto the product document.
   */
  uploadImages: async (
    files: Array<{ uri: string; name: string; type: string }>,
  ): Promise<UploadedImage[]> => {
    const form = new FormData();
    files.forEach((file) => {
      // React Native's FormData takes this {uri,name,type} shape, not a Blob.
      form.append('images', file as unknown as Blob);
    });

    // Content-Type is deliberately cleared, not set.
    //
    // A multipart body can only be parsed with the `boundary=...` parameter
    // React Native generates from the FormData. Sending a bare
    // "multipart/form-data" suppressed it, and every upload died server-side
    // with 500 "Multipart: Boundary not found" before reaching Cloudinary.
    // Clearing it drops the client's JSON default so the runtime writes the
    // complete header, boundary included.
    return post<UploadedImage[]>('/products/images', form, {
      headers: { 'Content-Type': undefined },
      timeout: 60_000,
    });
  },

  createCategory: (input: { name: string; description?: string; image?: string; sortOrder?: number }) =>
    post<Category>('/products/categories', input),

  updateCategory: (id: string, input: Partial<{ name: string; description: string; isActive: boolean }>) =>
    patch<Category>(`/products/categories/${id}`, input),

  deleteCategory: (id: string) => del<{ message: string }>(`/products/categories/${id}`),
};

/* ── Cart & wishlist (PRD 4.2 / 4.3) ────────────────────────────────────── */

export const cartApi = {
  get: () => get<Cart>('/cart'),
  add: (productId: string, quantity = 1) => post<Cart>('/cart/items', { productId, quantity }),
  updateQuantity: (productId: string, quantity: number) =>
    patch<Cart>(`/cart/items/${productId}`, { quantity }),
  remove: (productId: string) => del<Cart>(`/cart/items/${productId}`),
  clear: () => del<{ message: string }>('/cart'),
};

export const wishlistApi = {
  list: () => get<Product[]>('/wishlist'),
  toggle: (productId: string) =>
    post<{ wishlisted: boolean; items: Product[] }>(`/wishlist/${productId}/toggle`),
};

/* ── Orders (PRD 4.4 / 4.5) ─────────────────────────────────────────────── */

/** What each payment method costs for one saved address. */
export interface CodOptions {
  addressId: string;
  /** The state on the address, exactly as the customer typed it. */
  state: string;
  codEnabled: boolean;
  /** Integer paise. Only meaningful when codEnabled is true. */
  codCharge: number;
  /**
   * Integer paise: shipping on a prepaid (online) order to this state,
   * already resolved against the store default. Independent of codEnabled.
   */
  prepaidShippingCharge: number;
  /** True when no rule matched this state and the store default applied. */
  usingDefault: boolean;
}

export const orderApi = {
  /**
   * Asked once per address at checkout time, so the COD line shows this
   * state's charge rather than a figure baked into the app. The server
   * re-derives the same numbers when the order is placed, so a stale or
   * tampered answer here cannot change what is billed.
   */
  /** Re-opens payment for one of your orders still awaiting it (closed sheet, failed attempt). */
  paymentHandle: (orderId: string) => get<RazorpayHandle>(`/orders/${orderId}/payment`),

  codOptions: (addressId: string) =>
    get<CodOptions>('/orders/cod-options', { params: { addressId } }),

  checkout: (input: {
    addressId: string;
    paymentMethod: 'razorpay' | 'cod';
    /** "Buy now" — order this product alone and leave the saved cart untouched. */
    buyNow?: { productId: string; quantity: number };
  }) => post<CheckoutResult>('/orders/checkout', input),

  confirmPayment: (input: {
    orderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }) => post<Order>('/orders/payment/confirm', input),

  listMine: (page = 1, limit = 20) =>
    getPaged<Order[]>('/orders', { params: { page, limit } }),

  detail: (id: string) => get<Order>(`/orders/${id}`),

  cancel: (id: string, reason?: string) => post<Order>(`/orders/${id}/cancel`, { reason }),
};

/* ── Admin panel (PRD 4.7 / 8.9) ────────────────────────────────────────── */

export const adminApi = {
  dashboard: () => get<DashboardSummary>('/admin/dashboard'),

  listOrders: (params: { page?: number; limit?: number; status?: OrderStatus; search?: string }) =>
    getPaged<Order[]>('/admin/orders', { params }),

  orderDetail: (id: string) => get<Order>(`/admin/orders/${id}`),

  /** Sends (or re-sends) the refund for a cancelled order that was paid online. Admin only. */
  retryRefund: (id: string) => post<Order>(`/admin/orders/${id}/refund`),

  updateOrderStatus: (id: string, status: OrderStatus, note?: string) =>
    patch<Order>(`/admin/orders/${id}/status`, { status, note }),

  listWholesale: (params: { status?: WholesaleStatus; page?: number; limit?: number }) =>
    getPaged<User[]>('/admin/wholesale', { params }),

  reviewWholesale: (userId: string, decision: 'approved' | 'rejected', reason?: string) =>
    post<User>(`/admin/wholesale/${userId}/review`, { decision, reason }),

  listUsers: (params: { accountType?: string; search?: string; page?: number; limit?: number }) =>
    getPaged<User[]>('/admin/users', { params }),

  /** Retail or staff only — admin comes from the ADMIN_EMAILS list, never from here. */
  setRole: (userId: string, accountType: 'retail' | 'staff') =>
    patch<User>(`/admin/users/${userId}/role`, { accountType }),

  setActive: (userId: string, isActive: boolean) =>
    patch<User>(`/admin/users/${userId}/active`, { isActive }),

  /** Who changed whose role or activation, newest first. */
  roleChanges: () => get<RoleChange[]>('/admin/role-changes'),

  /* ── COD settings, per state (PRD 4.4 / 6) ───────────────────────────── */

  listCodConfig: () => get<CodConfigListing>('/admin/cod-config'),

  /**
   * Creates or replaces one state's rule. The state travels in the path, so it
   * is encoded here — several of them contain spaces.
   */
  saveCodConfig: (
    state: string,
    input: {
      codEnabled: boolean;
      codCharge: number;
      /**
       * Integer paise, or null to follow the store default. OMIT the key
       * entirely to leave the saved amount untouched — which is what this
       * screen does against a server without `prepaidPerStateSupported`.
       */
      prepaidCharge?: number | null;
    },
  ) => put<CodStateConfig>(`/admin/cod-config/${encodeURIComponent(state)}`, input),

  /** Drops the override so the state falls back to the store defaults. */
  deleteCodConfig: (state: string) =>
    del<{ state: string; codEnabled: boolean; codCharge: number; prepaidCharge: number }>(
      `/admin/cod-config/${encodeURIComponent(state)}`,
    ),
};

/** One state's shipping rule as the admin screen shows it. */
export interface CodStateConfig {
  state: string;
  codEnabled: boolean;
  /** Integer paise. */
  codCharge: number;
  /**
   * Integer paise: prepaid (online) shipping, already resolved against the
   * store default. Absent from a server that predates per-state prepaid
   * pricing.
   */
  prepaidCharge?: number;
  /** True when this state has no prepaid amount of its own. */
  prepaidUsingDefault?: boolean;
  /** False for a state listed from the catalogue with no rule of its own. */
  configured: boolean;
  updatedAt?: string;
}

export interface CodConfigListing {
  /** What an unconfigured state falls back to (from the server's env). */
  defaults: { codEnabled: boolean; codCharge: number; prepaidCharge?: number };
  /** Only the states the store has actually set. */
  configured: CodStateConfig[];
  /**
   * Every state to render: the catalogue merged with its rule (or the
   * default), plus any configured state outside the catalogue.
   */
  states: CodStateConfig[];
}

export type { Pagination };
