/**
 * Runs the real API against an in-memory MongoDB.
 *
 * For demoing or trying the app when there is no Mongo/Docker available.
 * Data is discarded when the process exits — never use this for anything real.
 *
 * Run with: npm run dev:memory
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

async function main(): Promise<void> {
  const mongod = await MongoMemoryServer.create();

  // Must be set before anything imports config/env.ts.
  process.env.NODE_ENV = 'development';
  process.env.MONGODB_URI = mongod.getUri('manisha_dev');
  process.env.JWT_ACCESS_SECRET =
    process.env.JWT_ACCESS_SECRET ?? 'dev-only-access-secret-0123456789abcdef';
  process.env.JWT_REFRESH_SECRET =
    process.env.JWT_REFRESH_SECRET ?? 'dev-only-refresh-secret-0123456789abcdef';
  // COD shipping is paid online only when Razorpay (test) keys are present;
  // without them COD would be impossible to place locally.
  process.env.COD_SHIPPING_PAID_ONLINE =
    process.env.COD_SHIPPING_PAID_ONLINE ?? (process.env.RAZORPAY_KEY_ID ? 'true' : 'false');
  // Throwaway in-memory data: a known password is fine here, and nowhere else.
  process.env.SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'DevMemory123';
  // The seeded admin keeps admin at sign-in only if listed (and verified, below).
  const seedEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@manishafashions.in').toLowerCase();
  if (!(process.env.ADMIN_EMAILS ?? '').toLowerCase().split(',').map((e) => e.trim()).includes(seedEmail)) {
    process.env.ADMIN_EMAILS = [process.env.ADMIN_EMAILS, seedEmail].filter(Boolean).join(',');
  }

  const { createApp } = await import('../app');
  const { connectScriptDatabase } = await import('../config/database');
  const { initStore } = await import('../config/store');
  const { env } = await import('../config/env');
  const { logger } = await import('../config/logger');

  initStore();
  await connectScriptDatabase();

  // Reuse the seed data so the catalogue is not empty on first launch.
  const { Category, slugify } = await import('../models/category.model');
  const { Product } = await import('../models/product.model');
  const { User } = await import('../models/user.model');

  const categories = [
    { name: 'Necklaces', sortOrder: 1 },
    { name: 'Earrings', sortOrder: 2 },
    { name: 'Bangles & Bracelets', sortOrder: 3 },
    { name: 'Rings', sortOrder: 4 },
    { name: 'Bridal Sets', sortOrder: 5 },
  ];

  const ids = new Map<string, string>();
  for (const entry of categories) {
    const category = await Category.create({ ...entry, slug: slugify(entry.name) });
    ids.set(entry.name, category._id.toString());
  }

  const rupees = (amount: number) => Math.round(amount * 100);
  const products = [
    ['Kundan Bridal Necklace Set', 'Bridal Sets', 4999, 3250, 12],
    ['Temple Jhumka Earrings', 'Earrings', 1299, 820, 45],
    ['American Diamond Choker', 'Necklaces', 2499, 1650, 20],
    ['Oxidised Silver Bangle Set', 'Bangles & Bracelets', 899, 540, 60],
    ['Pearl Drop Danglers', 'Earrings', 749, 430, 80],
    ['Rose Gold Solitaire Ring', 'Rings', 649, 380, 3],
    ['Antique Lakshmi Coin Haram', 'Necklaces', 3799, 2450, 8],
    ['Meenakari Kada Pair', 'Bangles & Bracelets', 1599, 990, 2],
  ] as const;

  await Product.insertMany(
    products.map(([name, category, retail, wholesale, stock]) => ({
      name,
      description: `${name} — handcrafted piece from the Manisha Fashions collection.`,
      category: ids.get(category),
      images: [],
      retailPrice: rupees(retail),
      wholesalePrice: rupees(wholesale),
      stock,
      tags: [],
      isActive: true,
    })),
  );

  const { hashPassword } = await import('../services/password.service');
  const admin = await User.create({
    email: env.SEED_ADMIN_EMAIL,
    name: 'Store Admin',
    accountType: 'admin',
    emailVerified: true,
    passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD as string),
    authProviders: ['password'],
  });

  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info('─'.repeat(58));
    logger.info(`In-memory API ready → http://localhost:${env.PORT}${env.API_PREFIX}`);
    logger.info(`Admin sign-in: ${admin.email} / ${env.SEED_ADMIN_PASSWORD}`);
    logger.info('Password-reset codes are printed here when SMTP is unset.');
    logger.info('Data is discarded on exit.');
    logger.info('─'.repeat(58));
  });

  const shutdown = async () => {
    await mongod.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('Failed to start the in-memory API', error);
  process.exit(1);
});
