import { BUSINESS } from './business';
import { page } from './layout';

/**
 * Terms of service, drafted from how the store actually works (pricing tiers,
 * payment, cash on delivery, cancellation and refunds). A draft for the client
 * to confirm, not legal advice: the [CONFIRM WITH CLIENT] values come from
 * business.ts.
 */
export function renderTerms(): string {
  return page(
    'Terms of service',
    `
<h1>Terms of service</h1>
<p class="meta">Last updated ${BUSINESS.termsDate}</p>

<p>These terms apply when you use the ${BUSINESS.brand} app to browse and buy jewellery from
<strong>${BUSINESS.legalName}</strong> ("we", "us"). By creating an account or placing an order you
agree to them.</p>

<h2>Your account</h2>
<ul>
  <li>Keep your password private. You are responsible for orders placed from your account.</li>
  <li>Give accurate contact and delivery details, so we can reach you and deliver your order.</li>
  <li>You can delete your account at any time from the app, under Account → Delete account.</li>
</ul>

<h2>Prices and wholesale accounts</h2>
<ul>
  <li>Prices are in Indian Rupees and include the charges shown at checkout.</li>
  <li>Wholesale prices are available only to trade customers we have approved. We may approve or
  decline an application at our discretion.</li>
  <li>The price you pay is the one confirmed when the order is placed, even if it changes later.</li>
</ul>

<h2>Payment and cash on delivery</h2>
<ul>
  <li>Online payments are processed by Razorpay. We never see or store your card or UPI details.</li>
  <li>For cash on delivery, the shipping charge is paid online before the order is confirmed. The
  item amount is paid in cash when the order is delivered.</li>
  <li>An order is placed only once any online payment it needs has gone through. An unpaid order is
  released after a short time.</li>
</ul>

<h2>Cancellations and refunds</h2>
<ul>
  <li>You can cancel an order that has not yet been paid from the app.</li>
  <li>Once an order is paid, a cancellation is a request that the store reviews. If it is
  cancelled, the amount paid online is refunded to your original payment method, usually within
  5–7 working days.</li>
  <li>Orders that have shipped cannot be cancelled; please contact us about a return.</li>
</ul>

<h2>Delivery</h2>
<p>We deliver to the address you choose at checkout. Delivery times are estimates. Please check
your order carefully on arrival and contact us promptly about any problem.</p>

<h2>Reviews</h2>
<p>Reviews must be honest and about the product. We may remove reviews that are abusive,
misleading or unrelated.</p>

<h2>Changes and governing law</h2>
<p>We may update these terms; the date above shows the latest version. These terms are governed by
the laws of India. [CONFIRM WITH CLIENT: courts of which city have jurisdiction.]</p>

<h2>Contact</h2>
<p>${BUSINESS.legalName}<br>${BUSINESS.address}<br>
Email: ${BUSINESS.email}<br>Phone: ${BUSINESS.phone}</p>
`,
  );
}
