import { page } from './layout';

/**
 * The 404 for a person in a browser (any GET outside /api). Deliberately does
 * not echo the address that was asked for: nothing a visitor typed is
 * reflected back into the page.
 */
export function renderNotFound(): string {
  return page(
    'Page not found',
    `
<h1>Page not found</h1>
<p>There's nothing at this address. You may be looking for:</p>
<ul>
  <li><a href="/account-deletion">Delete your account</a></li>
  <li><a href="/privacy-policy">Privacy policy</a></li>
</ul>
`,
  );
}
