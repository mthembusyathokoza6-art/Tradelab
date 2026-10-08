# TradeLab Public Site App

This package contains only the public-facing TradeLab app, its server-side API functions, and additive custom-auth/payment-settlement migration drafts. The separate admin site is not included.

## What's included

- `public/` — landing page, challenge-account landing after sign-in, instrument-first view-only terminal, registration/login/email verification screens, PWA/offline assets, and separate legal draft pages.
- `netlify/functions/` — server-only Supabase, Twelve Data and feature-gated NowPayments hosted-invoice/webhook settlement routes.
- `netlify.toml` — Netlify publish directory and `/api/*` function routing.
- `supabase/migrations/202610080001_custom_auth.sql` and `202610080002_payment_settlement.sql` — unapplied additive drafts.
- `supabase/manual/align_approved_challenge_rules.sql` — separate manual update for approved rules; do not run until explicitly signed off.
- `.env.example` — variable names only; no credential values.

## Preview

For a static UI-only preview:

```sh
python -m http.server 4173 --bind 0.0.0.0 --directory public
```

The static preview uses illustrative sample data. It starts on the instrument list and loads a chart only after instrument selection. The visible app-install button uses the browser PWA prompt/help. The static preview does not connect to Supabase or provider APIs, does not create accounts, and cannot take payments. `npm test` runs mocked checkout/webhook smoke tests only; it does not contact Supabase or NOWPayments.

## Netlify

Deploy this directory as the site root using the included `netlify.toml`. The publish directory is `public`; Netlify Functions are in `netlify/functions` and route through `/api/*`.

Configure server-side environment variables using `.env.example` as a name-only checklist. Do not place service-role, Twelve Data, NowPayments, email-provider, or session secrets under `public/` or in browser code. Rotate any credentials exposed by prior drafts and configure only fresh values in Netlify.

The custom-auth migration is a draft and has not been applied. Review it against the live schema before applying. Registration stays gated until the migration and approved legal document versions are configured. Under the current product policy, sign-up does not require email verification or manual admin approval; verification plus account/identity checks must be required before any payout flow. The email sender is optional for signup but needed to verify email. Existing app data is not reset by this package.

## Production gates

- Base challenge fees are approved and match the current Supabase rows. The challenge rules in Supabase do not yet match the approved rules, so server-side checkout rejects those rows until aligned.
- Hosted invoice creation and signed, idempotent settlement routes are implemented behind off-by-default switches, but the migrations are unapplied and production end-to-end review is pending.
- Simulated trading/risk processing, payouts/KYC, referral-ledger settlement and private admin workflows remain incomplete.
- Legal pages are drafts requiring qualified South African legal/compliance review. The Privacy Notice is additionally subject to owner confirmation.
