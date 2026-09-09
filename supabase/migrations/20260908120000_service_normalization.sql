-- Fold the eight spellings of the promotional-products service into one.
--
-- Zoho's service multiselect has been edited over the years and the same service
-- now exists under eight different values, which is why the Service dropdown
-- offered two near-identical entries. Measured 2026-09-08 across zoho_accounts:
--
--   Imprimés, articles et vêtements promo             3793   ← agreed canonical
--   Imprimés, articles et  vêtements promotionnels      13
--   Imprimés                                             8
--   articles et vêtements promo                          5
--   Imprimés, articles et vêtements promotionnels        4
--   articles et  vêtements promotionnels                 3
--   Articles Promo                                       1
--
-- plus the same spread across zoho_leads.
--
-- zoho_service_key() already folds case and whitespace, which is why the two
-- double-space variants collapsed on their own. It cannot fold "promo" into
-- "promotionnels" — those are genuinely different strings — so the dropdown
-- showed both. This does that last step.
--
-- Applied as a TRIGGER rather than a one-off UPDATE. The syncs re-upsert these
-- rows every few hours straight from Zoho, so a one-off fix would be undone by
-- the next run; and normalising inside the two edge functions would put the rule
-- in two places that can drift. The trigger is the only spot every write goes
-- through.

-- ─── The rule ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION zoho_service_canonical(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH norm AS (
    -- lowercase, accents stripped, punctuation dropped, whitespace collapsed
    SELECT regexp_replace(
             regexp_replace(
               lower(translate(COALESCE(p_value, ''),
                               'àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ',
                               'aaaeeeeiioouuucAAAEEEEIIOOUUUC')),
               '[^a-z0-9 ]', ' ', 'g'),
             '\s+', ' ', 'g') AS k
  )
  SELECT CASE
    -- Anything that is imprimés / articles / vêtements + promo is this service,
    -- however it was typed. Written as a rule rather than a list of the eight
    -- known spellings so a ninth invented next month folds in on its own.
    WHEN (SELECT btrim(k) FROM norm) = '' THEN NULL
    WHEN (SELECT k FROM norm) LIKE '%promo%'
     AND ((SELECT k FROM norm) LIKE '%imprim%'
       OR (SELECT k FROM norm) LIKE '%article%'
       OR (SELECT k FROM norm) LIKE '%vetement%')
      THEN 'Imprimés, articles et vêtements promo'
    -- "Imprimés" on its own, with no "promo" to match above.
    WHEN btrim((SELECT k FROM norm)) IN ('imprimes', 'imprime')
      THEN 'Imprimés, articles et vêtements promo'
    ELSE btrim(p_value)
  END;
$$;

GRANT EXECUTE ON FUNCTION zoho_service_canonical(TEXT) TO authenticated;

COMMENT ON FUNCTION zoho_service_canonical(TEXT) IS
  'Folds every spelling of the promotional-products service onto one value. '
  'Applied by trigger on zoho_accounts and zoho_leads so a re-sync cannot undo '
  'it. Leaves every other service untouched.';

/** Normalises a whole multiselect array, dropping blanks and duplicates. */
CREATE OR REPLACE FUNCTION zoho_service_canonical_array(p_values TEXT[])
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT array_agg(DISTINCT c ORDER BY c)
       FROM (SELECT zoho_service_canonical(v) AS c
               FROM unnest(COALESCE(p_values, '{}')) AS v) x
      WHERE c IS NOT NULL AND btrim(c) <> ''),
    '{}');
$$;

GRANT EXECUTE ON FUNCTION zoho_service_canonical_array(TEXT[]) TO authenticated;

-- ─── The trigger ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION zoho_normalise_service_interest()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.service_interest := zoho_service_canonical_array(NEW.service_interest);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zoho_accounts_normalise_service ON zoho_accounts;
CREATE TRIGGER zoho_accounts_normalise_service
  BEFORE INSERT OR UPDATE OF service_interest ON zoho_accounts
  FOR EACH ROW EXECUTE FUNCTION zoho_normalise_service_interest();

DROP TRIGGER IF EXISTS zoho_leads_normalise_service ON zoho_leads;
CREATE TRIGGER zoho_leads_normalise_service
  BEFORE INSERT OR UPDATE OF service_interest ON zoho_leads
  FOR EACH ROW EXECUTE FUNCTION zoho_normalise_service_interest();

-- ─── Back-fill what is already stored ─────────────────────────────────────────

UPDATE zoho_accounts
   SET service_interest = zoho_service_canonical_array(service_interest)
 WHERE service_interest <> zoho_service_canonical_array(service_interest);

UPDATE zoho_leads
   SET service_interest = zoho_service_canonical_array(service_interest)
 WHERE service_interest <> zoho_service_canonical_array(service_interest);
