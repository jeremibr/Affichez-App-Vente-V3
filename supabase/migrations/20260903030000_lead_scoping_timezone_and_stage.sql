-- Two corrections to how the Leads dashboard slices its data.
--
-- ─── 1. Filter dropdowns offered values that could never match ────────────────
--
-- get_zoho_lead_filter_options built its lists from zoho_leads_unique, which is
-- leads AND contacts. The dashboard feeds those values straight into
-- get_zoho_lead_kpis, which counts only `stage = 'lead'`. Any rep, source or
-- service carried solely by contacts therefore appeared in the dropdown and
-- returned an all-zero dashboard — which reads as broken data, not as an empty
-- filter. Contacts outnumber leads roughly three to one here, so this was not a
-- rare corner.
--
-- p_stage NULL keeps the old behaviour for the detail page, which genuinely does
-- show both stages.
--
-- ─── 2. Year and month were counted in UTC, not in Montreal ───────────────────
--
-- The database session runs in UTC (PostgREST renders timestamptz as +00:00), so
-- EXTRACT(MONTH FROM created_time) folded a timestamptz that Zoho stamped at
-- -04:00/-05:00. A lead created 31 January at 21:00 EST counted as February, and
-- created_time::date opened its attribution window a day late, excluding an
-- invoice raised that same evening.
--
-- It is about 0.6% of leads landing in the wrong month — small, but it is enough
-- that the dashboard never quite agrees with Zoho's own monthly report, and a
-- number that is nearly right is harder to trust than one that is plainly wrong.
--
-- 'America/Toronto' rather than a fixed -05:00: Quebec observes DST, and a fixed
-- offset would be wrong for seven months of the year.

CREATE OR REPLACE FUNCTION zoho_leads_scoped(
  p_year    INT  DEFAULT NULL,
  p_month   INT  DEFAULT NULL,
  p_rep     TEXT DEFAULT NULL,
  p_source  TEXT DEFAULT NULL,
  p_service TEXT DEFAULT NULL
)
RETURNS TABLE (
  zoho_record_id TEXT,
  account_id     TEXT,
  created_time   TIMESTAMPTZ,
  is_converted   BOOLEAN,
  rep_name       TEXT,
  lead_source    TEXT,
  service_interest TEXT[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT z.zoho_record_id, z.account_id, z.created_time, z.is_converted,
         z.rep_name, z.lead_source, z.service_interest
    FROM zoho_leads z
   WHERE z.stage = 'lead'
     -- AT TIME ZONE turns the timestamptz into local wall-clock time before the
     -- calendar fields are read, so a lead belongs to the month a rep in Quebec
     -- would say it arrived in.
     AND (p_year  IS NULL OR EXTRACT(YEAR  FROM z.created_time AT TIME ZONE 'America/Toronto')::INT = p_year)
     AND (p_month IS NULL OR EXTRACT(MONTH FROM z.created_time AT TIME ZONE 'America/Toronto')::INT = p_month)
     AND (p_rep     IS NULL OR z.rep_name    = p_rep)
     AND (p_source  IS NULL OR z.lead_source = p_source)
     -- Case-insensitive: Zoho's multi-select holds both "Distribution publicitaire"
     -- and "Distribution Publicitaire" (2,043 vs 166 leads). An exact @> match
     -- would silently drop one spelling.
     AND (p_service IS NULL OR EXISTS (
           SELECT 1 FROM unnest(z.service_interest) AS v
            WHERE zoho_service_key(v) = zoho_service_key(p_service)
         ));
$$;

GRANT EXECUTE ON FUNCTION zoho_leads_scoped(INT, INT, TEXT, TEXT, TEXT) TO authenticated;


/**
 * The local date a lead arrived. Every attribution window in the dashboard opens
 * here, so the cast lives in one place rather than being repeated as
 * `created_time::date` — which silently meant "the UTC date" — in five functions.
 */
CREATE OR REPLACE FUNCTION zoho_lead_local_date(p_at TIMESTAMPTZ)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (p_at AT TIME ZONE 'America/Toronto')::date;
$$;

GRANT EXECUTE ON FUNCTION zoho_lead_local_date(TIMESTAMPTZ) TO authenticated;


-- ─── Filter options, now stage-aware ──────────────────────────────────────────

DROP FUNCTION IF EXISTS get_zoho_lead_filter_options(INT);

CREATE OR REPLACE FUNCTION get_zoho_lead_filter_options(
  p_year  INT  DEFAULT NULL,
  -- 'lead' or 'contact' to match one module; NULL for both, which is what the
  -- detail page wants.
  p_stage TEXT DEFAULT NULL
)
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
     WHERE (p_stage IS NULL OR stage = p_stage)
       -- Bounded on the local calendar year, to agree with zoho_leads_scoped.
       AND (p_year IS NULL
            OR EXTRACT(YEAR FROM created_time AT TIME ZONE 'America/Toronto')::INT = p_year)
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

GRANT EXECUTE ON FUNCTION get_zoho_lead_filter_options(INT, TEXT) TO authenticated;


-- ─── The five consumers, re-pointed at the local-date helper ──────────────────
-- Bodies are otherwise unchanged from 20260903010000_zoho_lead_dashboard_rpcs.sql;
-- every `::date` on a lead timestamp becomes zoho_lead_local_date(), and the
-- monthly summary's month label is read on the local calendar too — that one was
-- the most visible, since it decides which bar a lead lands in.

CREATE OR REPLACE FUNCTION get_zoho_lead_kpis(
  p_year    INT  DEFAULT NULL,
  p_month   INT  DEFAULT NULL,
  p_rep     TEXT DEFAULT NULL,
  p_source  TEXT DEFAULT NULL,
  p_service TEXT DEFAULT NULL
)
RETURNS TABLE (
  leads_received     BIGINT,
  leads_converted    BIGINT,
  leads_invoiced     BIGINT,
  conversion_rate    NUMERIC,
  invoiced_rate      NUMERIC,
  revenue_attributed NUMERIC,
  revenue_lifetime   NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_leads_scoped(p_year, p_month, p_rep, p_source, p_service)
  ),
  -- One row per account, dated by the earliest lead in scope that points at it,
  -- so revenue is counted once no matter how many leads share the account.
  acct AS (
    SELECT s.account_id, min(s.created_time) AS first_lead_at
      FROM scoped s
     WHERE s.account_id IS NOT NULL
     GROUP BY s.account_id
  ),
  rev AS (
    SELECT
      COALESCE(sum(i.amount) FILTER (WHERE i.invoice_date >= zoho_lead_local_date(a.first_lead_at)), 0) AS attributed,
      COALESCE(sum(i.amount), 0) AS lifetime
      FROM acct a
      JOIN invoices i ON i.crm_account_id = a.account_id
  ),
  counts AS (
    SELECT
      count(*) AS received,
      count(*) FILTER (WHERE s.is_converted) AS converted,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM invoices i
         WHERE i.crm_account_id = s.account_id
           AND i.invoice_date >= zoho_lead_local_date(s.created_time)
      )) AS invoiced
      FROM scoped s
  )
  SELECT
    c.received,
    c.converted,
    c.invoiced,
    CASE WHEN c.received = 0 THEN 0
         ELSE ROUND(c.converted * 100.0 / c.received, 1) END,
    CASE WHEN c.received = 0 THEN 0
         ELSE ROUND(c.invoiced * 100.0 / c.received, 1) END,
    COALESCE((SELECT attributed FROM rev), 0),
    COALESCE((SELECT lifetime   FROM rev), 0)
  FROM counts c;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_lead_kpis(INT, INT, TEXT, TEXT, TEXT) TO authenticated;


CREATE OR REPLACE FUNCTION get_zoho_leads_by_rep(
  p_year INT DEFAULT NULL, p_month INT DEFAULT NULL,
  p_source TEXT DEFAULT NULL, p_service TEXT DEFAULT NULL
)
RETURNS TABLE (label TEXT, nb_leads BIGINT, nb_converted BIGINT, nb_invoiced BIGINT, total_amount NUMERIC)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_leads_scoped(p_year, p_month, NULL, p_source, p_service)
  ),
  norm AS (
    SELECT s.*, COALESCE(NULLIF(btrim(s.rep_name), ''), 'Non assigné') AS label
      FROM scoped s
  ),
  acct AS (
    SELECT n.label, n.account_id, min(n.created_time) AS first_lead_at
      FROM norm n WHERE n.account_id IS NOT NULL GROUP BY 1, 2
  ),
  rev AS (
    SELECT a.label,
           COALESCE(sum(i.amount) FILTER (WHERE i.invoice_date >= zoho_lead_local_date(a.first_lead_at)), 0) AS amount
      FROM acct a JOIN invoices i ON i.crm_account_id = a.account_id
     GROUP BY a.label
  ),
  counts AS (
    SELECT n.label,
           count(*) AS nb_leads,
           count(*) FILTER (WHERE n.is_converted) AS nb_converted,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM invoices i
              WHERE i.crm_account_id = n.account_id
                AND i.invoice_date >= zoho_lead_local_date(n.created_time))) AS nb_invoiced
      FROM norm n
     GROUP BY n.label
  )
  -- Joined rather than correlated: `label` is a grouped expression, and Postgres
  -- will not resolve it inside a scalar subquery in the select list.
  SELECT c.label, c.nb_leads, c.nb_converted, c.nb_invoiced, COALESCE(r.amount, 0)
    FROM counts c
    LEFT JOIN rev r ON r.label = c.label
   ORDER BY c.nb_leads DESC;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_leads_by_rep(INT, INT, TEXT, TEXT) TO authenticated;


CREATE OR REPLACE FUNCTION get_zoho_leads_by_source(
  p_year INT DEFAULT NULL, p_month INT DEFAULT NULL,
  p_rep TEXT DEFAULT NULL, p_service TEXT DEFAULT NULL
)
RETURNS TABLE (label TEXT, nb_leads BIGINT, nb_converted BIGINT, nb_invoiced BIGINT, total_amount NUMERIC)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_leads_scoped(p_year, p_month, p_rep, NULL, p_service)
  ),
  -- '-None-' is what Zoho stores in a picklist that was never set; it and NULL
  -- mean the same thing to a reader.
  norm AS (
    SELECT s.*, CASE WHEN s.lead_source IS NULL OR s.lead_source = '-None-'
                     THEN 'Non renseignée' ELSE s.lead_source END AS label
      FROM scoped s
  ),
  acct AS (
    SELECT n.label, n.account_id, min(n.created_time) AS first_lead_at
      FROM norm n WHERE n.account_id IS NOT NULL GROUP BY 1, 2
  ),
  rev AS (
    SELECT a.label,
           COALESCE(sum(i.amount) FILTER (WHERE i.invoice_date >= zoho_lead_local_date(a.first_lead_at)), 0) AS amount
      FROM acct a JOIN invoices i ON i.crm_account_id = a.account_id
     GROUP BY a.label
  ),
  counts AS (
    SELECT n.label,
           count(*) AS nb_leads,
           count(*) FILTER (WHERE n.is_converted) AS nb_converted,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM invoices i
              WHERE i.crm_account_id = n.account_id
                AND i.invoice_date >= zoho_lead_local_date(n.created_time))) AS nb_invoiced
      FROM norm n
     GROUP BY n.label
  )
  SELECT c.label, c.nb_leads, c.nb_converted, c.nb_invoiced, COALESCE(r.amount, 0)
    FROM counts c
    LEFT JOIN rev r ON r.label = c.label
   ORDER BY c.nb_leads DESC;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_leads_by_source(INT, INT, TEXT, TEXT) TO authenticated;


CREATE OR REPLACE FUNCTION get_zoho_leads_by_service(
  p_year INT DEFAULT NULL, p_month INT DEFAULT NULL,
  p_rep TEXT DEFAULT NULL, p_source TEXT DEFAULT NULL
)
RETURNS TABLE (label TEXT, nb_leads BIGINT, nb_converted BIGINT, nb_invoiced BIGINT, total_amount NUMERIC)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_leads_scoped(p_year, p_month, p_rep, p_source, NULL)
  ),
  norm AS (
    SELECT s.*,
           COALESCE(NULLIF(btrim(svc), ''), 'Non renseigné')        AS raw,
           zoho_service_key(COALESCE(NULLIF(btrim(svc), ''), 'Non renseigné')) AS key
      FROM scoped s
      LEFT JOIN LATERAL unnest(
        CASE WHEN cardinality(s.service_interest) = 0 THEN ARRAY[NULL::TEXT]
             ELSE s.service_interest END
      ) AS svc ON TRUE
  ),
  acct AS (
    SELECT n.key, n.account_id, min(n.created_time) AS first_lead_at
      FROM norm n WHERE n.account_id IS NOT NULL GROUP BY 1, 2
  ),
  rev AS (
    SELECT a.key,
           COALESCE(sum(i.amount) FILTER (WHERE i.invoice_date >= zoho_lead_local_date(a.first_lead_at)), 0) AS amount
      FROM acct a JOIN invoices i ON i.crm_account_id = a.account_id
     GROUP BY a.key
  ),
  counts AS (
    SELECT n.key,
           -- Label from the shared map (zoho_service_labels), not from this
           -- query's rows, so it does not shift with the filters.
           COALESCE(max(l.label), max(n.raw)) AS label,
           count(*) AS nb_leads,
           count(*) FILTER (WHERE n.is_converted) AS nb_converted,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM invoices i
              WHERE i.crm_account_id = n.account_id
                AND i.invoice_date >= zoho_lead_local_date(n.created_time))) AS nb_invoiced
      FROM norm n
      LEFT JOIN zoho_service_labels l ON l.key = n.key
     GROUP BY n.key
  )
  SELECT c.label, c.nb_leads, c.nb_converted, c.nb_invoiced, COALESCE(r.amount, 0)
    FROM counts c
    LEFT JOIN rev r ON r.key = c.key
   ORDER BY c.nb_leads DESC;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_leads_by_service(INT, INT, TEXT, TEXT) TO authenticated;


CREATE OR REPLACE FUNCTION get_zoho_leads_monthly_summary(
  p_year INT, p_rep TEXT DEFAULT NULL,
  p_source TEXT DEFAULT NULL, p_service TEXT DEFAULT NULL
)
RETURNS TABLE (
  month BIGINT, nb_leads BIGINT, nb_converted BIGINT, nb_invoiced BIGINT, total_amount NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_leads_scoped(p_year, NULL, p_rep, p_source, p_service)
  ),
  norm AS (
    -- Local calendar month, matching the p_month filter in zoho_leads_scoped. On
    -- UTC the two disagreed for leads created after ~19:00 on the last day of a
    -- month, which put them in the following bar.
    SELECT s.*, EXTRACT(MONTH FROM s.created_time AT TIME ZONE 'America/Toronto')::BIGINT AS label
      FROM scoped s
  ),
  acct AS (
    SELECT n.label, n.account_id, min(n.created_time) AS first_lead_at
      FROM norm n WHERE n.account_id IS NOT NULL GROUP BY 1, 2
  ),
  rev AS (
    SELECT a.label,
           COALESCE(sum(i.amount) FILTER (WHERE i.invoice_date >= zoho_lead_local_date(a.first_lead_at)), 0) AS amount
      FROM acct a JOIN invoices i ON i.crm_account_id = a.account_id
     GROUP BY a.label
  ),
  counts AS (
    SELECT n.label,
           count(*) AS nb_leads,
           count(*) FILTER (WHERE n.is_converted) AS nb_converted,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM invoices i
              WHERE i.crm_account_id = n.account_id
                AND i.invoice_date >= zoho_lead_local_date(n.created_time))) AS nb_invoiced
      FROM norm n
     GROUP BY n.label
  )
  SELECT c.label, c.nb_leads, c.nb_converted, c.nb_invoiced, COALESCE(r.amount, 0)
    FROM counts c
    LEFT JOIN rev r ON r.label = c.label
   ORDER BY c.label;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_leads_monthly_summary(INT, TEXT, TEXT, TEXT) TO authenticated;
