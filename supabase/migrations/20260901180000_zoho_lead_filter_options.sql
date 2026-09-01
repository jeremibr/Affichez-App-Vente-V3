-- Distinct values for the Leads page filter dropdowns.
--
-- These were being derived in the browser from a capped 5,000-row fetch. With
-- ~29k records that silently truncates the option lists — a source used only by
-- older records would simply not appear in the filter, with no indication that
-- anything was missing. Postgres does the DISTINCT instead, and returns a few
-- dozen strings rather than thousands of rows.

CREATE OR REPLACE FUNCTION get_zoho_lead_filter_options(p_year INT)
RETURNS TABLE (
  sources  TEXT[],
  services TEXT[],
  reps     TEXT[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT lead_source, service_interest, rep_name
      FROM zoho_leads_unique
     WHERE created_time >= make_timestamptz(p_year,     1, 1, 0, 0, 0, 'UTC')
       AND created_time <  make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'UTC')
  )
  SELECT
    -- '-None-' is what Zoho stores in a picklist that was never set.
    (SELECT COALESCE(array_agg(DISTINCT lead_source ORDER BY lead_source), '{}')
       FROM scoped WHERE lead_source IS NOT NULL AND lead_source <> '-None-'),
    (SELECT COALESCE(array_agg(DISTINCT s ORDER BY s), '{}')
       FROM scoped, LATERAL unnest(service_interest) AS s WHERE s <> ''),
    (SELECT COALESCE(array_agg(DISTINCT rep_name ORDER BY rep_name), '{}')
       FROM scoped WHERE rep_name IS NOT NULL AND rep_name <> '');
$$;

-- SECURITY INVOKER above means the caller's RLS applies, so this grants no more
-- visibility than a direct select would.
GRANT EXECUTE ON FUNCTION get_zoho_lead_filter_options(INT) TO authenticated;
