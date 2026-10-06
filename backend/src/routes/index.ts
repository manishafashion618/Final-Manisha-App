import { Router } from 'express';
import mongoose from 'mongoose';
import adminRoutes from './admin.routes';
import authRoutes from './auth.routes';
import cartRoutes from './cart.routes';
import orderRoutes from './order.routes';
import productRoutes from './product.routes';
import wishlistRoutes from './wishlist.routes';
import { authenticate } from '../middleware/authenticate';
import { cloudinaryConfigured, env, razorpayConfigured } from '../config/env';

const router = Router();

/** Liveness probe for Nginx / the platform health check. */
router.get('/health', (_req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    success: dbUp,
    data: {
      status: dbUp ? 'ok' : 'degraded',
      database: dbUp ? 'connected' : 'disconnected',
      integrations: {
        razorpay: razorpayConfigured,
        cloudinary: cloudinaryConfigured,
      },
      timestamp: new Date().toISOString(),
    },
  });
});

/**
 * Storefront settings the client needs before it can render a correct checkout
 * summary — the shipping charges in particular (PRD 4.4 / 6). Values are
 * server-owned so changing a fee does not require an app release.
 *
 * BOTH payment methods are now priced per delivery state, so the figures here
 * are only the fallback for a state the store has not configured. The charge
 * an order will actually carry comes from GET /orders/cod-options?addressId=…
 * once an address is chosen, and checkout re-derives it server-side
 * regardless.
 */
router.get('/config', authenticate, (_req, res) => {
  res.success({
    currency: env.CURRENCY,
    /** Default only — see /orders/cod-options for the address's real charge. */
    codShippingCharge: env.COD_SHIPPING_CHARGE,
    codDefaultEnabled: env.COD_DEFAULT_ENABLED,
    /** True when this server prices COD per state. */
    codPerStateSupported: true,
    /**
     * COD customers pay the shipping/COD charge online before the order is
     * confirmed, and only the items in cash. Absent on older servers.
     */
    codShippingPaidOnline: env.COD_SHIPPING_PAID_ONLINE,
    /** Default only — see /orders/cod-options for the address's real charge. */
    prepaidShippingCharge: env.PREPAID_SHIPPING_CHARGE,
    /**
     * True when this server prices PREPAID shipping per state too. The client
     * then takes the figure from /orders/cod-options rather than the default
     * above, which is the only way its total can match what Razorpay charges.
     */
    prepaidPerStateSupported: true,
    razorpayEnabled: razorpayConfigured,
    razorpayKeyId: razorpayConfigured ? env.RAZORPAY_KEY_ID : null,
    /**
     * Advertises that /orders/checkout understands `buyNow`. A server that
     * predates the feature strips the unknown field and bills the whole cart
     * instead, which the client cannot detect from the response — so it asks
     * first and refuses to place the order when this is missing.
     */
    buyNowSupported: true,
  });
});

router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/cart', cartRoutes);
router.use('/wishlist', wishlistRoutes);
router.use('/orders', orderRoutes);
router.use('/admin', adminRoutes);

export default router;
