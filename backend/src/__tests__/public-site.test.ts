import fs from 'fs';
import path from 'path';
import { clearTestDb, connectTestDb, disconnectTestDb, request } from './helpers/testServer';
import { Category } from '../models/category.model';
import { Product } from '../models/product.model';
import { HOME_PRODUCT_LIMIT } from '../pages/home';
import { REFUND_POLICY_TEXT, SHIPPING_POLICY_TEXT } from '../pages/policyDocuments';
import { listRetailShowcase } from '../repositories/product.repository';

/**
 * The public website Razorpay checks before activating live payments: the
 * home page with the live catalogue (retail prices only), contact details,
 * the refund and shipping policies word for word from docs/, and one footer
 * across every public page.
 */
beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

/** The page text as a reader sees it: tags gone, entities decoded, whitespace collapsed. */
function readable(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

let seq = 0;
async function product(fields: Record<string, unknown>) {
  seq += 1;
  const category = await Category.create({ name: `Category ${seq}`, slug: `category-${seq}` });
  return Product.create({ description: 'A test piece.', category: category._id, stock: 5, isActive: true, ...fields });
}

describe('GET /', () => {
  it('is public, script-free HTML about the shop', async () => {
    const res = await request.get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).not.toMatch(/<script/i);
    const text = readable(res.text);
    expect(text).toContain('Jewellery and fashion accessories from Puducherry');
    expect(text).toContain('Orders are placed in our Android app.');
  });

  it('lets product photos load from Cloudinary, and still no scripts', async () => {
    const csp = (await request.get('/')).headers['content-security-policy'];
    expect(csp).toMatch(/img-src 'self' data: https:\/\/res\.cloudinary\.com/);
    expect(csp).toContain("script-src 'self'");
  });

  it('lists active retail products with image, name and retail price', async () => {
    await product({
      name: 'Kundan Jhumka',
      images: ['https://res.cloudinary.com/demo/image/upload/jhumka.jpg'],
      visibility: 'both',
      retailPrice: 150_000,
      wholesalePrice: 120_000,
    });
    await product({ name: 'Pearl Choker', images: [], visibility: 'retail', retailPrice: 249_950 });
    await product({ name: 'Trade Bangle Box', images: [], visibility: 'wholesale', wholesalePrice: 77_700 });
    await product({ name: 'Retired Anklet', images: [], visibility: 'both', retailPrice: 90_000, wholesalePrice: 80_000, isActive: false });

    const res = await request.get('/');
    const text = readable(res.text);
    expect(text).toContain('Kundan Jhumka ₹1,500');
    expect(text).toContain('Pearl Choker ₹2,499.50');
    expect(res.text).toContain('<img src="https://res.cloudinary.com/demo/image/upload/jhumka.jpg" alt="Kundan Jhumka"');
    // Wholesale-only and inactive products are not on sale to retail customers.
    expect(text).not.toContain('Trade Bangle Box');
    expect(text).not.toContain('Retired Anklet');
  });

  it('never shows a wholesale price', async () => {
    await product({ name: 'Temple Necklace', images: [], visibility: 'both', retailPrice: 150_000, wholesalePrice: 123_457 });
    await product({ name: 'Bulk Studs', images: [], visibility: 'wholesale', wholesalePrice: 45_678 });

    const res = await request.get('/');
    for (const wholesale of ['123457', '1,234.57', '1234.57', '45678', '456.78']) {
      expect(res.text).not.toContain(wholesale);
    }
    expect(readable(res.text)).toContain('Temple Necklace ₹1,500');
    // Never even read from the database for this page.
    const rows = await listRetailShowcase(10);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['images', 'name', 'retailPrice', 'visibility']);
  });

  it('escapes product names and drops image addresses that are not https or this site', async () => {
    await product({
      name: '<script>alert(1)</script> Ring',
      images: ['javascript:alert(1)'],
      visibility: 'retail',
      retailPrice: 10_000,
    });
    const res = await request.get('/');
    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).not.toContain('javascript:');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Ring');
  });

  it('says so when nothing is listed', async () => {
    expect(readable((await request.get('/')).text)).toContain('No products are listed right now.');
  });

  it(`lists at most ${HOME_PRODUCT_LIMIT} and points to the app for the rest`, async () => {
    const category = await Category.create({ name: 'Rings', slug: 'rings-many' });
    await Product.insertMany(
      Array.from({ length: HOME_PRODUCT_LIMIT + 1 }, (_, i) => ({
        name: `Ring ${i}`,
        description: 'A test piece.',
        category: category._id,
        stock: 1,
        isActive: true,
        visibility: 'retail',
        retailPrice: 10_000 + i,
      })),
    );
    const res = await request.get('/');
    expect(res.text.match(/<li class="product">/g)).toHaveLength(HOME_PRODUCT_LIMIT);
    expect(readable(res.text)).toContain('More pieces are in the app.');
  });
});

describe('GET /contact', () => {
  it('gives the business, proprietor, address, email and a WhatsApp link', async () => {
    const res = await request.get('/contact');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/<script/i);
    const text = readable(res.text);
    for (const line of [
      'Manisha Fashions',
      'Proprietor: Uma Maheswari',
      'B-39, Gaffour Nagar Extn, Sree Nivas Garden, Manjalai Road, Kakaayanthope, Ariankuppam, Puducherry 605007',
      'Email: manishafashion618@gmail.com',
      'Phone / WhatsApp: +91 80561 14501',
    ]) {
      expect(text).toContain(line);
    }
    expect(res.text).toContain('<a href="https://wa.me/918056114501">+91 80561 14501</a>');
    expect(res.text).toContain('<a href="mailto:manishafashion618@gmail.com">');
  });
});

describe.each([
  ['/refund-policy', 'refund-policy.md', REFUND_POLICY_TEXT],
  ['/shipping-policy', 'shipping-policy.md', SHIPPING_POLICY_TEXT],
])('GET %s', (route, file, served) => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', file), 'utf8');

  it(`serves exactly docs/${file} (paste the file into pages/policyDocuments.ts when it changes)`, () => {
    expect(served).toBe(source);
  });

  it('shows every line of it, word for word', async () => {
    const res = await request.get(route);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).not.toMatch(/<script/i);
    const text = readable(res.text);
    const lines = source.split('\n').filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(text).toContain(line.replace(/^- /, '').trim());
    expect(readable(res.text.match(/<h1>.*<\/h1>/)![0]).trim()).toBe(lines[0]);
  });
});

describe('the footer', () => {
  const EXPECTED = [
    ['/', 'Home'],
    ['/contact', 'Contact'],
    ['/refund-policy', 'Refund & cancellation'],
    ['/shipping-policy', 'Shipping & delivery'],
    ['/privacy-policy', 'Privacy policy'],
    ['/terms', 'Terms'],
    ['/account-deletion', 'Delete your account'],
  ];

  it.each([
    '/',
    '/contact',
    '/refund-policy',
    '/shipping-policy',
    '/privacy-policy',
    '/terms',
    '/account-deletion',
    '/no-such-page-7f3k',
  ])('on %s links every public page, in order', async (route) => {
    const footer = (await request.get(route)).text.match(/<footer>([\s\S]*?)<\/footer>/)?.[1] ?? '';
    const links = [...footer.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(([, href, label]) => [
      href,
      readable(label).trim(),
    ]);
    expect(links).toEqual(EXPECTED);
  });
});

describe('the privacy policy', () => {
  it('names courier partners among the service providers', async () => {
    expect(readable((await request.get('/privacy-policy')).text)).toContain('and our courier partners (delivery)');
  });
});
