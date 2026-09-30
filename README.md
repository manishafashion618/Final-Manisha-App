# Manisha Fashions — Jewellery Ecommerce App

Implementation of **PRD v2.0 (React Native)**. Two packages:

| Package | Stack | What it is |
| --- | --- | --- |
| [`backend/`](backend/) | Node.js + Express + TypeScript, MongoDB (Mongoose) | REST API — auth, catalog, cart, orders, payments, admin |
| [`mobile/`](mobile/) | Expo SDK 57 + React Native 0.86 + TypeScript, Redux Toolkit, React Navigation | Android + iOS client — customer flow *and* the in-app admin panel |

---

## Quick start

### 1. Dependencies

```bash
# MongoDB via Docker (or point .env at Atlas)
docker compose up -d
```

No Docker? Install MongoDB locally. Redis is not required — OTP and rate-limit
counters are held in-process.

### 2. Backend

```bash
cd backend
cp .env.example .env      # then fill in the secrets — see "Configuration"
npm install
npm run seed              # categories, sample products, first admin account
npm run dev               # http://localhost:4000/api/v1
```

`npm run seed` prints the admin phone number (`SEED_ADMIN_PHONE`, default
`+919999999999`). Sign in with it to reach the admin panel.

With `OTP_PROVIDER=console` the OTP is printed to the server log **and**
returned in the API response as `devCode`, so the app auto-fills it. This is
disabled in production.

### 3. Mobile

```bash
cd mobile
npm install
npx expo start
```

The app resolves its API base URL in this order:

1. `extra.apiUrl` in [`mobile/app.json`](mobile/app.json)
2. `EXPO_PUBLIC_API_URL`
3. Platform default — `http://10.0.2.2:4000/api/v1` on the Android emulator,
   `http://localhost:4000/api/v1` elsewhere

> **Expo Go.** The whole app runs in Expo Go — there are no native modules
> requiring a development build. `npx expo run:android` / `run:ios` still works
> if you prefer a local build.

---

## Verifying it works

```bash
cd backend
npm run typecheck
npm run smoke
npm run audit     # wider sweep: every endpoint the app calls, as each role
```

`npm run smoke` boots the real Express app against an **in-memory MongoDB** (no
Docker or Atlas needed) and asserts the PRD's rules end to end:

- OTP → JWT login; a wrong or expired code returns 401
- `wholesalePrice` is absent from every response for a retail account
- a pending wholesale account is blocked from browsing (403 `WHOLESALE_NOT_APPROVED`)
- approval unlocks wholesale pricing on the *existing* token
- staff are refused price changes but allowed stock changes
- COD checkout adds the flat shipping charge; `priceAtOrder` is frozen
- cancelling while "placed" restores stock; cancelling after "processing" is refused
- refresh-token rotation works and a reused token is rejected

The first run downloads a `mongod` binary (~270 MB) and is slow; later runs are fast.

```bash
cd mobile && npx tsc --noEmit
```

---

## Configuration

Everything lives in `backend/.env` (never committed — PRD §8.5). See
[`backend/.env.example`](backend/.env.example) for the full list.

| Group | Keys | Notes |
| --- | --- | --- |
| Database | `MONGODB_URI` | MongoDB Atlas M0 is sufficient at launch (PRD §8.2). |
| JWT | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL_DAYS` | Long random values. `JWT_REFRESH_TTL_DAYS` is the admin-configurable idle period (default 90 — PRD §4.1). |
| OTP | `OTP_PROVIDER`, `MSG91_*` | `console` (dev), `msg91` (live). See "OTP providers" below. |
| Images | `CLOUDINARY_*` | Without these, image upload returns 503; everything else works. |
| Payments | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Without these only COD is offered — the app hides the online option. |
| Commerce | `COD_SHIPPING_CHARGE`, `PREPAID_SHIPPING_CHARGE` | **Integer paise** (`5000` = ₹50). Served to the app via `GET /config`. |

Every integration degrades gracefully: the API boots and reports what is wired
up at `GET /api/v1/health`.

### OTP providers

`console` and `msg91` are implemented. `OTP_PROVIDER=firebase` deliberately
returns a 503 with an explanatory message: **Firebase Phone Auth issues and
verifies the OTP on the client**, so the server never sends it. If you choose
Firebase, the client should verify with the Firebase SDK and exchange the
resulting Firebase ID token for a session — that exchange endpoint is not built,
since the PRD's flow (`POST /auth/otp/send` → `verify`) matches MSG91.

MSG91 live delivery is still pending on the client's side per PRD §2.

**Until it is, sign-in on a real phone only works for allowlisted test
numbers.** `console` is refused in production because it returns the OTP in the
API response — without that guard anyone could sign in as any number. Two
handsets are exempted so the deployed app can be tested (see
`DEFAULT_TEST_PHONES` in [`otp.service.ts`](backend/src/services/otp.service.ts),
overridable with `OTP_TEST_PHONES`). Treat those numbers as credentials and
clear the list once real SMS works.

Test numbers, while the allowlist is in place:

| Number | Signs in as |
| --- | --- |
| `9363750806`, `9345548984` | **Admin** — the shop's own handsets |
| `9000000001` | **Retail** customer |
| `9000000002` | **Wholesale** — pick the Wholesale tab; starts pending approval |

No SIM is needed for any of them: the console provider returns the code in the
API response and the app fills it in.

To go live: set `OTP_PROVIDER=msg91` **and** the three `MSG91_*` keys. Setting
the keys alone is not enough — the provider still defaults to `console`.

---

## Money

**Every monetary value in both packages is an integer number of paise** (₹1 =
100). No floats touch money anywhere. The mobile app converts at the edges only
—  [`mobile/src/utils/money.ts`](mobile/src/utils/money.ts).

---

## How the PRD maps to the code

### Request pipeline (§8.6)

The fixed order is assembled in [`backend/src/app.ts`](backend/src/app.ts) and
per-route in `backend/src/routes/*`:

```
Nginx (TLS, outside this process)
  → Express Router
  → Request Validation (Zod)         middleware/validate.ts
  → Rate Limiter                     middleware/rateLimiter.ts
  → JWT Authentication               middleware/authenticate.ts
  → Role & Permission Check (RBAC)   middleware/authorize.ts
  → Controller → Service → Repository → MongoDB
  → Response Formatter → JSON        middleware/responseFormatter.ts
```

### Price visibility (§4.2 / §8.4 / §8.8)

`wholesalePrice` is stripped **server-side** in exactly one place —
[`backend/src/serializers/product.serializer.ts`](backend/src/serializers/product.serializer.ts).
No route returns a raw Product document, so a modified client or an intercepted
request cannot surface wholesale pricing. Cart and order pricing read from the
same module, so the tier decision exists once.

### Role matrix (§8.9)

[`backend/src/utils/rbac.ts`](backend/src/utils/rbac.ts) is the single source of
truth, mirrored (for UI gating only) in
[`mobile/src/store/hooks.ts`](mobile/src/store/hooks.ts).

| Role | Access |
| --- | --- |
| Retail | Catalog, cart, checkout, own orders — retail pricing |
| Wholesale (approved) | As retail, plus wholesale pricing |
| Wholesale (pending/rejected) | **Login only** — empty permission set |
| Staff | Products, categories, order status, dashboard — no pricing, no approvals, no accounts |
| Admin | Everything, plus pricing, wholesale approvals, staff accounts |

A pending wholesale applicant's blocked state is enforced twice and
independently: the API returns 403 `WHOLESALE_NOT_APPROVED`, and
[`RootNavigator`](mobile/src/navigation/RootNavigator.tsx) mounts a stack that
has no route into the catalogue at all.

### Token lifecycle (§8.7 / §8.10)

- Tokens live in `expo-secure-store` (Keychain / Keystore), never AsyncStorage —
  [`mobile/src/api/tokenStorage.ts`](mobile/src/api/tokenStorage.ts)
- **The Axios interceptor attaches the access token to every request without
  exception** — the known gap in the previous Flutter client is closed by
  attaching centrally rather than per call:
  [`mobile/src/api/client.ts`](mobile/src/api/client.ts)
- On 401 `TOKEN_EXPIRED` the client refreshes once and retries; concurrent
  requests share one refresh promise rather than stampeding
- Refresh tokens **rotate** on use — a stolen token is usable at most once
- Logout revokes the refresh token server-side, not just on-device
- Role changes take effect on the next request: `authenticate` re-reads the user
  rather than trusting stale JWT claims

### Catalog performance (§8.3)

`expo-image` with explicit sizing, `cachePolicy="memory-disk"` and a blurhash
placeholder, inside a memoised `FlatList` cell with windowing — the PRD's stated
fix for the image lag in the Flutter build.

### Payments (§4.4)

Razorpay Checkout runs in a **WebView**
([`RazorpayCheckoutScreen`](mobile/src/screens/customer/RazorpayCheckoutScreen.tsx))
rather than a native module, so it works in Expo Go and a dev build alike. The
payment signature is verified server-side; the client never decides that a
payment succeeded. Stock is reserved at checkout and released if payment fails,
so a stalled payment cannot hold inventory. The webhook is idempotent and
authenticated by HMAC over the raw request body.

To swap in `react-native-razorpay` later, replace that one screen — the API
contract does not change.

---

## API surface

Base path `/api/v1`. All responses are `{ success, data, meta? }` or
`{ success: false, error: { code, message, details? } }`.

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness + which integrations are configured |
| `GET /config` | Currency, COD/prepaid shipping charges, Razorpay availability |
| `POST /auth/otp/send` · `/verify` · `/refresh` · `/logout` | Session lifecycle |
| `GET/PATCH /auth/me`, `/auth/addresses`, `/auth/devices` | Profile, addresses, FCM tokens |
| `GET/POST/PATCH/DELETE /products`, `/products/categories`, `/products/images` | Catalog + admin CRUD + Cloudinary upload |
| `GET/POST/PATCH/DELETE /cart`, `/wishlist` | Cart and save-for-later |
| `POST /orders/checkout`, `/orders/payment/confirm`, `GET /orders`, `POST /orders/:id/cancel` | Checkout and order tracking |
| `GET /admin/dashboard`, `/admin/orders`, `/admin/wholesale`, `/admin/users` | Admin panel |
| `POST /webhooks/razorpay` | Payment status webhook (HMAC-verified, outside the JWT pipeline) |

---

## Deviations from the PRD, and why

1. **The backend was built here, not carried over.** The PRD describes the
   Node/Express + MongoDB API as existing and "unchanged", but the repository
   was empty. It is implemented to match §8.2–§8.11 exactly. If a real deployed
   backend exists, reconcile the two before launch — §9 already calls for "a
   single canonical deployment".
2. **Notifications are not built.** §4.6 describes push and an in-app
   notification list; both were removed at the client's request. Order status
   changes are visible in the app's order screens instead. Nothing in the
   schema, API or client references notifications any more.
3. **Staff cannot *create* products, only edit them.** §8.9 gives staff "product
   management" but "no pricing changes", while §4.7 makes both prices required
   with no auto-derived default. Creation therefore necessarily sets prices, so
   it is admin-only; staff retain stock, images, description, category and
   visibility. Flag this with the client alongside the other §6 open items.
4. **Addresses are embedded on the User document** rather than a separate
   collection — they are only ever read with their owner.
5. **`GET /config` was added** so the app can show the COD shipping charge
   before the order is placed, without hard-coding a figure the PRD lists as an
   open item.

## Data retention

The privacy policy (`backend/src/pages/privacyPolicy.ts`) and the account-deletion
page tell customers that past orders are kept for 8 years for GST and income-tax
records. Nothing in the code enforces the end of that period yet:

- **Rule** — past orders must be purged 8 years after the order date (`createdAt`
  on the `orders` collection), per the privacy policy. Orders belonging to deleted
  accounts are included: deletion anonymises them, it does not change the clock.
- **No automated job exists.** Nothing deletes old orders today. Build a scheduled
  purge, or run one by hand, before the first orders fall due.
- **First orders become due in 2034** — the store's first orders date from 2026.

## Still open (PRD §6 — needs client confirmation)

These are wired to be configurable rather than guessed:

- **COD shipping charge** — `COD_SHIPPING_CHARGE`, currently ₹50
- **Categories / products per category** — catalog is paginated and indexed for
  filter, sort and search, so the number is a capacity question, not a rebuild
- **Apple Developer Program account** — who owns and pays for it
- **Return/replacement policy text** — no in-app screen exists for it yet
- **Wholesale document upload** — `gstNumber` and `shopProofUrl` are accepted
  and shown to the approving admin, but not *required*; make them required in
  `auth.validator.ts` if the client wants that
- **Staff vs Admin split** — implemented as §8.9 recommends; confirm with client
- **Expo vs bare React Native** — built on Expo (managed); `npx expo prebuild`
  ejects to bare if a native module ever demands it

## Not built (explicitly out of scope, PRD §5)

Multi-vendor, in-app chat, multi-language, loyalty/referrals, web storefront,
and returns/refunds automation.
