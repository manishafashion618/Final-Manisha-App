import type { ShowcaseProduct } from '../repositories/product.repository';
import { tierPriceOf } from '../utils/productPricing';
import { escapeHtml, page } from './layout';

/**
 * GET / — the shop's public front page: what it sells, the live retail
 * catalogue, and where orders are placed. Retail prices only: the product
 * list never carries a wholesale price (see listRetailShowcase).
 */

/** How many products the page lists; any more are in the app. */
export const HOME_PRODUCT_LIMIT = 60;

const wholeRupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const exactRupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

/** Integer paise as rupees: ₹1,500, or ₹1,500.50 when there are paise. */
export function formatRupees(paise: number): string {
  return (paise % 100 ? exactRupees : wholeRupees).format(paise / 100);
}

/** Only an https:// image or one served by this site; anything else is dropped. */
function imageUrl(url: string | undefined): string | null {
  if (!url) return null;
  return /^https:\/\//i.test(url) || /^\/(?!\/)/.test(url) ? url : null;
}

function productCard(product: ShowcaseProduct, price: number): string {
  const name = escapeHtml(product.name);
  const image = imageUrl(product.images?.[0]);
  return `<li class="product">
  ${image ? `<img src="${escapeHtml(image)}" alt="${name}" loading="lazy">` : '<div class="no-image"></div>'}
  <p class="name">${name}</p>
  <p class="price">${formatRupees(price)}</p>
</li>`;
}

/** `products` may hold one more than the limit: that only says there are more. */
export function renderHome(products: ShowcaseProduct[]): string {
  const priced = products
    .map((product) => ({ product, price: tierPriceOf(product, 'retail') }))
    .filter((entry): entry is { product: ShowcaseProduct; price: number } => typeof entry.price === 'number');
  const shown = priced.slice(0, HOME_PRODUCT_LIMIT);

  const list = shown.length
    ? `<ul class="products">\n${shown.map(({ product, price }) => productCard(product, price)).join('\n')}\n</ul>` +
      (priced.length > shown.length ? '\n<p>More pieces are in the app.</p>' : '')
    : '<p>No products are listed right now. Please check back soon.</p>';

  return page(
    'Jewellery and fashion accessories',
    `
<h1>Jewellery and fashion accessories from Puducherry</h1>

<div class="card">
<p><strong>Orders are placed in our Android app.</strong> Questions? <a href="/contact">Contact us</a>.</p>
</div>

<h2>Our products</h2>
${list}
`,
  );
}
