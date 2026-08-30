# Sign Shop Funnel

Static HTML/CSS/JS frontend plus a Cloudflare Worker for:

- Turnstile server-side verification
- request validation
- artwork uploads to R2
- lead + file metadata storage in D1
- email notification (currently wired for Resend)
- static asset hosting from the same Worker deployment

## Architecture

Browser -> Worker `/api/quote`

1. Browser performs UX validation.
2. Turnstile creates a token.
3. Worker verifies the token.
4. Worker validates all fields again.
5. Worker writes artwork to R2.
6. Worker writes lead + file records to D1.
7. Worker sends the lead notification email.
8. If email fails, the lead remains in D1 and `email_error` records the failure.

## Setup

### 1. Install

```bash
npm install
npx wrangler login
```

### 2. Create D1

```bash
npx wrangler d1 create sign-shop-leads
```

Copy the returned database ID into `wrangler.jsonc`.

### 3. Create R2 bucket

```bash
npx wrangler r2 bucket create sign-shop-artwork
```

### 4. Create a Turnstile widget

In Cloudflare, create a Managed Turnstile widget for your domain.

Put the public **site key** in `TURNSTILE_SITE_KEY` in `wrangler.jsonc`.

Store the secret:

```bash
npx wrangler secret put TURNSTILE_SECRET
```

### 5. Add a hash salt

This project hashes the request IP before storing it, rather than storing the raw IP.

```bash
npx wrangler secret put IP_HASH_SALT
```

Use a long random value.

### 6. Configure email

This starter uses Resend's HTTP API.

Set these non-secret values in `wrangler.jsonc`:

- `LEAD_EMAIL_TO`
- `LEAD_EMAIL_FROM`
- `BUSINESS_NAME`

Then:

```bash
npx wrangler secret put RESEND_API_KEY
```

Your `LEAD_EMAIL_FROM` domain must be authorized with your email provider.

### 7. Run migrations

Local:

```bash
npm run db:migrate:local
```

Production:

```bash
npm run db:migrate:remote
```

### 8. Develop

```bash
npm run dev
```

### 9. Deploy

```bash
npm run deploy
```

## Important next work

The frontend deliberately uses project-photo placeholders. Replace them with actual shop work before launch.

Likely next iterations:

- real branding/logo/color system
- project photography
- conditional quote questions for each service type
- signed/admin-only artwork download endpoint for R2
- internal lead viewer or email-failure view
- privacy policy / terms
- analytics + ad conversion events
- stricter file signature checks if accepting arbitrary production artwork


## Accessibility target

The frontend is authored toward WCAG 2.2 Level AA. It includes semantic landmarks and headings, a skip link, keyboard-operable navigation and filters, visible focus states, reduced-motion support, accessible form labels and error summaries, descriptive portfolio image alt text, 44px-class interactive targets, and contrast-safe text colors. Automated testing is useful but does not replace manual keyboard and assistive-technology testing.


## Branding assets

The supplied Dahntahn Made SVG is stored at `public/assets/brand/dahntahn-made.svg` and used in the header/footer. Favicon assets are generated from the same mark: `favicon.svg`, `favicon.ico`, `favicon-32x32.png`, and `apple-touch-icon.png`.


## Responsive / acknowledgement update

- Quote acknowledgement now appears below the quote form in the right-hand contact column.
- The completed form remains visible after submission, while the submit button changes to “Request sent” and is disabled to prevent duplicate submissions.
- Added responsive layout tuning at 1100px, 900px, 720px, and 420px.
- Portfolio changes from 3 columns to 2 columns to 1 column as viewport width narrows.
- Service cards collapse from 3 columns to 2 and then 1.
- Quote fields become single-column on mobile.
- Hero CTAs become full-width on small screens.
- Mobile project lightbox uses nearly full viewport width.
- Turnstile now uses Cloudflare's `flexible` widget size for responsive layouts.
- Form controls stay at 16px on narrow phones to avoid iOS zoom-on-focus behavior.


## SEO

The production build includes:

- canonical URL for `https://dtmade.net/`
- local-search-oriented title and meta description
- Open Graph and Twitter/X social-sharing metadata
- 1200x630 social preview image at `/assets/seo/dahntahn-made-og.jpg`
- JSON-LD `LocalBusiness` structured data with real contact details and service catalog
- `/robots.txt`
- `/sitemap.xml`

When additional standalone service or portfolio pages are added, add them to `sitemap.xml` and give each page a unique title, description, canonical URL, and structured data where appropriate.

## Private artwork email links

Artwork stays private in R2. Email notifications contain signed download links served by the Worker at `/api/artwork`.

Create the signing secret once:

```bash
openssl rand -hex 32
npx wrangler secret put ARTWORK_LINK_SECRET
```

Paste the generated random value when prompted. Links expire after 30 days by default (`ARTWORK_LINK_TTL_SECONDS=2592000`).

The notification email subject is exactly `dtmade quote`.


## v10 changes
- Added T-Shirt Design & Printing service and SEO page.
- Added tshirt-design-printing to quote form and Worker validation.
- Updated LEAD_EMAIL_TO to ibuckman@dtmade.net.
- Added service to sitemap and internal related-service links.


## v12 service-page quote forms

Every service page now includes the full quote form with its service preselected. Service-page quote CTAs scroll to the local form instead of navigating back to the homepage.
