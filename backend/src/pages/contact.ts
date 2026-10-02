import { BUSINESS } from './business';
import { page } from './layout';

/** /contact — who runs the shop and how to reach them. */
export function renderContact(): string {
  return page(
    'Contact',
    `
<h1>Contact</h1>
<div class="card">
<p><strong>${BUSINESS.brand}</strong><br>
Proprietor: ${BUSINESS.proprietor}<br>
${BUSINESS.address}</p>
<p>Email: <a href="mailto:${BUSINESS.email}">${BUSINESS.email}</a><br>
Phone / WhatsApp: <a href="${BUSINESS.whatsappUrl}">${BUSINESS.phone}</a></p>
</div>
`,
  );
}
