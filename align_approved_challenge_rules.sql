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
