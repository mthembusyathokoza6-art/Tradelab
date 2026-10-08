-- TradeLab additive setup bundle for the schema you provided.
-- REVIEW BEFORE RUNNING. No secrets are included.
-- This bundle contains three separately transaction-scoped sections and runs them in order.
-- If a later section fails, previously COMMITted sections remain applied; inspect the error and
-- do not blindly rerun until you know which section completed.
-- It does not enable checkout, set Netlify environment variables, finalize legal documents,
-- create referral/payout flows, or change existing challenge fees/balances.
-- For maximum control, run the three source files individually in the same order.

-- SECTION 1 — ALIGN THE THREE APPROVED CHALLENGE RULE ROWS
-- Source: supabase/manual/align_approved_challenge_rules.sql

-- MANUAL DATA UPDATE — do not run unless you want the previously approved rules enforced.
-- Preserves challenge IDs, names, fees, balances, currencies, active flags, and all other columns.
-- Expected change: only profit_target_percent, max_daily_dd_percent,
-- max_total_dd_percent, and min_trading_days for the three known tiers.

BEGIN;

DO $preflight$
DECLARE
  matching_rows integer;
BEGIN
  SELECT count(*) INTO matching_rows
  FROM public.challenges
  WHERE (id = 'starter' AND virtual_balance = 50000 AND price = 500 AND upper(currency) = 'ZAR')
     OR (id = 'professional' AND virtual_balance = 100000 AND price = 1000 AND upper(currency) = 'ZAR')
     OR (id = 'elite' AND virtual_balance = 200000 AND price = 2500 AND upper(currency) = 'ZAR');

  IF matching_rows <> 3 THEN
    RAISE EXCEPTION 'Expected all three approved challenge IDs/balances/fees before rule update; found % matching rows. No changes applied.', matching_rows;
  END IF;
END
$preflight$;

UPDATE public.challenges
SET profit_target_percent = 20,
    max_daily_dd_percent = 5,
    max_total_dd_percent = 15,
    min_trading_days = 5
WHERE id IN ('starter', 'professional', 'elite');

COMMIT;


-- SECTION 2 — ADD CUSTOM AUTH TABLES/FIELDS AND REGISTRATION ROUTINE
-- Source: supabase/migrations/202610080001_custom_auth.sql

-- ADDITIVE DRAFT ONLY — do not apply until the live schema has been reviewed.
-- No existing table is dropped, truncated, or reset. Existing rows are not updated.
-- This migration assumes public.users.id is UUID (the API will fail closed if not).
-- It keeps RLS enabled without forcing it and does not grant anon/authenticated access.

BEGIN;

DO $preflight$
DECLARE
  id_type text;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'Expected existing public.users table; refusing to create or replace it.';
  END IF;
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO id_type
  FROM pg_attribute AS a
  WHERE a.attrelid = 'public.users'::regclass
    AND a.attname = 'id'
    AND a.attnum > 0
    AND NOT a.attisdropped;
  IF id_type IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 'Expected public.users.id to be uuid; actual type is %. No migration changes were applied.', id_type;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.users'::regclass
      AND attname = 'email'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Expected public.users.email column; refusing to proceed.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.users'::regclass
      AND attname = 'password_hash'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Expected public.users.password_hash column; refusing to proceed.';
  END IF;
END
$preflight$;

-- Add non-destructive compatibility fields for the account form. Existing fields/types are left untouched.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS dob text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'trader';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar text;

-- Namespaced fields are authoritative for this custom-auth flow and avoid changing legacy semantics.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_first_name text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_last_name text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_phone text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_country text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_date_of_birth date;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_role text NOT NULL DEFAULT 'trader';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_account_status text NOT NULL DEFAULT 'active';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_email_verified_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_terms_version text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_terms_accepted_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_risk_version text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_risk_accepted_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_privacy_version text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tradelab_privacy_acknowledged_at timestamptz;

-- Fail at migration time, before enabling signups, if an unknown legacy NOT NULL/no-default
-- column would make account creation fail. Review the column list before adjusting this allowlist.
DO $required_columns$
DECLARE
  unhandled text;
BEGIN
  SELECT string_agg(format('%I (%s)', a.attname, format_type(a.atttypid, a.atttypmod)), ', ' ORDER BY a.attnum)
    INTO unhandled
  FROM pg_attribute AS a
  LEFT JOIN pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.users'::regclass
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND a.attnotnull
    AND d.oid IS NULL
    AND a.attidentity = ''
    AND a.attgenerated = ''
    AND a.attname NOT IN (
      'id', 'email', 'password_hash', 'full_name', 'first_name', 'last_name', 'phone',
      'country', 'dob', 'created_at', 'role', 'verified', 'avatar',
      'tradelab_first_name', 'tradelab_last_name', 'tradelab_phone', 'tradelab_country',
      'tradelab_date_of_birth', 'tradelab_role', 'tradelab_account_status',
      'tradelab_email_verified_at', 'tradelab_created_at', 'tradelab_terms_version',
      'tradelab_terms_accepted_at', 'tradelab_risk_version', 'tradelab_risk_accepted_at',
      'tradelab_privacy_version', 'tradelab_privacy_acknowledged_at'
    );
  IF unhandled IS NOT NULL THEN
    RAISE EXCEPTION 'Review required: public.users has NOT NULL columns without defaults not handled by the registration function: %', unhandled;
  END IF;
END
$required_columns$;

CREATE TABLE IF NOT EXISTS public.tradelab_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  user_agent text
);
CREATE INDEX IF NOT EXISTS tradelab_sessions_user_id_idx ON public.tradelab_sessions(user_id);
CREATE INDEX IF NOT EXISTS tradelab_sessions_expiry_idx ON public.tradelab_sessions(expires_at);

CREATE TABLE IF NOT EXISTS public.tradelab_email_verifications (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS tradelab_email_verifications_user_id_idx ON public.tradelab_email_verifications(user_id);
CREATE INDEX IF NOT EXISTS tradelab_email_verifications_expiry_idx ON public.tradelab_email_verifications(expires_at);

CREATE TABLE IF NOT EXISTS public.tradelab_legal_acceptances (
  acceptance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('terms', 'risk', 'privacy')),
  document_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tradelab_legal_acceptances_user_id_idx ON public.tradelab_legal_acceptances(user_id);

-- One transaction records the account and its three required document acknowledgements.
CREATE OR REPLACE FUNCTION public.tradelab_register_custom_user(
  p_id uuid,
  p_email text,
  p_password_hash text,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_country text,
  p_date_of_birth date,
  p_terms_version text,
  p_risk_version text,
  p_privacy_version text,
  p_email_verification_required boolean
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  new_user_id uuid;
  accepted_at timestamptz := now();
  -- Current JavaScript account UI passes bigint timestamps to new Date(number), so use epoch milliseconds.
  created_at_ms bigint := floor(extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  INSERT INTO public.users (
    id, email, password_hash,
    full_name, first_name, last_name, phone, country, dob, created_at, role, verified, avatar,
    tradelab_first_name, tradelab_last_name, tradelab_phone,
    tradelab_country, tradelab_date_of_birth, tradelab_role,
    tradelab_account_status, tradelab_terms_version, tradelab_terms_accepted_at,
    tradelab_risk_version, tradelab_risk_accepted_at,
    tradelab_privacy_version, tradelab_privacy_acknowledged_at
  ) VALUES (
    p_id, lower(btrim(p_email)), p_password_hash,
    btrim(concat_ws(' ', btrim(p_first_name), btrim(p_last_name))), btrim(p_first_name), btrim(p_last_name),
    btrim(p_phone), btrim(p_country), p_date_of_birth::text, created_at_ms, 'trader', false, '',
    btrim(p_first_name), btrim(p_last_name), btrim(p_phone),
    btrim(p_country), p_date_of_birth, 'trader',
    CASE WHEN p_email_verification_required THEN 'pending_verification' ELSE 'active' END,
    p_terms_version, accepted_at,
    p_risk_version, accepted_at, p_privacy_version, accepted_at
  ) RETURNING id INTO new_user_id;

  INSERT INTO public.tradelab_legal_acceptances (user_id, document_type, document_version, accepted_at)
  VALUES
    (new_user_id, 'terms', p_terms_version, accepted_at),
    (new_user_id, 'risk', p_risk_version, accepted_at),
    (new_user_id, 'privacy', p_privacy_version, accepted_at);

  RETURN new_user_id;
END;
$function$;

-- Explicitly keep all newly created private tables service-role-only.
ALTER TABLE public.tradelab_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tradelab_email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tradelab_legal_acceptances ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tradelab_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tradelab_email_verifications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tradelab_legal_acceptances FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tradelab_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tradelab_email_verifications TO service_role;
GRANT SELECT, INSERT ON TABLE public.tradelab_legal_acceptances TO service_role;

REVOKE ALL ON FUNCTION public.tradelab_register_custom_user(uuid, text, text, text, text, text, text, date, text, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tradelab_register_custom_user(uuid, text, text, text, text, text, text, date, text, text, text, boolean)
  TO service_role;

COMMIT;


-- SECTION 3 — ADD PRIVATE PAYMENT ORDERS, WEBHOOK EVENTS, AND SETTLEMENT ROUTINE
-- Source: supabase/migrations/202610080002_payment_settlement.sql

-- ADDITIVE DRAFT ONLY — review against the live schema before applying.
-- Adds a private order/event ledger and an idempotent, transactional settlement routine.
-- Does not drop, truncate, or rewrite existing application rows.

BEGIN;

DO $preflight$
DECLARE
  expected text;
  actual text;
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.challenges') IS NULL
     OR to_regclass('public.challenge_accounts') IS NULL THEN
    RAISE EXCEPTION 'Expected users, challenges, and challenge_accounts tables; no payment schema changes were applied.';
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod) INTO actual
  FROM pg_attribute a
  WHERE a.attrelid = 'public.users'::regclass AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped;
  IF actual IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 'Expected users.id uuid; found %. No payment schema changes were applied.', actual;
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod) INTO actual
  FROM pg_attribute a
  WHERE a.attrelid = 'public.challenges'::regclass AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped;
  IF actual IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'Expected challenges.id text; found %. No payment schema changes were applied.', actual;
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod) INTO actual
  FROM pg_attribute a
  WHERE a.attrelid = 'public.challenge_accounts'::regclass AND a.attname = 'challenge_id' AND a.attnum > 0 AND NOT a.attisdropped;
  IF actual IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'Expected challenge_accounts.challenge_id text; found %. No payment schema changes were applied.', actual;
  END IF;

  FOR expected IN SELECT unnest(ARRAY[
    'user_id','challenge_id','challenge_name','starting_balance','balance','equity',
    'available_margin','used_margin','unrealized_pl','realized_pl','status','trading_days',
    'daily_pl','max_daily_loss','max_total_loss','profit_target','profit_target_value',
    'current_drawdown','max_drawdown','peak_equity','progress','price_paid','currency_paid',
    'payment_id','created_at','updated_at'
  ]) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.challenge_accounts'::regclass
        AND attname = expected AND attnum > 0 AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'Missing challenge_accounts.% required for settlement; no payment schema changes were applied.', expected;
    END IF;
  END LOOP;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.tradelab_payment_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  challenge_id text NOT NULL REFERENCES public.challenges(id) ON DELETE RESTRICT,
  challenge_name text NOT NULL,
  starting_balance double precision NOT NULL CHECK (starting_balance > 0),
  fee_amount numeric(12,2) NOT NULL CHECK (fee_amount > 0),
  fee_currency text NOT NULL CHECK (upper(fee_currency) = 'ZAR'),
  max_daily_loss double precision NOT NULL CHECK (max_daily_loss > 0),
  max_total_loss double precision NOT NULL CHECK (max_total_loss > 0),
  profit_target double precision NOT NULL CHECK (profit_target > 0),
  profit_target_value double precision NOT NULL CHECK (profit_target_value > 0),
  min_trading_days integer NOT NULL CHECK (min_trading_days > 0),
  daily_reset_timezone text NOT NULL DEFAULT 'Africa/Johannesburg',
  idempotency_key uuid NOT NULL,
  provider text NOT NULL DEFAULT 'nowpayments' CHECK (provider = 'nowpayments'),
  status text NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating','waiting','confirming','partially_paid','settled','expired','failed','refunded','manual_review','invoice_error')),
  provider_invoice_id text,
  invoice_url text,
  provider_payment_id text,
  provider_status text,
  received_price_amount numeric(18,8),
  received_price_currency text,
  pay_currency text,
  pay_amount numeric(38,18),
  actually_paid numeric(38,18),
  latest_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT tradelab_payment_orders_user_idempotency_key UNIQUE (user_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS tradelab_payment_orders_invoice_id_uidx
  ON public.tradelab_payment_orders(provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tradelab_payment_orders_user_created_idx
  ON public.tradelab_payment_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tradelab_payment_orders_status_created_idx
  ON public.tradelab_payment_orders(status, created_at);

CREATE TABLE IF NOT EXISTS public.tradelab_payment_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL REFERENCES public.tradelab_payment_orders(id) ON DELETE RESTRICT,
  provider_payment_id text NOT NULL,
  payment_status text NOT NULL,
  payload_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tradelab_payment_events_order_received_idx
  ON public.tradelab_payment_events(order_id, received_at DESC);
CREATE INDEX IF NOT EXISTS tradelab_payment_events_provider_payment_idx
  ON public.tradelab_payment_events(provider_payment_id);

-- Explicit link to the internal, UUID-valued order. Keep the legacy payment_id column untouched.
ALTER TABLE public.challenge_accounts
  ADD COLUMN IF NOT EXISTS tradelab_payment_order_id uuid
  REFERENCES public.tradelab_payment_orders(id) ON DELETE RESTRICT;
ALTER TABLE public.challenge_accounts
  ADD COLUMN IF NOT EXISTS tradelab_min_trading_days integer;
ALTER TABLE public.challenge_accounts
  ADD COLUMN IF NOT EXISTS tradelab_daily_reset_timezone text;
CREATE UNIQUE INDEX IF NOT EXISTS challenge_accounts_tradelab_payment_order_uidx
  ON public.challenge_accounts(tradelab_payment_order_id);

ALTER TABLE public.tradelab_payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tradelab_payment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tradelab_payment_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.tradelab_payment_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tradelab_payment_orders TO service_role;
GRANT SELECT, INSERT ON TABLE public.tradelab_payment_events TO service_role;
GRANT SELECT ON TABLE public.users, public.challenges TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.challenge_accounts TO service_role;

CREATE OR REPLACE FUNCTION public.tradelab_apply_nowpayments_event(
  p_order_id uuid,
  p_payment_id text,
  p_invoice_id text,
  p_payment_status text,
  p_price_amount numeric,
  p_price_currency text,
  p_pay_currency text,
  p_pay_amount numeric,
  p_actually_paid numeric,
  p_payload jsonb,
  p_payload_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  order_row public.tradelab_payment_orders%ROWTYPE;
  account_id uuid;
  event_rows integer;
  received_status text := lower(btrim(coalesce(p_payment_status, '')));
  created_at_ms bigint := floor(extract(epoch FROM now()) * 1000)::bigint;
BEGIN
  IF p_order_id IS NULL OR coalesce(btrim(p_payment_id), '') = '' OR
     coalesce(btrim(p_payload_hash), '') = '' OR p_payload IS NULL THEN
    RAISE EXCEPTION 'Incomplete verified payment event.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO order_row
  FROM public.tradelab_payment_orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment order not found.' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.tradelab_payment_events (
    order_id, provider_payment_id, payment_status, payload_hash, payload
  ) VALUES (
    order_row.id, btrim(p_payment_id), received_status, p_payload_hash, p_payload
  ) ON CONFLICT (payload_hash) DO NOTHING;
  GET DIAGNOSTICS event_rows = ROW_COUNT;
  IF event_rows = 0 THEN
    RETURN jsonb_build_object('result', 'duplicate');
  END IF;

  IF order_row.status = 'settled' THEN
    IF received_status = 'refunded' THEN
      UPDATE public.tradelab_payment_orders
      SET status = 'manual_review', provider_status = received_status,
          provider_payment_id = btrim(p_payment_id), latest_payload = p_payload, updated_at = now()
      WHERE id = order_row.id;
      UPDATE public.challenge_accounts
      SET status = 'PAYMENT_REVIEW', updated_at = created_at_ms
      WHERE tradelab_payment_order_id = order_row.id;
      RETURN jsonb_build_object('result', 'refund_requires_review');
    END IF;
    RETURN jsonb_build_object('result', 'already_settled');
  END IF;

  IF p_invoice_id IS NOT NULL AND order_row.provider_invoice_id IS NOT NULL
     AND p_invoice_id <> order_row.provider_invoice_id THEN
    UPDATE public.tradelab_payment_orders
    SET status = 'manual_review', provider_status = received_status,
        provider_payment_id = btrim(p_payment_id), latest_payload = p_payload, updated_at = now()
    WHERE id = order_row.id;
    RETURN jsonb_build_object('result', 'invoice_mismatch');
  END IF;

  IF p_price_amount IS NULL OR abs(p_price_amount - order_row.fee_amount) > 0.01
     OR upper(coalesce(p_price_currency, '')) <> order_row.fee_currency THEN
    UPDATE public.tradelab_payment_orders
    SET status = 'manual_review', provider_status = received_status,
        received_price_amount = p_price_amount,
        received_price_currency = upper(coalesce(p_price_currency, '')),
        provider_payment_id = btrim(p_payment_id), latest_payload = p_payload, updated_at = now()
    WHERE id = order_row.id;
    RETURN jsonb_build_object('result', 'amount_or_currency_mismatch');
  END IF;

  IF order_row.status IN ('expired','failed','refunded','manual_review','invoice_error') THEN
    UPDATE public.tradelab_payment_orders
    SET status = 'manual_review', provider_status = received_status,
        provider_payment_id = btrim(p_payment_id), latest_payload = p_payload, updated_at = now()
    WHERE id = order_row.id;
    RETURN jsonb_build_object('result', 'terminal_order_requires_review');
  END IF;

  IF received_status = 'finished' THEN
    INSERT INTO public.challenge_accounts (
      user_id, challenge_id, challenge_name, starting_balance, balance, equity,
      available_margin, used_margin, unrealized_pl, realized_pl, status,
      trading_days, daily_pl, max_daily_loss, max_total_loss, profit_target,
      profit_target_value, current_drawdown, max_drawdown, peak_equity, progress,
      price_paid, currency_paid, payment_id, created_at, updated_at,
      tradelab_payment_order_id, tradelab_min_trading_days, tradelab_daily_reset_timezone
    ) VALUES (
      order_row.user_id, order_row.challenge_id, order_row.challenge_name,
      order_row.starting_balance, order_row.starting_balance, order_row.starting_balance,
      order_row.starting_balance, 0, 0, 0, 'ACTIVE', '[]'::jsonb, '{}'::jsonb,
      order_row.max_daily_loss, order_row.max_total_loss, order_row.profit_target,
      order_row.profit_target_value, 0, 0, order_row.starting_balance, 0,
      order_row.fee_amount::double precision, order_row.fee_currency, NULL,
      created_at_ms, created_at_ms, order_row.id,
      order_row.min_trading_days, order_row.daily_reset_timezone
    ) ON CONFLICT (tradelab_payment_order_id) DO NOTHING
    RETURNING id INTO account_id;

    IF account_id IS NULL THEN
      SELECT id INTO account_id FROM public.challenge_accounts
      WHERE tradelab_payment_order_id = order_row.id;
      IF account_id IS NULL THEN
        RAISE EXCEPTION 'Could not create challenge account for settled order.' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    UPDATE public.tradelab_payment_orders
    SET status = 'settled', provider_status = received_status,
        provider_payment_id = btrim(p_payment_id),
        received_price_amount = p_price_amount,
        received_price_currency = upper(p_price_currency),
        pay_currency = nullif(upper(coalesce(p_pay_currency, '')), ''),
        pay_amount = p_pay_amount, actually_paid = p_actually_paid,
        latest_payload = p_payload, updated_at = now(), settled_at = coalesce(settled_at, now())
    WHERE id = order_row.id;
    RETURN jsonb_build_object('result', 'settled', 'challenge_account_id', account_id);
  END IF;

  UPDATE public.tradelab_payment_orders
  SET status = CASE received_status
        WHEN 'waiting' THEN 'waiting'
        WHEN 'confirming' THEN 'confirming'
        WHEN 'confirmed' THEN 'confirming'
        WHEN 'sending' THEN 'confirming'
        WHEN 'partially_paid' THEN 'partially_paid'
        WHEN 'expired' THEN 'expired'
        WHEN 'failed' THEN 'failed'
        WHEN 'refunded' THEN 'manual_review'
        ELSE 'manual_review'
      END,
      provider_status = received_status,
      provider_payment_id = btrim(p_payment_id),
      received_price_amount = p_price_amount,
      received_price_currency = upper(coalesce(p_price_currency, '')),
      pay_currency = nullif(upper(coalesce(p_pay_currency, '')), ''),
      pay_amount = p_pay_amount, actually_paid = p_actually_paid,
      latest_payload = p_payload, updated_at = now()
  WHERE id = order_row.id;

  RETURN jsonb_build_object('result', CASE WHEN received_status IN ('waiting','confirming','confirmed','sending','partially_paid','expired','failed') THEN 'recorded' ELSE 'manual_review' END);
END;
$function$;

REVOKE ALL ON FUNCTION public.tradelab_apply_nowpayments_event(uuid, text, text, text, numeric, text, text, numeric, numeric, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tradelab_apply_nowpayments_event(uuid, text, text, text, numeric, text, text, numeric, numeric, jsonb, text)
  TO service_role;

COMMIT;
