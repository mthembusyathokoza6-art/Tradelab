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
