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
