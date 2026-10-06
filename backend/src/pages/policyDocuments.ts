import { escapeHtml, page } from './layout';

/**
 * The refund & cancellation and shipping & delivery policies, word for word
 * from docs/refund-policy.md and docs/shipping-policy.md.
 *
 * Copied in because Render builds only backend/ (rootDir in render.yaml), so
 * the server cannot read docs/ at runtime. A test fails as soon as a copy and
 * its file differ: after editing a file in docs/, paste its text in here.
 *
 * The files are plain text in a fixed shape: a title line and a "Last
 * updated" line, then blocks separated by a blank line, each a heading line
 * followed by paragraph lines and "- " list items. They render to the same
 * structure as the other policy pages. The wording is only ever escaped.
 */
export const REFUND_POLICY_TEXT = `Refund & Cancellation Policy — Manisha Fashions
Last updated: 2 October 2026

Damaged items
We accept returns only for items that arrive damaged. To report damage:
- Contact us on WhatsApp at +91 80561 14501 within 48 hours of delivery.
- Send your order number and an unboxing video or clear photos showing the damage and the package.
After checking, we will offer a replacement or a full refund for the damaged item. We will tell you how to send it back, and we cover the return shipping cost for damaged items.

Items that cannot be returned
We do not accept returns or exchanges for change of mind, sizing or colour preference, or for damage reported more than 48 hours after delivery.

Refunds
Approved refunds are made to the original payment method within 5–7 working days after we receive the returned item. For Cash on Delivery orders, we refund to your bank account or UPI ID, which we will ask for on WhatsApp. Shipping and COD charges are refunded only when the item arrived damaged.

Cancellations
You can cancel an order before it is dispatched by contacting us on WhatsApp at +91 80561 14501. Prepaid amounts for cancelled orders are refunded within 5–7 working days. Once an order is dispatched, it cannot be cancelled.

Contact
Manisha Fashions, B-39, Gaffour Nagar Extn, Sree Nivas Garden, Manjalai Road, Kakaayanthope, Ariankuppam, Puducherry 605007
WhatsApp / Phone: +91 80561 14501 · Email: manishafashion618@gmail.com`;

export const SHIPPING_POLICY_TEXT = `Shipping & Delivery Policy — Manisha Fashions
Last updated: 2 October 2026

Where we ship
We deliver across India.

Dispatch and delivery times
Orders are dispatched within 1–3 working days of being placed. Delivery usually takes 3–7 working days after dispatch, depending on your location. Delays can happen during holidays, bad weather or courier disruptions.

Shipping charges
Shipping charges depend on the state you're delivering to and are shown at checkout before you pay. For Cash on Delivery orders, the shipping/COD charge for your state is paid online at checkout, and the product amount is paid in cash on delivery.

Courier
We ship through our courier partners. Once your order is dispatched, you can follow its status in the Manisha Fashions app under Orders.

Problems with delivery
If your order hasn't arrived within the expected time, or arrives damaged, contact us on WhatsApp at +91 80561 14501. For damaged items, see our Refund & Cancellation Policy.

Contact
Manisha Fashions, B-39, Gaffour Nagar Extn, Sree Nivas Garden, Manjalai Road, Kakaayanthope, Ariankuppam, Puducherry 605007
WhatsApp / Phone: +91 80561 14501 · Email: manishafashion618@gmail.com`;

export function renderPolicyDocument(text: string): string {
  const [head, ...sections] = text.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  const [title, ...meta] = head.split('\n');
  const body = [`<h1>${escapeHtml(title)}</h1>`, ...meta.map((line) => `<p class="meta">${escapeHtml(line)}</p>`)];

  for (const section of sections) {
    const [heading, ...lines] = section.split('\n');
    body.push(`\n<h2>${escapeHtml(heading)}</h2>`);
    let items: string[] = [];
    const endList = () => {
      if (items.length) body.push(`<ul>\n${items.join('\n')}\n</ul>`);
      items = [];
    };
    for (const line of lines) {
      if (line.startsWith('- ')) {
        items.push(`  <li>${escapeHtml(line.slice(2))}</li>`);
      } else {
        endList();
        body.push(`<p>${escapeHtml(line)}</p>`);
      }
    }
    endList();
  }

  // The tab title without the " — Manisha Fashions" the page adds anyway.
  return page(title.split(' — ')[0], `\n${body.join('\n')}\n`);
}
