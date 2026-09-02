-- Stop the service filter from hiding half its own results.
--
-- Zoho's "Intérêt pour quel service" multi-select holds the same service under
-- two spellings that differ only in case:
--
--   Distribution publicitaire / Distribution Publicitaire   2,043 + 166 leads
--   Marketing numérique       / Marketing Numérique           123
--   Design et image de marque / Design et Image de marque      67
--   Développement d'application web / …d'application Web       14
--
-- The filter dropdown listed both, and picking either matched only that exact
-- spelling — so choosing "Distribution Publicitaire" returned 166 rows and
-- quietly omitted 2,043. Both options looked correct, which is what made it
-- worth fixing rather than documenting.
--
-- The list is now folded to one entry per service, labelled with the commonest
-- spelling. `service_variants` carries every raw spelling behind each label so
-- the caller can match on all of them at once (PostgREST `overlaps`), since the
-- stored array keeps Zoho's original casing and normalising the table itself
-- would just be overwritten by the next sync.

-- The canonical-label map (zoho_service_labels) is created in
-- 20260903010000_zoho_lead_dashboard_rpcs.sql, which the dashboard's
-- by-service breakdown also depends on. Defined once, used by both.

DROP FUNCTION IF EXISTS get_zoho_lead_filter_options(INT);

CREATE OR REPLACE FUNCTION get_zoho_lead_filter_options(p_year INT DEFAULT NULL)
RETURNS TABLE (
  sources          TEXT[],
  services         TEXT[],
  reps             TEXT[],
  -- { "Distribution publicitaire": ["Distribution publicitaire", "Distribution Publicitaire"], … }
  service_variants JSONB
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT lead_source, service_interest, rep_name
      FROM zoho_leads_unique
     WHERE p_year IS NULL
        OR (created_time >= make_timestamptz(p_year,     1, 1, 0, 0, 0, 'UTC')
        AND created_time <  make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'UTC'))
  ),
  -- Only the services actually present in scope, labelled from the global map so
  -- the same service always reads the same way.
  svc_folded AS (
    SELECT DISTINCT l.label, l.variants
      FROM scoped, LATERAL unnest(service_interest) AS s
      JOIN zoho_service_labels l ON l.key = zoho_service_key(s)
     WHERE btrim(s) <> ''
  )
  SELECT
    -- '-None-' is what Zoho stores in a picklist that was never set.
    (SELECT COALESCE(array_agg(DISTINCT lead_source ORDER BY lead_source), '{}')
       FROM scoped WHERE lead_source IS NOT NULL AND lead_source <> '-None-'),
    (SELECT COALESCE(array_agg(label ORDER BY label), '{}') FROM svc_folded),
    (SELECT COALESCE(array_agg(DISTINCT rep_name ORDER BY rep_name), '{}')
       FROM scoped WHERE rep_name IS NOT NULL AND rep_name <> ''),
    (SELECT COALESCE(jsonb_object_agg(label, to_jsonb(variants)), '{}'::jsonb) FROM svc_folded);
$$;

GRANT EXECUTE ON FUNCTION get_zoho_lead_filter_options(INT) TO authenticated;
