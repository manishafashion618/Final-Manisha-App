# Manisha Fashions — Final Production Release Check

Run 2026-09-27 · repo `6c062de` · backend live at `final-manisha-app.onrender.com`
Evidence: 199 backend tests, 14 mobile tests, 64 smoke checks, 126 audit checks, a release
APK built and run on an emulator, and read-only probes of production.

---

## 1. VERDICT: **NO-GO** for Play Store — **GO WITH CONDITIONS** for the backend

The software is in good shape: 403 automated checks pass, nothing fails, no secret is in
the repo, history or app bundle, and every audit finding traceable to a commit is
re-verified closed. **Nothing found here is a flaw in the code you wrote.**

The blockers are release-mechanics and policy: the APK is **signed with the Android debug
key** (Play rejects it), **account deletion and a privacy policy do not exist** (Play
requires both), and **production MongoDB has never had its indexes built** — the unique
constraints that stop duplicate accounts are, as far as anyone can prove, not there.

---

## 2. LAUNCH BLOCKERS — the minimum to fix

| # | Blocker | Why it stops launch | Effort |
|---|---|---|---|
| **B-1** | No in-app account deletion, no web deletion URL | Google Play **rejects** apps with accounts and no deletion path. Needs a route, a screen and a public web page | **M** |
| **B-2** | No privacy policy URL; the text on Login is not a link | Play requires a live policy URL reachable in incognito, linked in-app | **S** |
| **B-3** | Production indexes never built (`autoIndex: !isProduction`, `database.ts:35`) | Without `users.email` unique, **two accounts can share an email** — with `ADMIN_EMAILS` granting admin by address, that is an escalation path. TTL indexes also absent, so lockout rows never reap | **S** — run `npm run db:indexes --apply` |
| **B-4** | APK signed with the **debug** key (`build.gradle:112-115`) | Play refuses debug-signed uploads. Also: sign-in will break for Play installs unless the upload key **and** Play App Signing SHA-1s are both registered | **M** |

**Conditions for the backend** (already live, safe to keep running):

| # | Condition |
|---|---|
| **C-1** | The brief names `fresh-manisha/main` as the deploy source. It is **4 commits behind** and still has the F1 admin-escalation hole. Render actually deploys `origin/main`. Confirm which is canonical; sync or retire the other |
| **C-3** | Razorpay is in **TEST** mode. Before launch: live keys, a **new** Live-mode webhook, and that webhook's own secret — all three together |
| **C-4** | Verify `ADMIN_EMAILS` holds only addresses you control (an unclaimed one was flagged earlier). Anyone signing in as a listed address gets full admin |
| **C-5** | Set Render's Health Check Path to `/health` so a hung instance is restarted |

---

## 3. SECURITY FINDINGS

| ID | Severity | Title | Evidence | Impact in plain words | Fix | Effort |
|---|---|---|---|---|---|---|
| **S-1** | **MEDIUM** | Access token survives password reset / email change | `grep tokenVersion` → none; `env.ts:35` TTL 30m; `authenticate.ts:30-45` | Someone who stole a session keeps access for up to 30 minutes *after* the victim changes their password — the exact moment a victim acts | Add `tokenVersion`, embed in the token, compare in `authenticate`, bump on reset/email/role/deactivate | **S** |
| **S-2** | **MEDIUM** | `allowBackup="true"` in the APK | `AndroidManifest.xml` | Android may copy app data to the user's Drive; `adb backup` can extract it | `expo.android.allowBackup: false`, re-prebuild | **S** |
| **S-3** | **MEDIUM** | 4 unjustified permissions shipped | `aapt2 dump badging` | `RECORD_AUDIO` + `SYSTEM_ALERT_WINDOW` draw Play review scrutiny and must be justified in Data Safety. The app uses none of them | `expo.android.blockedPermissions` | **S** |
| **S-4** | **LOW** | No NoSQL-injection / mass-assignment regression tests | `grep '\$ne'` in tests → none | None today — `validate.ts:27` replaces the body with zod's parsed output, stripping undeclared keys and rejecting operator objects. Risk is a future regression going unnoticed | One test per route family | **S** |
| **S-5** | **LOW** | 3 high advisories in mobile deps | `npm audit` | Build-time only (`@xmldom/xmldom`, `image-size`, `js-yaml`); none ships in the bundle | `npm audit fix` when convenient | **S** |
| **S-6** | **LOW** | IDOR sweep incomplete | Cross-user tests exist for orders/addresses only | Deleting *another user's* review is untested | One cross-user test per `:id` route | **M** |

**Verified secure** (no action): HS256 pinned · forged Razorpay signatures and webhooks
rejected (**live-probed**: 401/`INVALID_SIGNATURE`, fails closed) · payment replay
idempotent · rate limits and lockouts survive restart · no login/forgot-password
enumeration · CORS deny-all in production · full security headers, no `x-powered-by` ·
no stack traces · **no secrets in repo, git history or the app bundle** · tests physically
cannot reach production or real third-party accounts.

---

## 4. NOT VERIFIED — what I need from you

| # | Item | What's needed |
|---|---|---|
| NV-1 | Google Sign-In on a device | A real Google account on a phone |
| NV-2 | Old address notified on email change | A test inbox, or a new test |
| NV-3 | Cloudinary images load | A device; tests run with Cloudinary unset by design |
| NV-4 | Deleting another user's review | A new test (**S-6**) |
| NV-5 | Cart survives app restart | Device |
| NV-6 | Razorpay TEST payment end to end | Someone to drive the payment sheet (script in §6) |
| NV-7 | Cold start, offline, long-backgrounded | Device against a cold Render instance |
| NV-8 | Dashboard "Refunds due" counter | A new test |
| NV-9 | Staff promotion is logged | A new test |
| NV-10 | COD Save button + unsaved-changes warning | Screen tests, or manual |
| NV-11 | Duplicate emails / COD rows in production | The `manisha-maint` URI (`~/.manisha-maint-uri`) — read-only check |
| NV-12 | **Audit findings F4, F5, F6, F7, F15** | No commit references them and no report is in the repo. **Send me the original audit** |
| NV-13 | `CORS_ORIGINS` value | Render dashboard |
| NV-14 | `ADMIN_EMAILS` contents | Render dashboard (**C-4**) |
| NV-15 | Always-on plan | Render dashboard |
| NV-16 | Mongo user is least-privilege | Atlas dashboard |
| NV-17 | Backups enabled | Atlas dashboard |
| NV-18 | A real email sends via Gmail SMTP | A test inbox |
| NV-19 | The 4 webhook events are the right 4 | Expand the row in Razorpay |
| NV-20 | Data Safety answers | Play Console |
| NV-21 | Content rating | Play Console |

---

## 5. MANUAL ON-PHONE TEST SCRIPT (~20 min)

Install `app-release.apk` on a real Android phone. Razorpay test card
**4111 1111 1111 1111**, any future expiry, any CVV.

**A. Cold start (2 min)** — Force-stop the app, turn off Wi-Fi and data, open it.
✅ A friendly message, **no crash**. Turn the network back on.
✅ It recovers without a restart. If the backend was idle, expect "Connecting to store…"
rather than an error.

**B. Google Sign-In (3 min)** — Tap *Continue with Google*, pick an account.
✅ You land in the catalogue. ⚠️ **If this fails with `DEVELOPER_ERROR`, the SHA-1 is not
registered** — the single most likely launch-day failure (**B-4**).
Sign out, sign back in with email + password.
✅ Both work for the same account.

**C. Prices (2 min)** — Browse as a retail customer.
✅ Only retail prices; no wholesale figure anywhere; wholesale-only products invisible.

**D. COD with online shipping — the new flow (6 min)** — Add ~₹2,000 of items, check out
to a **Tamil Nadu** address, choose Cash on delivery.
✅ The breakdown reads "pay online now ₹100" and "pay cash on delivery ₹2,000", and the
button says **Pay ₹100 & place order**.
Tap it. ✅ The Razorpay sheet asks for **₹100 only — not ₹2,100**. *(If it asks for the
full amount, stop and report.)*
**Now close the sheet without paying.** ✅ You return to checkout with *Try payment again*;
the order is **not** placed. ✅ Under My orders it shows **Awaiting payment** with
*Complete payment*.
Tap *Complete payment*, pay with the test card.
✅ Confirmation shows "Paid online · shipping ₹100" and "Pay on delivery ₹2,000".
✅ **In the Razorpay dashboard the webhook delivery log shows 200** for `payment.captured`
— this proves the secret matches and the safety net works.

**E. Admin (3 min)** — Sign in as admin, open the order.
✅ It reads `Shipping paid ₹100 online • Collect ₹2,000 cash on delivery`.
✅ An **Awaiting payment** filter exists and lists the abandoned order from step D.

**F. Background and resume (2 min)** — Background the app for 10+ minutes (or overnight),
then reopen.
✅ Still signed in, orders load — the refresh token rotated silently.

**G. Account deletion (1 min)** — Look for it under Account.
❌ **It will not be there.** Confirms **B-1**.

---

> **Note on the brief:** the brief says the backend deploys from `fresh-manisha/main`.
> It does not. Render service `Final-Manisha-App` deploys from **`origin/main`**
> (`github.com/manishafashion618/Final-Manisha-App`). `fresh-manisha/main` is at
> `3f21983`, **4 commits behind** and missing every audit fix. Evidence:
> `git branch -r -v`. Flagged as **C-1** in Section 5.

---


## SECTION 1: INVENTORY

### 1.1 Mobile screens (26)

**Auth (5)** — `mobile/src/screens/auth/`
| Screen | Test coverage |
|---|---|
| LoginScreen | backend only (`auth-hardening`, `google-auth`) |
| ForgotPasswordScreen | backend only (`password-reset`) |
| ResetOtpScreen | backend only (`password-reset`) |
| ResetPasswordScreen | backend only (`password-reset`) |
| WholesalePendingScreen | **none** |

**Customer (12)** — `mobile/src/screens/customer/`
| Screen | Test coverage |
|---|---|
| CatalogScreen | backend only (`product-pricing`) |
| FiltersScreen | **none** |
| ProductDetailScreen | backend only (`product-pricing`) |
| WishlistScreen | **none (backend route untested too)** |
| CartScreen | backend only (`cod-checkout`) |
| CheckoutScreen | backend only (`cod-checkout`, `cod-online-shipping`) |
| RazorpayCheckoutScreen | backend only (`payments`) |
| OrderConfirmationScreen | **none** |
| OrdersScreen | **none** |
| OrderDetailScreen | **none** |
| AddressesScreen | backend only (`cod-checkout`) |
| AddressFormScreen | backend only (state normalisation in `indian-states-sync`) |

**Admin (9)** — `mobile/src/screens/admin/`
| Screen | Test coverage |
|---|---|
| AdminDashboardScreen | backend only (`cod-online-shipping`) |
| AdminProductsScreen / AdminProductFormScreen | backend only (`product-pricing`) |
| AdminCategoriesScreen | **none (backend route untested too)** |
| AdminOrdersScreen / AdminOrderDetailScreen | backend only (`payments`, `cod-online-shipping`) |
| AdminUsersScreen | backend only (`admin-emails`) |
| AdminWholesaleScreen | **none (backend route untested too)** |
| AdminCodSettingsScreen | backend only (`cod-config`) |

**Mobile-side test suites total: 3 files / 14 tests** — `RootNavigator`, `api/client`, `utils/scrubPii`.
**No screen has a rendering or interaction test.** Every screen above is verified only
through its backend route, or not at all.

### 1.2 API routes (52) with auth + permission

Mount points (`src/routes/index.ts:67-72`): `/auth` `/products` `/cart` `/wishlist` `/orders` `/admin`, plus `/health`, `/config`, `/webhooks`.

**Public (no auth)**
| Method | Path | Guard | Tests |
|---|---|---|---|
| GET | `/health` | none | `health.test.ts` |
| POST | `/auth/register` | authLimiter, validate | 5 files |
| POST | `/auth/login` | authLimiter, validate | 5 files |
| POST | `/auth/google` | authLimiter, validate | 1 file |
| POST | `/auth/refresh` | authLimiter, validate | 4 files |
| POST | `/auth/logout` | validate | **0** |
| POST | `/auth/forgot-password` | authLimiter, validate | 4 files |
| POST | `/auth/verify-reset-otp` | authLimiter, validate | 4 files |
| POST | `/auth/reset-password` | authLimiter, validate | 3 files |
| POST | `/webhooks/razorpay` | **HMAC only, by design** | 2 files |
| GET | `/products`, `/products/:id`, `/products/categories`, `/products/:id/reviews` | optionalAuth | 2 files / **0** for categories+reviews |

**Authenticated (customer)**
| Method | Path | Permission | Tests |
|---|---|---|---|
| GET | `/config` | authenticate | indirect |
| GET/PATCH | `/auth/me` | authenticate | 2 files |
| POST | `/auth/email/request-code`, `/auth/email/confirm` | authenticate | 1 file |
| GET/POST/PATCH/DELETE | `/auth/addresses[/:id]` | authenticate | 1 file |
| POST | `/auth/wholesale/apply` | authenticate | **0** |
| GET/POST/PATCH/DELETE | `/cart[/items[/:productId]]` | CART_MANAGE (router-level, `cart.routes.ts:11`) | 2 files |
| GET/POST | `/wishlist[/:productId/toggle]` | WISHLIST_MANAGE (router-level, `wishlist.routes.ts:11`) | **0** |
| POST/DELETE | `/products/:id/reviews` | CATALOG_BROWSE | **0** |
| POST | `/orders/checkout` | ORDER_CREATE | 3 files |
| POST | `/orders/payment/confirm` | ORDER_CREATE | 2 files |
| GET | `/orders/cod-options` | ORDER_CREATE | 1 file |
| GET | `/orders`, `/orders/:id` | ORDER_READ_OWN | 2 files |
| GET | `/orders/:id/payment` | ORDER_CREATE | 1 file (`cod-online-shipping`) |
| POST | `/orders/:id/cancel` | ORDER_CANCEL_OWN | 2 files |

**Admin / staff** — all under `requirePermission`
| Method | Path | Permission | Tests |
|---|---|---|---|
| GET | `/admin/dashboard` | DASHBOARD_VIEW | 1 file |
| GET | `/admin/orders`, `/admin/orders/:id` | ORDER_READ_ALL | 2 files |
| POST | `/admin/orders/:id/refund` | ORDER_REFUND | 2 files |
| PATCH | `/admin/orders/:id/status` | ORDER_STATUS_UPDATE | 2 files |
| GET | `/admin/wholesale` | WHOLESALE_APPROVE | **0** |
| POST | `/admin/wholesale/:userId/review` | WHOLESALE_APPROVE | **0** |
| GET | `/admin/users` | USER_MANAGE | 1 file |
| PATCH | `/admin/users/:userId/role` | USER_MANAGE | 1 file |
| PATCH | `/admin/users/:userId/active` | USER_MANAGE | 1 file |
| GET/PUT/DELETE | `/admin/cod-config[/:state]` | COD_CONFIG_MANAGE | 3 files |
| POST/PATCH/DELETE | `/products[/:id]` | PRODUCT_MANAGE | 2 files |
| POST | `/products/images` | PRODUCT_MANAGE | 1 file |
| POST/PATCH/DELETE | `/products/categories[/:id]` | CATEGORY_MANAGE | **0** |

### 1.3 Findings

**I-1 — No account-deletion route or screen exists. LAUNCH BLOCKER (Play policy).**
Evidence: `grep -rn "delete-account|deleteAccount|/me/delete|account/delete"` across
`backend/src/routes/`, `backend/src/controllers/`, `mobile/src/api/endpoints.ts` → **no matches**.
No "delete account" UI anywhere in `mobile/src/screens/`.
Google Play requires apps with account creation to offer in-app account deletion **and**
a publicly reachable web deletion URL. Neither exists. Detail in Section 6.

**I-2 — Privacy policy is plain text, not a link. LAUNCH BLOCKER (Play policy).**
Evidence: `mobile/src/screens/auth/LoginScreen.tsx:219` — the string
"By continuing you agree to our terms of service and privacy policy" is rendered as
`<Text>`, with no URL and no press handler. No privacy link on the Account screen.
The brief expects links on **both** Login and Account.

**I-3 — Routes with zero backend test coverage (7).**
`POST /auth/logout`, `POST /auth/wholesale/apply`, `GET /admin/wholesale`,
`POST /admin/wholesale/:userId/review`, `/products/categories` (POST/PATCH/DELETE),
`/products/:id/reviews` (POST/DELETE), `/wishlist` (GET, toggle).
Wholesale approval is the notable one: it changes what prices a user sees, and is untested end to end.

**I-4 — No dead or hidden routes found.** Every backend route is reachable from
`mobile/src/api/endpoints.ts`. Cross-checked both directions; the only unreferenced
handler paths are the ones the app calls with interpolated ids. `DELETE /cart` (clear)
is wired at `endpoints.ts:241`. No debug, seed or admin-bootstrap endpoint is exposed.

**I-5 — Mobile has no screen-level tests at all.** 14 mobile tests cover the navigator,
the API client and the PII scrubber. Every UI behaviour in Sections 2–3 is therefore
verified through the backend only, or is NOT VERIFIED. This is the single largest
coverage gap in the project.

---

## SECTION 2: CUSTOMER FEATURES

Evidence sources, all run locally against mongodb-memory-server with a fake Razorpay:
- **J** = `npx jest` — **199 passed / 199**, 14 suites
- **S** = `npm run smoke` — **64/64 checks passed**
- **A** = `npm run audit` — **126/126 checks passed**

### 2.1 Auth

| Feature | Verdict | Evidence |
|---|---|---|
| Register (email+password) | **PASS** | S "register succeeds"; J `admin-emails` ×5 |
| Email verification | **PASS** | J "makes it admin once the address is verified by emailed code"; "emails a 6-digit code, not a link" |
| Login, wrong password → generic error | **PASS** | J "gives one login error for a wrong password, an unknown email and a Google-only account" |
| Google Sign-In (backend) | **PASS** | J `google-auth` ×10: new user, returning by googleId, unverified-email token → 401, invalid token → 401, missing idToken → 400 |
| Google linking, pre-hijack guard | **PASS** | J "links an existing VERIFIED email/password account and keeps its password"; "removes the password and revokes sessions when linking an UNVERIFIED account" |
| Google Sign-In **on device** | **NOT VERIFIED** | Needs a real Google account on a device; SHA-1 must be registered. See NV-1 |
| Logout | **PASS** | S "logout succeeds"; "refresh after logout is rejected server-side" |
| Logout invalidates tokens | **PASS** | S, as above (401 `REFRESH_TOKEN_INVALID`) |
| Forgot password → OTP → reset | **PASS** | J `password-reset` ×17 |
| OTP single use | **PASS** | J "consumes the code, so it cannot be verified twice" |
| OTP expiry | **PASS** | J "rejects an expired code" |
| Lockout after 5 wrong codes | **PASS** | J "counts wrong codes down and locks the email after 5"; "refuses the correct code once the email is locked out" |
| Old sessions revoked on reset | **PASS** | J "revokes existing sessions so other devices must sign in again" |
| Change email: re-auth + code to new address | **PASS** | J "requesting a code for a whitelisted address changes nothing until the code is confirmed"; "a guessed code does not apply the change" |
| Change email: old address notified | **NOT VERIFIED** | No test asserts the notification to the **old** address. See NV-2 |
| Token refresh + reuse detection | **PASS** | J "revokes the whole family when an already-rotated token is replayed"; "treats two simultaneous rotations of one token as reuse"; "leaves other sign-ins (other families) alone" |
| Old access token dead after **role change** | **PASS** | `authenticate.ts:30-45` re-loads the user and re-resolves permissions every request; J "demotes an admin that is not on ADMIN_EMAILS at the next refresh" |
| Old access token dead after **deactivation** | **PASS** | `authenticate.ts:36-38`; J "refuses a deactivated account and revokes all of its sessions"; A "a deactivated user is refused" |
| Old access token dead after **password reset / email change** | **FAIL** | See **S-1**. `tokenVersion` is not implemented (`grep -rn tokenVersion src/` → no matches); only refresh tokens are revoked, so a stolen access token stays valid up to `JWT_ACCESS_TTL` (30m, `env.ts:35`) |

### 2.2 Catalog

| Feature | Verdict | Evidence |
|---|---|---|
| Home / categories | **PASS** | A "category list returns an array"; "admin can create a category"; "admin can rename a category" |
| Listing: filters / search / sort / pagination | **PASS** | A "search returns a filtered list", "pagination meta has totalPages", "price-range filter responds 200", "sort=price_asc responds 200" |
| Product detail | **PASS** | A "guest can read a product detail" |
| Retail user sees retail price only | **PASS** | J "never shows a retail customer a wholesale-only product or any wholesale price"; A "wholesalePrice is stripped for a guest viewer" |
| Approved wholesale sees wholesale price | **PASS** | A "wholesalePrice is now visible to the wholesaler" |
| Pending wholesale sees retail | **PASS** | A "a pending wholesale account is blocked from browsing" + `WHOLESALE_NOT_APPROVED` code |
| Retail-only hidden from wholesale, and vice versa | **PASS** | A ×6 incl. "a direct link to a trade-only product 404s for a retail customer" and the reverse |
| Out-of-stock handling | **PASS** | J "expires only orders past the window, once, and restocks once"; A "dashboard reports low stock products" |
| Images load from Cloudinary | **NOT VERIFIED** | Tests deliberately run with Cloudinary unset — A "image upload fails cleanly (not 500) when Cloudinary is unconfigured". Production log says `Cloudinary configured`. See NV-3 |

### 2.3 Reviews, wishlist, cart, addresses

| Feature | Verdict | Evidence |
|---|---|---|
| Add review / update in place | **PASS** | A "a signed-in customer can post a review"; "re-reviewing updates in place, not duplicates" |
| Delete own review | **PASS** | A "a customer can delete their own review"; "deleting drops the count" |
| Cannot delete others' | **NOT VERIFIED** | A covers guest-cannot-post and own-delete, but no check deletes **another user's** review. See NV-4 / IDOR sweep S-6 |
| Review guards | **PASS** | A "a guest cannot post a review"; "a rating outside 1-5 is rejected" |
| Wishlist add/remove | **PASS** | A ×6 incl. "toggle on sets wishlisted=true", "toggle off sets wishlisted=false" |
| Cart add/remove/update qty | **PASS** | J `cod-checkout`; S cart checks |
| Quantity limits vs stock | **PASS** | J "refuses the order with a clear error and reserves no stock" |
| Cart drops products no longer sold to this user type | **PASS** | J "drops out of a wholesale cart instead of pricing it from nothing" |
| Cart survives app restart | **NOT VERIFIED** | Server-side cart persists; the device-side reload path is untested. See NV-5 |
| Addresses add/edit/delete | **PASS** | A ×9 incl. "exactly one address stays default" |
| State normalisation | **PASS** | J `indian-states-sync` ×10: "Tamilnadu", "TAMILNADU", "tamil-nadu", " Tamil  Nadu ", "TN", "t.n." all price as Tamil Nadu |
| Cannot use another user's address | **PASS** | J "cannot price an order against somebody else's address"; "will not answer for another customer's address" |

### 2.4 Checkout — ONLINE (Razorpay)

| Feature | Verdict | Evidence |
|---|---|---|
| Server re-prices; fake low total ignored | **PASS** | J "ignores a shippingCharge, codCharge or totalAmount sent in the body"; "returns a Razorpay order for exactly the state's charge and ignores client totals" |
| Success via app confirm | **PASS** | J "stays unconfirmed until the app confirms the payment" |
| Success via webhook, either order, no double processing | **PASS** | J "applies once when they arrive confirm first, then the webhook"; "applies once when they arrive the webhook first, then confirm" |
| Failed / sheet closed → not confirmed | **PASS** | J "keeps it unconfirmed after payment.failed, lets the customer retry, then expires it" |
| Expires after 30 min, releases stock | **PASS** | J "expires only orders past the window, once, and restocks once"; TTL `PENDING_PAYMENT_TTL_MINUTES` default 30 (`env.ts:143`) |
| Late capture after expiry → flagged + auto-refunded | **PASS** | J "refunds a capture that arrives by webhook after expiry, flagged for admin"; "refunds a capture confirmed by the app after expiry, and tells the customer" |
| Razorpay TEST mode end to end | **NOT VERIFIED** | Needs the payment sheet driven by hand. See NV-6 |

### 2.5 Checkout — COD (shipping prepaid online)

| Feature | Verdict | Evidence |
|---|---|---|
| Per-state charge correct (TN ₹100) | **PASS** | J "charges that state's figure, not the store default"; "agrees with what checkout actually charges" |
| State without override uses default | **PASS** | J "uses the default charge for a state with no rule, via the canonical state name"; "falls back to the store default" |
| Shipping charge paid online BEFORE confirmation | **PASS** | J "returns a Razorpay order for exactly the state's charge"; order created as `pending_payment` (`order.service.ts`), not `placed` |
| Breakdown: pay now vs pay on delivery | **PASS** | J "shows shipping paid online and the cash due, to both"; UI strings verified present in the release bundle (Section 6) |
| ₹0 shipping skips Razorpay | **PASS** | J "confirms at once without Razorpay, with everything due in cash"; "applies a zero charge when the state is configured as free COD" |
| Unpaid COD shipping expires, releases stock | **PASS** | J "expires an order whose sheet was simply closed (nothing ever arrives)"; "lets the customer cancel an unpaid one outright, releasing the stock" |
| Razorpay unavailable → refuses before reserving stock | **PASS** | J "refuses COD with a charge when Razorpay is unavailable, before reserving stock" |

### 2.6 Orders

| Feature | Verdict | Evidence |
|---|---|---|
| List/detail: statuses, amounts, refund status, due on delivery | **PASS** | J "shows shipping paid online and the cash due, to both" |
| Customer cancel of an unpaid order | **PASS** | J "lets the customer cancel an unpaid one outright, releasing the stock"; "still lets a customer cancel an unpaid online order outright" |
| Paid / shipping-paid order → cancellation request | **PASS** | J "turns the customer cancel into a request"; "turns the customer's cancel into a cancellation request and leaves the order alone" |

### 2.7 Wholesale, profile, resilience

| Feature | Verdict | Evidence |
|---|---|---|
| Apply → pending → approve → prices update | **PASS** | A ×9: "wholesale starts pending" → "admin can approve an application" → "wholesalePrice is now visible to the wholesaler" |
| Reject with reason | **PASS** | A "admin can reject an application"; "status becomes rejected" |
| Edit profile; email NOT editable directly | **PASS** | A "email is NOT changed by a profile update"; J "PATCH /auth/me ignores email entirely" |
| **Delete account (in-app)** | **FAIL** | **Does not exist.** See I-1 / **B-1** |
| **Web deletion URL** | **FAIL** | **Does not exist.** See **B-1** |
| **Privacy policy links on Login and Account** | **FAIL** | Plain text only, `LoginScreen.tsx:219`; none on Account. See I-2 / **B-2** |
| Cold/slow backend → "Connecting to store…" then recovers | **NOT VERIFIED** | Needs a device against a cold Render instance. See NV-7 |
| No crash with no internet | **NOT VERIFIED** | See NV-7 |
| Works after long backgrounding (token refresh) | **NOT VERIFIED** | Refresh rotation is proven server-side (J); the device path is not. See NV-7 |

---

## SECTION 3: ADMIN AND STAFF FEATURES

| Feature | Verdict | Evidence |
|---|---|---|
| Admin only via **verified** ADMIN_EMAILS | **PASS** | J "does not make a whitelisted address admin at registration (not yet verified)"; "makes it admin once the address is verified by emailed code"; "demotes a whitelisted but unverified admin" |
| Unverified whitelisted registration gets no session | **PASS** | J, as above (first test) |
| Removing an email demotes immediately | **PASS** | J "demotes an admin whose address is not on the list"; "demotes an admin that is not on ADMIN_EMAILS at the next refresh" |
| ADMIN_EMAILS case/padding tolerant | **PASS** | J "matches case-insensitively, ignores padding, and honours every entry" |
| Dashboard counts | **PASS** | A ×8 (todaysOrders, todaysRevenue, pendingWholesaleApprovals, totalProducts, lowStockThreshold, lowStockProducts, ordersByStatus) |
| Dashboard "Awaiting payment" | **PASS** | J "keeps unpaid COD orders out of revenue and in 'awaiting payment' on the dashboard" |
| Dashboard "Refunds due" | **NOT VERIFIED** | No test asserts this specific counter. See NV-8 |
| Products create/edit/delete with images | **PASS** | A "admin can create products"; "admin can delete a product"; upload guarded (J `robustness`) |
| "Sell to" retail/wholesale/both, only relevant prices required | **PASS** | J `product-pricing` ×12: "saves a retail-only product with just a retail price"; "rejects a 'both' product missing its wholesale price" |
| No auto-derived wholesale price | **PASS** | J "drops a wholesale price sent for a retail-only product rather than storing it"; "clears the wholesale price when an admin makes a product retail-only" |
| Categories CRUD | **PASS** | A "admin can create a category", "admin can rename a category", "deleting a category in use responds deliberately (not 500)" |
| Orders list / filter / detail | **PASS** | A "admin can list all orders", "order list is paginated", "admin can filter orders by status", "admin can read any order" |
| Status transitions; invalid backwards refused | **PASS** | A "admin can advance order status"; `ORDER_STATUS_TRANSITIONS` (`types/index.ts`) |
| COD orders show "Collect ₹X on delivery" | **PASS** | J "shows shipping paid online and the cash due, to both"; bundle string `Collect` present (Section 6) |
| Admin cancel of paid order → full refund | **PASS** | J "refuses staff, and refunds the full amount when admin cancels" |
| COD cancel → shipping-only refund | **PASS** | J "refunds only the shipping charge when admin cancels; staff cannot" |
| Failed refund retryable | **PASS** | J "records a failed refund and lets admin retry it"; "sends one refund when two retries race"; "adopts a refund whose response was lost instead of refunding twice" |
| Refund webhooks update status | **PASS** | J "marks the order refunded when Razorpay reports refund.processed, and ignores a replay" |
| Wholesale approvals | **PASS** | A ×9 (see 2.7) |
| Role endpoint can NEVER grant admin | **PASS** | A "admin can promote a user to staff"; "admin can demote back to retail"; admin role is governed solely by verified ADMIN_EMAILS (J ×10) |
| Staff promotion logged | **NOT VERIFIED** | No test asserts an audit log entry. See NV-9 |
| Deactivation kills sessions at once | **PASS** | J "refuses a deactivated account and revokes all of its sessions"; A "a deactivated user is refused"; enforced per-request at `authenticate.ts:36` |
| COD config save per state | **PASS** | J `cod-config` ×13: "creates a rule, then replaces it in place rather than adding a second"; "folds case and spacing onto one row" |
| COD config takes effect next checkout | **PASS** | J "applies a charge changed by admin to the very next order"; "reads the rule that is in the database at order time" |
| COD config: explicit Save + unsaved-changes warning | **NOT VERIFIED** | UI-only; no screen tests. See NV-10 |
| **Staff → admin-only routes = 403** | **PASS** | A "staff cannot change a price", "staff cannot manage users", "staff cannot review wholesale applications", "staff can still see orders"; J "refuses staff — COD pricing sits with admin (PRD 8.9)"; "refuses a refund for staff"; "refunds only the shipping charge when admin cancels; staff cannot" |

**Correction to I-3:** wholesale approval, reviews, wishlist and categories have **no jest
suite** but are covered by the audit script (A). Genuinely uncovered everywhere:
`POST /auth/logout` (covered by smoke, not jest) and deleting another user's review.

---

## SECTION 4: SECURITY

### 4.1 Original audit findings (F1–F22)

The original audit report is **not in the repo** (`find . -iname "*audit*"` → no findings
file). F-numbers were recovered from the four fix commits' messages.

| Finding | Covered by commit | Re-verified now |
|---|---|---|
| F1 admin escalation via `PATCH /auth/me` email | `3dd945e` | **PASS** — J "PATCH /auth/me ignores email entirely"; A "email is NOT changed by a profile update"; J "does not make a whitelisted address admin at registration (not yet verified)" |
| F2 index deploy step | `3dd945e` | **NOT VERIFIED** — `npm run db:indexes` never run against production. See NV-11 |
| F3 customer cancel of paid order / refunds | `5ba74fb` | **PASS** — J ×7 refund suite |
| F8 cold-start resilience | `3dd945e` | **NOT VERIFIED on device** — retry logic present; see NV-7 |
| F9 ADMIN_EMAILS re-applied on refresh | `cc9e714` | **PASS** — J "demotes an admin that is not on ADMIN_EMAILS at the next refresh"; "refuses a deactivated account and revokes all of its sessions" |
| F10 Google pre-hijack guard | `cc9e714` | **PASS** — J "removes the password and revokes sessions when linking an UNVERIFIED account" |
| F11 webhook processed before ack | `5ba74fb` | **PASS** — J "answers 500 when processing fails, so Razorpay retries, then 200 once it succeeds" |
| F12 expiry sweep + late capture | `5ba74fb` | **PASS** — J ×4 expiry suite |
| F13 weak JWT secrets refuse boot | `cc9e714` | **PASS** — J ×8 `weakSecretReason` suite + "refuses the published placeholder, and identical secrets" |
| F14 multer advisories | `4c84797` | **PASS** — `npm audit` backend: 0 high, 0 critical |
| F16 quotas/limiters in MongoDB | `4c84797` | **PASS** — J "keeps a counter, its expiry and a lockout across a new store instance"; "enforces the password-reset lockout from the database" |
| F17 Sentry, PII scrubbed | `4c84797` | **PASS (scrubber)** — J `scrub-pii` ×10 + "is identical in the backend and the mobile app". **Sentry is OFF in this build** (`app.config` → `sentryDsn: ''`), so no events are sent at all |
| F18 CORS denies browser origins | `4c84797` | **PASS** — J "refuses an unlisted browser origin without a 500"; "serves the mobile app, which sends no Origin" |
| F19 refresh token families | `cc9e714` | **PASS** — J ×6 rotation/reuse suite |
| F20 malformed/oversized bodies | `4c84797` | **PASS** — J "answers malformed JSON with 400, not 500"; "answers an oversized JSON body with 413"; "rejects a non-image with 415, not 500"; "rejects a file over 8 MB with 413, not 500" |
| F21 timing/enumeration | `4c84797` | **PASS** — J "does the same hashing work and gives the same answer for known and unknown emails"; "gives one login error for a wrong password, an unknown email and a Google-only account" |
| F22 HS256 pinned, seed password | `cc9e714`,`4c84797` | **PASS** — J "rejects an access token signed with another algorithm, even with the right secret"; "refuses to run without SEED_ADMIN_PASSWORD, before connecting" |
| **F4, F5, F6, F7, F15** | *no commit references them* | **NOT VERIFIED** — see NV-12 |

Reviewer's pre-registered-admin-email scenario: **PASS** — J `admin-emails` ×12, notably
"does not make a whitelisted address admin at registration (not yet verified)",
"demotes a whitelisted but unverified admin", "counts a completed password reset as
verifying the address".

### 4.2 Findings

**S-1 — Access token survives password reset and email change (up to 30 min). MEDIUM.**
Evidence: `grep -rn "tokenVersion" backend/src/` → **no matches**.
`authenticate.ts:30-45` re-loads the user each request and re-resolves permissions, so
**role change and deactivation are revoked immediately** (`authenticate.ts:36-38`). But
nothing in the access token is compared against a per-user counter, so after a password
reset or email change only the *refresh* tokens are revoked (J "revokes existing sessions
so other devices must sign in again"). A stolen access token keeps working until natural
expiry — `JWT_ACCESS_TTL` default **30m** (`env.ts:35`).
*Impact:* someone who has stolen a session keeps access for up to half an hour after the
victim changes their password — exactly the action a victim takes on noticing a breach.
*Fix:* add `tokenVersion` to the user, embed it in the access token, compare in
`authenticate`, and bump it on password reset, email change, role change and deactivation.
*Effort:* **S** (this is the unfixed finding from the earlier `/security-review`.)

**S-2 — `allowBackup="true"` in the shipped APK. MEDIUM.**
Evidence: `android/app/src/main/AndroidManifest.xml` → `android:allowBackup="true"`.
The brief requires `allowBackup=false`.
*Impact:* Android auto-backup may copy app-private data to the user's Google Drive, and
`adb backup` can extract it on a debuggable-capable device. Tokens live in
`expo-secure-store` (Keystore-backed), which mitigates but does not cover everything the
app writes.
*Fix:* set `expo.android.allowBackup: false` in `app.json` and re-prebuild.
*Effort:* **S**

**S-3 — Four unjustified permissions in the manifest. MEDIUM (Play policy risk).**
Evidence: `aapt2 dump badging app-release.apk`:
`RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, `USE_BIOMETRIC`, `USE_FINGERPRINT` — all four are
on the brief's must-not-ship list. They are pulled in transitively by Expo modules
(`expo-image-picker` → CAMERA/RECORD_AUDIO; `expo-secure-store` → biometric).
*Impact:* `SYSTEM_ALERT_WINDOW` and `RECORD_AUDIO` are heavily scrutinised by Play review
and must be declared and justified in Data Safety; an unjustified declaration is a common
rejection reason. The app uses none of them.
*Fix:* add `tools:node="remove"` entries via a config plugin, or an
`expo.android.blockedPermissions` list in `app.json`.
*Effort:* **S**

**S-4 — No NoSQL-injection or mass-assignment regression tests. LOW (defence is sound).**
Evidence: `grep -rlE "\$ne|\$gt|\$where" src/__tests__/*.test.ts` → **no matches**.
The defence itself is solid and verified by reading: `validate.ts:27` does
`req.body = schemas.body.parse(req.body)` — zod **replaces** the body with the parsed
object and strips undeclared keys, so `accountType`, `role`, `emailVerified`, `price`,
`status` and paid flags cannot be mass-assigned; and a typed field such as
`password: z.string()` (`auth.validator.ts:53`) rejects `{"$ne": null}` with 422 before it
reaches Mongo. Params and query are parsed the same way (`validate.ts:21,24`).
*Impact:* none today; the risk is a future schema change silently removing the guarantee.
*Fix:* add a regression test per route family.
*Effort:* **S**

**S-5 — 3 High advisories in mobile dependencies, all build-time only. LOW.**
Evidence: `npm audit --json` (mobile): 3 high / 15 moderate.
`@xmldom/xmldom` (via `plist`), `image-size`, `js-yaml` — all resolve under build tooling
and none is imported by app code. Confirmed not shipped: none of the three appears in
`assets/index.android.bundle`.
Backend: **0 high, 0 critical**; 4 moderate (`morgan` log-forging, `qs` ×2), both
`npm audit fix`-able and neither reachable from untrusted input in a way that matters here.
*Effort:* **S**

**S-6 — IDOR sweep is partial. LOW.**
Evidence: cross-user checks exist for orders and addresses — J "will not hand out another
customer's payment", "cannot price an order against somebody else's address", "will not
answer for another customer's address". **No test attempts to delete another user's
review**, and there is no systematic sweep over every `:id` route.
*Fix:* one cross-user test per `:id` route family.
*Effort:* **M**

### 4.3 Passing security checks

| Check | Result | Evidence |
|---|---|---|
| HS256 pinned; other algorithms rejected | **PASS** | J "rejects an access token signed with another algorithm, even with the right secret" |
| Expired tokens rejected | **PASS** | J (`robustness`, `password-reset`, `payments`) |
| Razorpay signature forgery rejected | **PASS** | J "rejects a bad signature without touching the order" (`payments.test.ts`) |
| Webhook HMAC; forged webhook rejected | **PASS** | J, plus **live probe**: `POST /api/v1/webhooks/razorpay` with a bogus signature → `401 INVALID_SIGNATURE`; with no header → `400 BAD_REQUEST`. Fails closed when the secret is unset (`payment.service.ts:83-86`) |
| Payment replay / double processing | **PASS** | J "applies once when they arrive confirm first, then the webhook" and the reverse; "ignores a replay" |
| Confirming another user's order | **PASS** | J "will not hand out another customer's payment" (404) |
| Rate limits + lockouts survive restart | **PASS** | J "keeps a counter, its expiry and a lockout across a new store instance"; "counts rate-limit hits in a window shared by every instance" |
| Enumeration (login / forgot-password) | **PASS** | J "does the same hashing work and gives the same answer for known and unknown emails"; "gives an identical response for registered and unregistered emails" |
| CORS denies browser origins in production | **PASS** | J ×2; `CORS_ORIGINS` defaults to `''` = deny-all in production (`env.ts:73`) |
| Security headers present (live) | **PASS** | `curl -sI https://final-manisha-app.onrender.com/health` → CSP, HSTS `max-age=31536000; includeSubDomains`, `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, `referrer-policy: no-referrer`; **no `x-powered-by`** (`app.ts:36` helmet) |
| No stack traces in production errors | **PASS** | Live 401/400/404 responses are clean JSON `{success,error:{code,message}}` with no stack or internals |
| **No secrets in repo or git history** | **PASS** | No `.env` tracked. History scan: 0 hits for Mongo URIs with credentials, Google API keys, private keys, GitHub tokens, SendGrid keys. The 9 `rzp_*` hits are the test fixture `rzp_test_cod_suite` and the `startsWith('rzp_live_')` mode literals — **no real keys** |
| **No secrets in the mobile bundle** | **PASS** | 0 hits for `rzp_live_`, `rzp_test_`, `mongodb`, JWT/Cloudinary/Razorpay/SMTP secrets, private keys in `assets/index.android.bundle`. `app.config` carries only `apiUrl` and the **public** `googleWebClientId` |
| No token/PII console logging; no dev menu or DEMO shortcuts | **PASS** | 4 `console.warn` calls in `mobile/src/`, all `__DEV__`-guarded (`services/googleAuth.ts:82,96,112,120`); none logs a token value |
| Tests/scripts cannot touch production or real third-party accounts | **PASS** | J `db-target` ×20: refuses Atlas/remote URIs, "is enforced by connectDatabase() whenever NODE_ENV is test", "refuses … without the flag", "does not leak the password in its message"; scripts blank Cloudinary/Razorpay/SMTP credentials (F22) |
| Sentry PII scrubbing | **PASS (unit)** | J `scrub-pii` ×10 incl. "removes a JWT", "removes a bearer header", "redacts sensitive keys outright … at any depth", "is identical in the backend and the mobile app". **No live test event** — Sentry is disabled in this build |

---

## SECTION 5: PRODUCTION CONFIG (read-only)

### 5.1 Render — service `Final-Manisha-App`

| Check | Result | Evidence |
|---|---|---|
| `NODE_ENV=production` | **PASS** | Deploy log: `INFO Environment: production` |
| `/health` returns 200 | **PASS** | `curl https://final-manisha-app.onrender.com/health` → `{"status":"ok","database":true}` HTTP 200 |
| Boot log free of env/secret warnings | **PASS** | Only `[razorpay] TEST keys in production` (expected). No missing-env, no weak-secret, no webhook-secret error |
| Razorpay pair verified | **PASS** | `INFO [razorpay] Key id and secret verified with Razorpay.` — the server called Razorpay at boot |
| `RAZORPAY_WEBHOOK_SECRET` set | **PASS (by inference)** | The `RAZORPAY_WEBHOOK_SECRET is not set` error (`payment.service.ts:207-213`) would print between the TEST-keys warning and the verified line. That gap is clean |
| Razorpay mode matches intent | **CONDITION** | Currently **TEST**. Correct for testing, **must become live before launch**. See **C-3** |
| JWT secret strength | **PASS (by inference)** | In production the server refuses to boot on secrets under 32 chars, published placeholders, placeholder wording, repetitive values or identical access/refresh secrets (`env.ts:216-227`, F13). It booted, so all hold. Values never read or printed |
| `CORS_ORIGINS` | **NOT VERIFIED** | Value not readable without dashboard access. Default `''` = deny-all browser origins in production. See NV-13 |
| `ADMIN_EMAILS` count | **NOT VERIFIED** | Not readable. Previously flagged: an **unclaimed** address was listed. See NV-14 / **C-4** |
| Always-on plan (no cold starts) | **NOT VERIFIED** | Two sequential `/health` probes returned in 0.22s and 0.31s — warm, but this does not prove the plan. See NV-15 |
| Health Check Path set to `/health` | **LIKELY UNSET** | Deploy log shows Render probing `GET /` and `HEAD /` → 404. Harmless, but suggests no health check is configured, so Render will not restart a hung instance. See **C-5** |

### 5.2 MongoDB

| Check | Result | Evidence |
|---|---|---|
| App connects | **PASS** | `INFO MongoDB connected`; `/health` → `database:true` |
| Least-privilege user (not atlasAdmin) | **NOT VERIFIED** | Requires Atlas dashboard. See NV-16 |
| **Unique + TTL indexes exist in production** | **NOT VERIFIED — HIGH RISK** | `database.ts:35` sets `autoIndex: !isProduction`, so **production never creates indexes automatically**. `npm run db:indexes --apply` has never been run (no `~/.manisha-maint-uri`). See **B-3** |
| No duplicate emails / COD rows | **NOT VERIFIED** | Same blocker. See NV-11 |
| Backups | **NOT VERIFIED** | Requires Atlas dashboard. See NV-17 |

Indexes declared in the models but **unconfirmed in production** (10):
`users.email` unique+sparse · `users.googleId` unique+sparse · `users.phone` unique ·
`codstateconfigs.stateKey` unique · `orders.orderNumber` unique · `carts.userId` unique ·
`categories.slug` unique · `refreshtokens.jti` unique · TTL on `refreshtokens.expiresAt`,
`kventries.expiresAt`, `ratelimits.resetAt`.

### 5.3 Email and Razorpay dashboard

| Check | Result | Evidence |
|---|---|---|
| Reset/verification email actually sends via Gmail SMTP | **NOT VERIFIED** | `SMTP_USER`/`SMTP_APP_PASSWORD` are set (production refuses to boot without them, `env.ts:204-213`), but no mail was sent to a test inbox. See NV-18 |
| Gmail daily sending limits | **NOTE** | A consumer Gmail account allows ~500 recipients/day; Workspace ~2,000. Password resets, email-change codes and order mail all share that budget. Worth moving to a transactional provider before volume |
| Webhook URL + events registered | **PASS** | Dashboard screenshot: `https://final-manisha-app.onrender.com/api/v1/webhooks/razorpay`, **Enabled**, **4 events**, Test mode. Live probe returns 401/400 correctly |
| The 4 events are the right 4 | **NOT VERIFIED** | The row shows a count, not names. Required: `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`. See NV-19 |

### 5.4 Finding

**C-1 — The brief's stated deploy source is wrong.**
`fresh-manisha/main` is at `3f21983`; `origin/main` (what Render deploys) is at `6c062de`
— **4 commits ahead**, containing every audit fix (Groups A–D) and the COD work.
`fresh-manisha/main` still has the F1 admin-escalation hole.
*Action:* confirm which remote is canonical, and either sync or retire `fresh-manisha`.

---

## SECTION 6: RELEASE BUILD AND PLAY STORE

**No AAB exists and no EAS build profile is defined** (`ls eas.json` → absent;
`android/app/build/outputs/bundle/` → absent). The artefact inspected here is the
**release APK** built this session:
`mobile/android/app/build/outputs/apk/release/app-release.apk` (95 MB, `BUILD SUCCESSFUL in 3m 42s`).

| Check | Result | Evidence |
|---|---|---|
| Signed with the real upload key | **FAIL** | `apksigner verify --print-certs` → `Signer #1 certificate DN: CN=Android Debug, OU=Android, O=Unknown…`, SHA-1 `5e8f16…f625`. This is the **Android debug key**. `android/app/build.gradle:112-115` — the `release` buildType uses `signingConfig signingConfigs.debug`, with the template's own comment "Caution! In production, you need to generate your own keystore file." Play **rejects** debug-signed uploads. See **B-4** |
| package `in.manishafashions.app` | **PASS** | `aapt2 dump badging` → `package: name='in.manishafashions.app'` |
| versionCode higher than any previous upload | **PASS (local)** | `versionCode='4'`, up from 3. Nothing has been uploaded to Play yet, so any value ≥1 is acceptable |
| targetSdk meets Play's requirement | **PASS** | `targetSdkVersion:'36'`, `compileSdkVersion='36'`. Play currently requires 35 |
| `apiUrl` = HTTPS Render URL | **PASS** | `assets/app.config` → `apiUrl: https://final-manisha-app.onrender.com/api/v1`. The retired service string is **absent from the entire APK** |
| No cleartext except emulator hosts | **PASS** | `res/xml/network_security_config.xml`: `base-config cleartextTrafficPermitted="false"`; cleartext allowed only for `localhost`, `127.0.0.1`, `10.0.2.2`, `10.0.3.2` |
| `allowBackup=false` | **FAIL** | `AndroidManifest.xml` → `android:allowBackup="true"`. See **S-2** |
| No RECORD_AUDIO / SYSTEM_ALERT_WINDOW / USE_BIOMETRIC / USE_FINGERPRINT | **FAIL** | All four present. See **S-3** |
| No dev menu, DEMO shortcuts, or token/PII logging | **PASS** | 4 `console.warn` in `mobile/src/`, all `__DEV__`-guarded (`services/googleAuth.ts:82,96,112,120`); none logs a value. No DEMO shortcuts. Release build is Hermes bytecode (`c61fbc03` magic) |
| App launches and runs | **PASS** | Installed on `emulator-5554`, `am start` → `topResumedActivity=…in.manishafashions.app/.MainActivity`, sign-in screen rendered, **no FATAL/AndroidRuntime in logcat** |
| COD flow shipped in the bundle | **PASS** | Strings present in `assets/index.android.bundle`: `& place order`, `Pay cash on delivery`, `Shipping paid`, `Payment not completed`, `Complete payment`, `Awaiting payment`, `Try payment again` |

Full permission list in the APK: `INTERNET`, `ACCESS_NETWORK_STATE`, `VIBRATE`, `CAMERA`,
`READ_EXTERNAL_STORAGE` (≤32), `WRITE_EXTERNAL_STORAGE` (≤32), `RECORD_AUDIO`,
`SYSTEM_ALERT_WINDOW`, `USE_BIOMETRIC`, `USE_FINGERPRINT`,
`in.manishafashions.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.

### 6.1 Google Sign-In SHA-1s

| Key | SHA-1 | Status |
|---|---|---|
| Current signing key (**debug**) | `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25` | Registered and working. **Only valid for sideloaded builds** |
| Upload key | *does not exist yet* | Must be generated, then registered |
| Play App Signing key | *not available until first upload* | Google re-signs the app; its SHA-1 must **also** be registered or Google Sign-In breaks for every Play install |

This is the classic launch failure: sign-in works in testing on the debug-signed APK and
breaks for everyone who installs from Play, because Play re-signs with a different key
whose SHA-1 was never added to the OAuth client. **Both** the upload key and the Play App
Signing key SHA-1 must be registered in Google Cloud Console.

**FCM/Firebase: intentionally absent.** No `google-services.json`, no
`expo-notifications` dependency, no notification code in `mobile/src/`. The app uses no
push notifications, so nothing is broken — but nothing can be pushed either.

### 6.2 Play policy

| Requirement | Result | Evidence |
|---|---|---|
| **In-app account deletion** | **FAIL** | No route, no screen, no API call. See I-1 / **B-1** |
| **Web account-deletion URL** | **FAIL** | Does not exist. See **B-1** |
| **Privacy policy URL live (incognito)** | **FAIL** | No URL exists anywhere in the codebase. `LoginScreen.tsx:219` is plain text. See I-2 / **B-2** |
| Data safety answers match what the code collects | **NOT VERIFIED** | Must declare: email, name, phone, postal address, purchase history, and (if justified) camera. The four unjustified permissions (**S-3**) will complicate this form. See NV-20 |
| Content rating inputs | **NOT VERIFIED** | Questionnaire not filled. See NV-21 |

### 6.3 Store listing assets

| Asset | Result |
|---|---|
| Icon 512×512 | **PASS (derivable)** — `assets/icon.png` is 1024×1024; Play accepts 512×512, downscale is trivial |
| Feature graphic 1024×500 | **MISSING** — no such asset in `mobile/assets/` |
| Screenshots (min 2, phone) | **MISSING** — none in the repo |

---

## SECTION 7: TESTS AND BUILD HEALTH

| Check | Command | Result |
|---|---|---|
| Backend test suite | `npx jest` | **199 passed / 199**, 14 suites, ~36s — **0 failures** |
| Mobile test suite | `npm test` | **14 passed / 14**, 3 suites — **0 failures** |
| Backend typecheck | `npx tsc --noEmit` | **clean** |
| Mobile typecheck | `npx tsc --noEmit` | **clean** |
| Smoke script | `npm run smoke` | **64/64 checks passed** |
| Audit script | `npm run audit` | **126/126 checks passed** |
| Android bundle | `npx expo export --platform android` | **success** — `index-…hbc` 4.2 MB, 18 assets |
| Android release build | `./gradlew assembleRelease` | **BUILD SUCCESSFUL in 3m 42s**, 585 tasks |
| Backend `npm audit` | | 0 critical, **0 high**, 4 moderate |
| Mobile `npm audit` | | 0 critical, **3 high (build-time only)**, 15 moderate |

**Nothing fails.** The gap is coverage, not correctness: 14 mobile tests cover the
navigator, API client and PII scrubber; **no screen has a rendering or interaction test**
(I-5).

---
