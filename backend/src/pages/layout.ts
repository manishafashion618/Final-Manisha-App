import { BUSINESS } from './business';

/**
 * A plain, mobile-first HTML shell for the public pages.
 *
 * No JavaScript at all: helmet's Content-Security-Policy forbids inline
 * scripts, and nothing here needs one — every action is an ordinary form
 * post. Styles are inline (the CSP allows that) and use the app's own palette
 * so the pages read as the same store.
 */

/** Escapes text for HTML. Anything a visitor typed must go through this. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · ${BUSINESS.brand}</title>
<style>
  :root {
    --primary: #E71B4C; --bg: #F5F5F7; --surface: #FFFFFF;
    --text: #1D1D1F; --muted: #6E6E73; --faint: #86868B;
    --border: rgba(0,0,0,0.08); --success: #34A853; --warning: #B26A00;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 680px; margin: 0 auto; padding: 32px 16px 64px; }
  .brand { color: var(--primary); font-weight: 700; letter-spacing: .04em; margin: 0 0 4px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; }
  h2 { font-size: 19px; margin: 32px 0 8px; }
  p, li { color: var(--muted); }
  strong { color: var(--text); }
  ul { padding-left: 20px; }
  .meta { color: var(--faint); font-size: 14px; }
  .card, .deletion-form {
    background: var(--surface); border-radius: 16px; padding: 20px;
    margin: 20px 0; border: 1px solid var(--border);
  }
  label { display: block; font-weight: 600; margin: 12px 0 6px; color: var(--text); }
  input[type=email], input[type=text] {
    width: 100%; font: inherit; padding: 12px 14px; border-radius: 12px;
    border: 1px solid var(--border); background: var(--bg); color: var(--text);
  }
  .check, .checkbox { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; color: var(--muted); }
  .check input, .checkbox input { margin-top: 5px; }
  button {
    margin-top: 16px; width: 100%; font: inherit; font-weight: 600; padding: 14px;
    border: 0; border-radius: 999px; background: var(--primary); color: #FFF; cursor: pointer;
  }
  /* The destructive action reads darker than an ordinary button. */
  button.danger { background: #B3123A; }
  .notice { border-radius: 12px; padding: 12px 14px; margin: 16px 0; }
  .notice.ok { background: rgba(52,168,83,.1); color: #1E6B36; }
  .notice.warn { background: rgba(178,106,0,.1); color: var(--warning); }
  .notice-info { background: rgba(0,0,0,.05); color: var(--text); }
  .notice-error { background: rgba(231,27,76,.08); color: #B3123A; }
  a { color: var(--primary); }
  .products {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px; padding: 0; margin: 16px 0; list-style: none;
  }
  .product {
    background: var(--surface); border-radius: 16px; overflow: hidden;
    border: 1px solid var(--border);
  }
  .product img, .product .no-image {
    display: block; width: 100%; aspect-ratio: 1; object-fit: cover; background: var(--bg);
  }
  .product p { margin: 0; padding: 0 12px; }
  .product .name { color: var(--text); font-weight: 600; padding-top: 10px; line-height: 1.35; }
  .product .price { color: var(--text); padding-bottom: 12px; }
  footer { margin-top: 48px; font-size: 14px; color: var(--faint); }
</style>
</head>
<body>
<main>
<p class="brand">${BUSINESS.brand}</p>
${body}
<footer>
  <a href="/">Home</a> ·
  <a href="/contact">Contact</a> ·
  <a href="/refund-policy">Refund &amp; cancellation</a> ·
  <a href="/shipping-policy">Shipping &amp; delivery</a> ·
  <a href="/privacy-policy">Privacy policy</a> ·
  <a href="/terms">Terms</a> ·
  <a href="/account-deletion">Delete your account</a>
</footer>
</main>
</body>
</html>`;
}
