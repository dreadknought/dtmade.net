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
