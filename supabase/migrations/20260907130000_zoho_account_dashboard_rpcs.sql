-- The Comptes module's read layer.
--
-- Sibling of 20260903010000 + 20260903030000 (the leads dashboard), and
-- deliberately the same shapes so the table components can be shared. Three
-- things differ, and they are the reason this is a separate file rather than a
-- parameter on the lead RPCs:
--
--   1. GRAIN. An account is already unique. The lead RPCs carry a per-account
--      dedupe layer (`min(created_time) AS first_lead_at` grouped by account_id)
--      because several leads can point at one account and each would otherwise
--      claim the same invoices. Here one row is one account, so revenue needs no
--      dedupe at all and the queries are simpler, not more complex.
--
--   2. THE WINDOW. "Les leads de juillet, ils ont acheté combien dans les 12
--      mois après?" — p_window_months caps attributed revenue at N months from
--      the account's creation. Without it an account from 2021 outperforms one
--      from 2026 purely by having had five more years to buy, which makes every
--      month-over-month source comparison a lie. NULL means no cap.
--
--   3. RATINGS. Zoho marks 1,937 accounts "Compte interne : Ne pas reprendre"
--      and 3 "Fournisseur" — Affichez's own entities. They stay in the table and
--      remain reachable, but every RPC here defaults to excluding them, because
--      LUMEN (Hydro-Québec) alone would otherwise sit at the top of the client
--      list with six figures of internal billing. Pass p_exclude_ratings => NULL
--      for the unfiltered book.

-- ─── Shared date helper ───────────────────────────────────────────────────────
-- Same rule as the leads side: the session runs in UTC, so a bare ::date puts an
-- account created 31 January at 21:00 EST into February. 'America/Toronto', not
-- a fixed -05:00, because Quebec observes DST.
--
-- zoho_lead_local_date() already did exactly this. Rather than write a second
-- copy that has to stay in lockstep with it, the general-purpose name is defined
-- here and the lead-named one is redefined to delegate — same semantics, one
-- implementation, and neither module has to call a helper named for the other.

CREATE OR REPLACE FUNCTION zoho_local_date(p_at TIMESTAMPTZ)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (p_at AT TIME ZONE 'America/Toronto')::date;
$$;

GRANT EXECUTE ON FUNCTION zoho_local_date(TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION zoho_lead_local_date(p_at TIMESTAMPTZ)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT zoho_local_date(p_at);
$$;

GRANT EXECUTE ON FUNCTION zoho_lead_local_date(TIMESTAMPTZ) TO authenticated;

-- ─── The two bulk-imported books ──────────────────────────────────────────────
-- "Client Royer & Fils / VotreLogo.ca" (2,028 accounts) and "Client PLOGG/BUCCO"
-- (380) were not won by a campaign — they arrived as acquired customer lists and
-- were mass-created, then mass-converted. They stay in every count, but the
-- source chart marks them, so a Meta Ads bar of 1,233 is never read against a
-- 2,028-account import as though the two measured the same thing.

CREATE OR REPLACE FUNCTION zoho_account_is_bulk_import(p_source TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(p_source, '') IN (
    'Client Royer & Fils / VotreLogo.ca',
    'Client PLOGG/BUCCO'
  );
$$;

GRANT EXECUTE ON FUNCTION zoho_account_is_bulk_import(TEXT) TO authenticated;

-- ─── Shared scoping ───────────────────────────────────────────────────────────
-- Every RPC below funnels through this, so a filter added here reaches the KPI
-- row and all five breakdowns at once and they cannot drift apart.

DROP FUNCTION IF EXISTS zoho_accounts_scoped(INT, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]);

CREATE OR REPLACE FUNCTION zoho_accounts_scoped(
  p_year            INT    DEFAULT NULL,
  p_month           INT    DEFAULT NULL,
  p_rep             TEXT   DEFAULT NULL,
  p_source          TEXT   DEFAULT NULL,
  p_service         TEXT   DEFAULT NULL,
  p_domaine         TEXT   DEFAULT NULL,
  p_region          TEXT   DEFAULT NULL,
  p_exclude_ratings TEXT[] DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur']
)
RETURNS TABLE (
  zoho_account_id   TEXT,
  account_name      TEXT,
  created_time      TIMESTAMPTZ,
  created_date      DATE,
  rep_name          TEXT,
  origine_du_client TEXT,
  service_interest  TEXT[],
  domaine_activite  TEXT,
  region_administrative TEXT,
  rating            TEXT,
  is_bulk_import    BOOLEAN,
  ventes_totales    NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    a.zoho_account_id, a.account_name, a.created_time,
    zoho_local_date(a.created_time),
    a.rep_name, a.origine_du_client, a.service_interest,
    a.domaine_activite, a.region_administrative, a.rating,
    zoho_account_is_bulk_import(a.origine_du_client),
    a.ventes_totales
  FROM zoho_accounts a
  WHERE a.created_time IS NOT NULL
    AND (p_year  IS NULL OR EXTRACT(YEAR  FROM a.created_time AT TIME ZONE 'America/Toronto')::INT = p_year)
    AND (p_month IS NULL OR EXTRACT(MONTH FROM a.created_time AT TIME ZONE 'America/Toronto')::INT = p_month)
    AND (p_rep     IS NULL OR a.rep_name          = p_rep)
    AND (p_source  IS NULL OR a.origine_du_client = p_source)
    AND (p_domaine IS NULL OR a.domaine_activite  = p_domaine)
    AND (p_region  IS NULL OR a.region_administrative = p_region)
    -- Case- and space-insensitive, like the leads side: Zoho's service picklist
    -- holds the same service under several spellings and an exact @> match
    -- silently drops all but one.
    AND (p_service IS NULL OR EXISTS (
          SELECT 1 FROM unnest(a.service_interest) AS v
           WHERE zoho_service_key(v) = zoho_service_key(p_service)
        ))
    -- NULL means "no exclusions" so a caller can ask for the unfiltered book;
    -- omitting the argument gets the dashboard's default instead. An account with
    -- no rating at all (977 of them) is never excluded by this.
    AND (p_exclude_ratings IS NULL
         OR a.rating IS NULL
         OR NOT (a.rating = ANY(p_exclude_ratings)));
$$;

GRANT EXECUTE ON FUNCTION zoho_accounts_scoped(INT, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO authenticated;

-- ─── Attribution window ───────────────────────────────────────────────────────
-- The exclusive upper bound on an account's attributed revenue. NULL months
-- means uncapped, expressed as 'infinity' so callers need no branch.

CREATE OR REPLACE FUNCTION zoho_account_window_end(p_created TIMESTAMPTZ, p_months INT)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_months IS NULL THEN 'infinity'::date
    ELSE (zoho_local_date(p_created) + make_interval(months => p_months))::date
  END;
$$;

GRANT EXECUTE ON FUNCTION zoho_account_window_end(TIMESTAMPTZ, INT) TO authenticated;

-- ─── KPI row ──────────────────────────────────────────────────────────────────
--
-- revenue_per_account is the figure the whole module exists for: what a month's
-- or a source's accounts actually billed, per account acquired. Divided by
-- accounts_created and not by accounts_invoiced on purpose — the accounts that
-- bought nothing are exactly what makes a bad source bad, and dropping them from
-- the denominator would hide it.
--
-- ventes_royer is reported beside the invoice figures, never inside them. It is
-- the Royer & Fils / VotreLogo.ca promo business, billed outside the QC and MTL
-- Books orgs and reaching the app only through a CRM rollup field.

CREATE OR REPLACE FUNCTION get_zoho_account_kpis(
  p_year            INT    DEFAULT NULL,
  p_month           INT    DEFAULT NULL,
  p_rep             TEXT   DEFAULT NULL,
  p_source          TEXT   DEFAULT NULL,
  p_service         TEXT   DEFAULT NULL,
  p_domaine         TEXT   DEFAULT NULL,
  p_region          TEXT   DEFAULT NULL,
  p_window_months   INT    DEFAULT 12,
  p_exclude_ratings TEXT[] DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur']
)
RETURNS TABLE (
  accounts_created    BIGINT,
  accounts_invoiced   BIGINT,
  invoiced_rate       NUMERIC,
  revenue_attributed  NUMERIC,
  revenue_lifetime    NUMERIC,
  revenue_per_account NUMERIC,
  avg_days_to_first_invoice NUMERIC,
  ventes_royer        NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, p_service, p_domaine, p_region, p_exclude_ratings)
  ),
  -- One pass over invoices per account. No GROUP BY on account_id first, unlike
  -- the leads version: scoped rows are already one per account.
  per_acct AS (
    SELECT
      s.zoho_account_id,
      s.created_date,
      s.ventes_totales,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS attributed,
      COALESCE(sum(i.amount), 0) AS lifetime,
      min(i.invoice_date) FILTER (WHERE i.invoice_date >= s.created_date) AS first_inv
    FROM scoped s
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY s.zoho_account_id, s.created_date, s.created_time, s.ventes_totales
  )
  SELECT
    count(*),
    count(*) FILTER (WHERE p.attributed <> 0),
    CASE WHEN count(*) = 0 THEN 0
         ELSE ROUND(count(*) FILTER (WHERE p.attributed <> 0) * 100.0 / count(*), 1) END,
    COALESCE(sum(p.attributed), 0),
    COALESCE(sum(p.lifetime), 0),
    CASE WHEN count(*) = 0 THEN 0
         ELSE ROUND(COALESCE(sum(p.attributed), 0) / count(*), 2) END,
    ROUND(AVG(p.first_inv - p.created_date) FILTER (WHERE p.first_inv IS NOT NULL), 1),
    COALESCE(sum(p.ventes_totales), 0)
  FROM per_acct p;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_account_kpis(INT, INT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT[]) TO authenticated;

-- ─── Breakdowns ───────────────────────────────────────────────────────────────
-- One shape for all of them so the table component stays generic:
--   label · nb_accounts · nb_invoiced · total_amount · revenue_per_account
--
-- by_rep / by_source / by_domaine / monthly each put an account in exactly one
-- bucket, so their nb_accounts columns total to the KPI. by_service does NOT:
-- the service field is a multiselect, so an account interested in two services
-- appears under both and the column totals higher. That is what a per-service
-- breakdown should show, and it is the same behaviour as the leads page.

CREATE OR REPLACE FUNCTION get_zoho_accounts_by_rep(
  p_year INT DEFAULT NULL, p_month INT DEFAULT NULL,
  p_source TEXT DEFAULT NULL, p_service TEXT DEFAULT NULL,
  p_domaine TEXT DEFAULT NULL, p_region TEXT DEFAULT NULL,
  p_window_months INT DEFAULT 12,
  p_exclude_ratings TEXT[] DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur']
)
RETURNS TABLE (label TEXT, nb_accounts BIGINT, nb_invoiced BIGINT,
               total_amount NUMERIC, revenue_per_account NUMERIC, is_bulk_import BOOLEAN)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, NULL, p_source, p_service, p_domaine, p_region, p_exclude_ratings)
  ),
  per_acct AS (
    SELECT
      COALESCE(s.rep_name, 'Non assigné') AS label,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2
  )
  SELECT p.label, count(*), count(*) FILTER (WHERE p.amount <> 0),
         COALESCE(sum(p.amount), 0),
         ROUND(COALESCE(sum(p.amount), 0) / NULLIF(count(*), 0), 2),
         FALSE
  FROM per_acct p
  GROUP BY p.label
  ORDER BY 4 DESC, 2 DESC;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_accounts_by_rep(INT, INT, TEXT, TEXT, TEXT, TEXT, INT, TEXT[]) TO authenticated;

CREATE OR REPLACE FUNCTION get_zoho_accounts_by_source(
  p_year INT DEFAULT NULL, p_month INT DEFAULT NULL,
  p_rep TEXT DEFAULT NULL, p_service TEXT DEFAULT NULL,
  p_domaine TEXT DEFAULT NULL, p_region TEXT DEFAULT NULL,
  p_window_months INT DEFAULT 12,
  p_exclude_ratings TEXT[] DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur']
)
RETURNS TABLE (label TEXT, nb_accounts BIGINT, nb_invoiced BIGINT,
               total_amount NUMERIC, revenue_per_account NUMERIC, is_bulk_import BOOLEAN)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, NULL, p_service, p_domaine, p_region, p_exclude_ratings)
  ),
  per_acct AS (
    SELECT
      COALESCE(s.origine_du_client, 'Non renseignée') AS label,
      s.is_bulk_import,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2, 3
  )
  SELECT p.label, count(*), count(*) FILTER (WHERE p.amount <> 0),
         COALESCE(sum(p.amount), 0),
         ROUND(COALESCE(sum(p.amount), 0) / NULLIF(count(*), 0), 2),
         bool_or(p.is_bulk_import)
  FROM per_acct p
  GROUP BY p.label
  ORDER BY 4 DESC, 2 DESC;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_accounts_by_source(INT, INT, TEXT, TEXT, TEXT, TEXT, INT, TEXT[]) TO authenticated;

CREATE OR REPLACE FUNCTION get_zoho_accounts_by_service(
  p_year INT DEFAULT NULL, p_month INT DEFAULT NULL,
  p_rep TEXT DEFAULT NULL, p_source TEXT DEFAULT NULL,
  p_domaine TEXT DEFAULT NULL, p_region TEXT DEFAULT NULL,
  p_window_months INT DEFAULT 12,
  p_exclude_ratings TEXT[] DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur']
)
RETURNS TABLE (label TEXT, nb_accounts BIGINT, nb_invoiced BIGINT,
               total_amount NUMERIC, revenue_per_account NUMERIC, is_bulk_import BOOLEAN)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, NULL, p_domaine, p_region, p_exclude_ratings)
  ),
  -- Folded through zoho_service_key so "Distribution publicitaire" and
  -- "Distribution Publicitaire" land in one bar, then labelled from
  -- zoho_service_labels so the bar keeps Zoho's own spelling.
  per_acct AS (
    SELECT
      COALESCE(l.label, btrim(v))    AS label,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    CROSS JOIN LATERAL unnest(s.service_interest) AS v
    LEFT JOIN zoho_service_labels l ON l.key = zoho_service_key(v)
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    WHERE btrim(v) <> ''
    GROUP BY 1, 2
  )
  SELECT p.label, count(*), count(*) FILTER (WHERE p.amount <> 0),
         COALESCE(sum(p.amount), 0),
         ROUND(COALESCE(sum(p.amount), 0) / NULLIF(count(*), 0), 2),
         FALSE
  FROM per_acct p
  GROUP BY p.label
  ORDER BY 4 DESC, 2 DESC;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_accounts_by_service(INT, INT, TEXT, TEXT, TEXT, TEXT, INT, TEXT[]) TO authenticated;

-- Domaine d'activité — 53 values, 68% populated. The vertical Dominic segments
-- by ("les dentistes", "le domaine dentaire"), and the one breakdown the leads
-- page never had because a Lead does not carry the field.
CREATE OR REPLACE FUNCTION get_zoho_accounts_by_domaine(
  p_year INT DEFAULT NULL, p_month INT DEFAULT NULL,
  p_rep TEXT DEFAULT NULL, p_source TEXT DEFAULT NULL, p_service TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_window_months INT DEFAULT 12,
  p_exclude_ratings TEXT[] DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur']
)
RETURNS TABLE (label TEXT, nb_accounts BIGINT, nb_invoiced BIGINT,
               total_amount NUMERIC, revenue_per_account NUMERIC, is_bulk_import BOOLEAN)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, p_service, NULL, p_region, p_exclude_ratings)
  ),
  per_acct AS (
    SELECT
      COALESCE(s.domaine_activite, 'Non renseigné') AS label,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2
  )
  SELECT p.label, count(*), count(*) FILTER (WHERE p.amount <> 0),
         COALESCE(sum(p.amount), 0),
         ROUND(COALESCE(sum(p.amount), 0) / NULLIF(count(*), 0), 2),
         FALSE
  FROM per_acct p
  GROUP BY p.label
  ORDER BY 4 DESC, 2 DESC;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_accounts_by_domaine(INT, INT, TEXT, TEXT, TEXT, TEXT, INT, TEXT[]) TO authenticated;

-- Month-by-month for the year, so a cohort can be read against its neighbours.
-- Months with no account at all still return a row: a gap in the series is
-- information, and a chart that silently skips a month misreports the trend.
CREATE OR REPLACE FUNCTION get_zoho_accounts_monthly_summary(
  p_year INT DEFAULT NULL,
  p_rep TEXT DEFAULT NULL, p_source TEXT DEFAULT NULL, p_service TEXT DEFAULT NULL,
  p_domaine TEXT DEFAULT NULL, p_region TEXT DEFAULT NULL,
  p_window_months INT DEFAULT 12,
  p_exclude_ratings TEXT[] DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur']
)
RETURNS TABLE (month INT, nb_accounts BIGINT, nb_invoiced BIGINT,
               total_amount NUMERIC, revenue_per_account NUMERIC)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, NULL, p_rep, p_source, p_service, p_domaine, p_region, p_exclude_ratings)
  ),
  per_acct AS (
    SELECT
      EXTRACT(MONTH FROM s.created_date)::INT AS m,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2
  ),
  agg AS (
    SELECT p.m, count(*) AS nb, count(*) FILTER (WHERE p.amount <> 0) AS inv,
           COALESCE(sum(p.amount), 0) AS amt
    FROM per_acct p GROUP BY p.m
  )
  SELECT g.m,
         COALESCE(a.nb, 0), COALESCE(a.inv, 0), COALESCE(a.amt, 0),
         ROUND(COALESCE(a.amt, 0) / NULLIF(COALESCE(a.nb, 0), 0), 2)
  FROM generate_series(1, 12) AS g(m)
  LEFT JOIN agg a ON a.m = g.m
  ORDER BY g.m;
$$;

GRANT EXECUTE ON FUNCTION get_zoho_accounts_monthly_summary(INT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT[]) TO authenticated;

-- ─── Filter options ───────────────────────────────────────────────────────────
--
-- Drawn from the stored data, never from Zoho's picklist definition, and this is
-- not defensiveness — it is load-bearing. Accounts hold 26 distinct
-- origine_du_client values against 21 live picklist entries. The five that no
-- longer exist in the picklist include "Publicité/Recherche Google", 108
-- accounts, which is the exact segment Dominic asked to report on in the
-- 2026-09-04 meeting. A hardcoded list built from the picklist would offer every
-- source except the one he named.
--
-- service_variants mirrors the leads RPC: the key folds case and spacing, the
-- array keeps Zoho's own spellings so a query can match them all at once.

CREATE OR REPLACE FUNCTION get_zoho_account_filter_options(
  p_year            INT    DEFAULT NULL,
  p_exclude_ratings TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  years            INT[],
  sources          TEXT[],
  services         TEXT[],
  service_variants JSONB,
  reps             TEXT[],
  domaines         TEXT[],
  regions          TEXT[],
  ratings          TEXT[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, NULL, NULL, NULL, NULL, NULL, NULL, p_exclude_ratings)
  ),
  -- Years come from the whole table, never from the scoped set: the year picker
  -- must still offer 2024 while 2026 is selected.
  yrs AS (
    SELECT array_agg(DISTINCT EXTRACT(YEAR FROM created_time AT TIME ZONE 'America/Toronto')::INT
                     ORDER BY EXTRACT(YEAR FROM created_time AT TIME ZONE 'America/Toronto')::INT DESC) AS v
    FROM zoho_accounts WHERE created_time IS NOT NULL
  ),
  src AS (
    SELECT array_agg(DISTINCT origine_du_client ORDER BY origine_du_client) AS v
    FROM scoped WHERE COALESCE(btrim(origine_du_client), '') NOT IN ('', '-None-')
  ),
  svc AS (
    SELECT
      array_agg(DISTINCT l.label ORDER BY l.label) AS labels,
      jsonb_object_agg(l.label, to_jsonb(l.variants)) AS variants
    FROM (
      SELECT DISTINCT zoho_service_key(v) AS key
      FROM scoped s, LATERAL unnest(s.service_interest) AS v
      WHERE btrim(v) <> ''
    ) k
    JOIN zoho_service_labels l ON l.key = k.key
  ),
  rp AS (
    SELECT array_agg(DISTINCT rep_name ORDER BY rep_name) AS v
    FROM scoped WHERE COALESCE(btrim(rep_name), '') <> ''
  ),
  dom AS (
    SELECT array_agg(DISTINCT domaine_activite ORDER BY domaine_activite) AS v
    FROM scoped WHERE COALESCE(btrim(domaine_activite), '') NOT IN ('', '-None-')
  ),
  reg AS (
    SELECT array_agg(DISTINCT region_administrative ORDER BY region_administrative) AS v
    FROM scoped WHERE COALESCE(btrim(region_administrative), '') NOT IN ('', '-None-')
  ),
  -- Ratings deliberately read the unscoped table: the rating filter has to offer
  -- "Compte interne : Ne pas reprendre" precisely so someone can switch it back
  -- on, and scoping would remove it from its own dropdown.
  rat AS (
    SELECT array_agg(DISTINCT rating ORDER BY rating) AS v
    FROM zoho_accounts WHERE COALESCE(btrim(rating), '') NOT IN ('', '-None-')
  )
  SELECT
    COALESCE((SELECT v FROM yrs), '{}'),
    COALESCE((SELECT v FROM src), '{}'),
    COALESCE((SELECT labels FROM svc), '{}'),
    COALESCE((SELECT variants FROM svc), '{}'::jsonb),
    COALESCE((SELECT v FROM rp),  '{}'),
    COALESCE((SELECT v FROM dom), '{}'),
    COALESCE((SELECT v FROM reg), '{}'),
    COALESCE((SELECT v FROM rat), '{}');
$$;

GRANT EXECUTE ON FUNCTION get_zoho_account_filter_options(INT, TEXT[]) TO authenticated;

-- ─── Invoices for one account ─────────────────────────────────────────────────
--
-- get_lead_invoice_totals and get_lead_invoices (20260903000200) are already
-- keyed on invoices.crm_account_id — they take account ids, not lead ids, and
-- were only ever named for their first caller. Rather than copy 40 lines of
-- identical SQL, these are thin aliases: the Comptes page should not have to
-- call something named "lead" to list an account's invoices, and the leads page
-- keeps working under the old names.

CREATE OR REPLACE FUNCTION get_account_invoice_totals(p_account_ids TEXT[])
RETURNS TABLE (
  account_id        TEXT,
  invoice_count     INTEGER,
  credit_count      INTEGER,
  total_amount      NUMERIC,
  last_invoice_date DATE
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$ SELECT * FROM get_lead_invoice_totals(p_account_ids); $$;

GRANT EXECUTE ON FUNCTION get_account_invoice_totals(TEXT[]) TO authenticated;

CREATE OR REPLACE FUNCTION get_account_invoices(p_account_id TEXT)
RETURNS TABLE (
  zoho_id           TEXT,
  invoice_number    TEXT,
  client_name       TEXT,
  amount            NUMERIC,
  invoice_date      DATE,
  status            TEXT,
  is_avoir          BOOLEAN,
  department        TEXT,
  office            TEXT,
  rep_name          TEXT,
  books_customer_id TEXT
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$ SELECT * FROM get_lead_invoices(p_account_id); $$;

GRANT EXECUTE ON FUNCTION get_account_invoices(TEXT) TO authenticated;

-- Per-department, per-year revenue for ONE account. This is the "data client"
-- Dominic asked for: "chef santé, il a acheté combien par département par année,
-- puis voir la progression". Years come back as rows so the page can pivot them
-- without a second round trip.
CREATE OR REPLACE FUNCTION get_account_revenue_by_department(p_account_id TEXT)
RETURNS TABLE (
  year          INT,
  department    TEXT,
  invoice_count BIGINT,
  credit_count  BIGINT,
  total_amount  NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT
    EXTRACT(YEAR FROM i.invoice_date)::INT,
    COALESCE(i.department, 'Non assigné'),
    count(*) FILTER (WHERE NOT i.is_avoir),
    count(*) FILTER (WHERE i.is_avoir),
    -- Avoirs are stored negative, so a plain sum is already net of credits.
    COALESCE(sum(i.amount), 0)
  FROM invoices i
  WHERE p_account_id IS NOT NULL
    AND i.crm_account_id = p_account_id
    AND i.invoice_date IS NOT NULL
  GROUP BY 1, 2
  ORDER BY 1 DESC, 5 DESC;
$$;

GRANT EXECUTE ON FUNCTION get_account_revenue_by_department(TEXT) TO authenticated;
