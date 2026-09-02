-- Rebuild the Leads dashboard on the real Zoho data.
--
-- The existing get_leads_* functions all read the legacy hand-entered `leads`
-- table: 192 rows, every one dated 2026-01-01, last touched 2026-05-14. The
-- dashboard and the rep portal were therefore reporting 192 leads and $122,611
-- for 2026 while Zoho held 1,743 leads and ~$1.0M of attributable invoicing.
-- Those functions are left in place — the legacy table stays as an archive — and
-- the app is pointed at these instead.
--
-- ─── Population: leads, not the lead/contact mix ──────────────────────────────
-- These read `zoho_leads WHERE stage = 'lead'`, i.e. Zoho's Leads module: the
-- people who came in. Two deliberate departures from the detail page:
--
--   * Not zoho_leads_unique. That view hides a converted lead behind the contact
--     it became, which is right for a directory but fatal for a funnel — the
--     converted leads are exactly what we are counting.
--   * Contacts are excluded. Most were created directly in Zoho as clients and
--     were never leads, so folding them in puts the conversion rate at ~99% and
--     inflates revenue roughly 6x (a 2026 "contact" is often a client billed
--     since 2021).
--
-- ─── Two conversion signals, because one is not enough ────────────────────────
-- Zoho's own flow marks 7,523 of 7,719 leads converted — 97%, which tells nobody
-- anything. Only 1,110 have ever produced an invoice. Both are reported:
-- `leads_converted` (Zoho flow) and `leads_invoiced` (real money).
--
-- Worth knowing: the two are nested, not overlapping. Every lead that has an
-- invoice is already flagged converted, so "converted OR invoiced" is identical
-- to "converted" — 1,680 either way for 2026. Reporting them as one number would
-- have hidden that.
--
-- ─── Revenue counted once per account ─────────────────────────────────────────
-- Several leads can point at the same account, so summing invoices per lead
-- double-counts. Every function below collapses to distinct accounts first.
--
-- `revenue_attributed` counts only invoices dated on or after the lead arrived —
-- a lead cannot have generated revenue that predates it. `revenue_lifetime` is
-- the account's whole billing history, which is a client-value figure, not an
-- attribution one. For 2026 leads: $998,461 attributed against $1,515,793
-- lifetime.

-- One canonical spelling per service, computed over the whole table rather than
-- per query. Deriving it inside each function made the displayed label depend on
-- the active filter -- "Marketing numérique" for one year, "Marketing Numérique"
-- for another -- which looks like a data change rather than a rounding of case.
--
-- security_invoker so the caller's RLS on zoho_leads still applies.
/**
 * The comparison key for a service picklist value: case-folded, with runs of
 * whitespace collapsed.
 *
 * Zoho's list has accumulated spelling drift over the years. Case accounts for
 * four pairs ("Distribution publicitaire" / "Distribution Publicitaire" and three
 * more, 2,409 lead-service pairs between them); a stray double space accounts for
 * another ("Imprimés, articles et  vêtements promotionnels").
 *
 * Deliberately does NOT merge values that differ in wording — "Imprimés, articles
 * et vêtements promo" against "…promotionnels", or the bare "Imprimés" and
 * "Articles Promo". Those may well be the same service renamed over time, but
 * deciding that is a business call, not a normalisation, so they stay as separate
 * rows for someone to tidy in Zoho.
 */
CREATE OR REPLACE FUNCTION zoho_service_key(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(regexp_replace(btrim(COALESCE(p_value, '')), '\s+', ' ', 'g'));
$$;

GRANT EXECUTE ON FUNCTION zoho_service_key(TEXT) TO authenticated;

CREATE OR REPLACE VIEW zoho_service_labels
WITH (security_invoker = true) AS
SELECT zoho_service_key(s)                          AS key,
       mode() WITHIN GROUP (ORDER BY btrim(s))      AS label,
       array_agg(DISTINCT btrim(s) ORDER BY btrim(s)) AS variants
  FROM zoho_leads z, LATERAL unnest(z.service_interest) AS s
 WHERE btrim(s) <> ''
 GROUP BY 1;


-- ─── Shared scoping ───────────────────────────────────────────────────────────

/**
 * The filtered lead population. Kept as one function so the KPI, the breakdowns
 * and the monthly summary can never drift apart on what "a lead" means.
 *
 * p_year NULL means every year, matching the detail page's "Toutes les années".
 */
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
     AND (p_year  IS NULL OR EXTRACT(YEAR  FROM z.created_time)::INT = p_year)
     AND (p_month IS NULL OR EXTRACT(MONTH FROM z.created_time)::INT = p_month)
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

-- ─── KPI row ──────────────────────────────────────────────────────────────────

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
      COALESCE(sum(i.amount) FILTER (WHERE i.invoice_date >= a.first_lead_at::date), 0) AS attributed,
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
           AND i.invoice_date >= s.created_time::date
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

-- ─── Breakdowns ───────────────────────────────────────────────────────────────
-- One shape for all three so the table component can stay generic. Revenue is
-- deduplicated per (dimension value, account): an account reached by two reps is
-- counted once for each of them, which is what a per-rep breakdown should show,
-- so the column can total higher than the KPI. That is intended, not a leak.

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
           COALESCE(sum(i.amount) FILTER (WHERE i.invoice_date >= a.first_lead_at::date), 0) AS amount
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
                AND i.invoice_date >= n.created_time::date)) AS nb_invoiced
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
           COALESCE(sum(i.amount) FILTER (WHERE i.invoice_date >= a.first_lead_at::date), 0) AS amount
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
                AND i.invoice_date >= n.created_time::date)) AS nb_invoiced
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

GRANT EXECUTE ON FUNCTION get_zoho_leads_by_source(INT, INT, TEXT, TEXT) TO authenticated;


CREATE OR REPLACE FUNCTION get_zoho_leads_by_service(
  p_year INT DEFAULT NULL, p_month INT DEFAULT NULL,
  p_rep TEXT DEFAULT NULL, p_source TEXT DEFAULT NULL
)
RETURNS TABLE (label TEXT, nb_leads BIGINT, nb_converted BIGINT, nb_invoiced BIGINT, total_amount NUMERIC)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  -- service_interest is a multi-select, so a lead can appear under several
  -- services. Rows therefore sum to more than the lead count, exactly as the
  -- multi-select implies.
  --
  -- Grouped on a case-folded key. Zoho's picklist carries four services under two
  -- spellings each -- "Distribution publicitaire" / "Distribution Publicitaire"
  -- and three more -- covering 2,409 lead-service pairs. Grouping on the raw value
  -- split each of them into two rows that both looked plausible, which is the
  -- worst kind of wrong. The label shown is the commonest spelling of the group.
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
           COALESCE(sum(i.amount) FILTER (WHERE i.invoice_date >= a.first_lead_at::date), 0) AS amount
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
                AND i.invoice_date >= n.created_time::date)) AS nb_invoiced
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

-- ─── Monthly summary (rep portal) ─────────────────────────────────────────────

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
    SELECT s.*, EXTRACT(MONTH FROM s.created_time)::BIGINT AS label FROM scoped s
  ),
  acct AS (
    SELECT n.label, n.account_id, min(n.created_time) AS first_lead_at
      FROM norm n WHERE n.account_id IS NOT NULL GROUP BY 1, 2
  ),
  rev AS (
    SELECT a.label,
           COALESCE(sum(i.amount) FILTER (WHERE i.invoice_date >= a.first_lead_at::date), 0) AS amount
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
                AND i.invoice_date >= n.created_time::date)) AS nb_invoiced
      FROM norm n
     GROUP BY n.label
  )
  SELECT c.label, c.nb_leads, c.nb_converted, c.nb_invoiced, COALESCE(r.amount, 0)
    FROM counts c
    LEFT JOIN rev r ON r.label = c.label
   ORDER BY c.label;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_leads_monthly_summary(INT, TEXT, TEXT, TEXT) TO authenticated;
