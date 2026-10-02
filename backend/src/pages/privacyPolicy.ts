import { BUSINESS } from './business';
import { page } from './layout';

/**
 * Privacy policy — the client's text, served at /privacy-policy.
 *
 * Kept true to the code: where the client's draft differed from what the app
 * does, the wording was corrected to match (Google profile fields stored, IP
 * addresses in security logs, no order emails, MongoDB Atlas as the
 * database, the real menu path, what deletion keeps). If the app starts
 * collecting something new, this text must change with it.
 */
export function renderPrivacyPolicy(): string {
  return page(
    'Privacy policy',
    `
<h1>Privacy Policy</h1>
<p class="meta">Last updated: ${BUSINESS.privacyPolicyDate}</p>

<p>${BUSINESS.brand} ("we") runs the ${BUSINESS.brand} app (in.manishafashions.app). This policy
explains what we collect, why, and your choices.</p>

<h2>1. What we collect</h2>
<ul>
  <li><strong>Account:</strong> email address, optional name, and a password (stored hashed). If you
  sign in with Google, we store your Google account's email, name, profile photo and account ID
  instead of a password.</li>
  <li><strong>Orders:</strong> phone number, delivery address, and purchase history.</li>
  <li><strong>Wholesale accounts (optional):</strong> business name and GSTIN.</li>
  <li><strong>Reviews</strong> you post, which are shown publicly with your name.</li>
  <li><strong>Sign-in records:</strong> a device identifier stored with each session, used to keep
  your account secure.</li>
  <li><strong>Security logs:</strong> your IP address and app version, kept for up to 90 days to
  protect the service from abuse.</li>
  <li><strong>Staff only:</strong> product photos uploaded from the device's photo library.</li>
</ul>
<p>We do not collect location, contacts, messages or audio, and we do not use advertising
trackers.</p>

<h2>2. Payments</h2>
<p>Card, UPI and bank details are entered on Razorpay's checkout and are never seen or stored by
us. We pass your name, email and phone to Razorpay to pre-fill checkout.</p>

<h2>3. How we use it</h2>
<p>To create and secure your account, process and deliver orders, send verification codes and
account notices, and handle wholesale approval. We do not sell your data or share it for
advertising.</p>

<h2>4. Service providers</h2>
<p>We use Razorpay (payments), Cloudinary (product images), Google (sign-in), Render (hosting),
MongoDB Atlas (database) and Gmail (transactional email). They process data only to provide these
services to us.</p>

<h2>5. Security</h2>
<p>All data is encrypted in transit (HTTPS). Passwords are hashed. Sessions end immediately after
a password reset, email change or sign-out from all devices.</p>

<h2>6. Retention and deletion</h2>
<p>You can delete your account in the app (Account → Delete account) or at
<a href="/account-deletion">https://final-manisha-app.onrender.com/account-deletion</a>. Deleting
removes your account (email, name, profile photo, password, Google sign-in link, phone number and
saved addresses), your wholesale business details (business name and GSTIN), your wishlist and
cart, and all your signed-in sessions. Reviews you wrote stay, but are shown as "Customer" instead
of your name. Past orders are kept for 8 years for GST and income-tax records, with your name,
phone and street address removed; only city, state and PIN code remain. Deletion isn't available
while a delivery is in progress or a refund is still due.</p>
<p>Records of account role changes are kept for 3 years.</p>

<h2>7. Your rights</h2>
<p>You can access, correct or delete your personal data. Under India's Digital Personal Data
Protection Act, 2023, you may also raise a grievance with us.</p>

<h2>8. Children</h2>
<p>The app is not directed at children under 18.</p>

<h2>9. Contact</h2>
<p><a href="mailto:${BUSINESS.email}">${BUSINESS.email}</a></p>
`,
  );
}
