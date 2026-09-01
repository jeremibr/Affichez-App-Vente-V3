-- Let the Leads page filter across every year, not just one.
--
-- Records go back well before 2023, so a mandatory year filter hid most of the
-- data with no way to widen it. p_year NULL now means "all years".

DROP FUNCTION IF EXISTS get_zoho_lead_filter_options(INT);

CREATE OR REPLACE FUNCTION get_zoho_lead_filter_options(p_year INT DEFAULT NULL)
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
     WHERE p_year IS NULL
        OR (created_time >= make_timestamptz(p_year,     1, 1, 0, 0, 0, 'UTC')
        AND created_time <  make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'UTC'))
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

GRANT EXECUTE ON FUNCTION get_zoho_lead_filter_options(INT) TO authenticated;
