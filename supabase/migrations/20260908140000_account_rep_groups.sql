-- A rep-LIST filter for the Comptes functions.
--
-- Same change, same reason as 20260908130000 did for the invoice functions: the
-- rep dropdown now offers groups — "Équipe entière" (the reps in the view
-- dropdown) and "Interne" (everybody else) — and a group cannot be expressed as
-- one name.
--
-- p_rep stays for a single rep. p_reps takes a list. Both filter on
-- zoho_accounts.rep_name and both are NULL-means-everything, so passing neither
-- behaves exactly as before.
--
-- Only zoho_accounts_scoped actually applies the filter; the six functions above
-- it just hand the list down, which is why a filter added there reaches the KPI
-- row and all five breakdowns at once and they cannot drift apart.
--
-- Reproduced from the live definitions with two mechanical edits each — the
-- parameter appended, and either the predicate (scoped) or the pass-through
-- (everything else). No other line changed.

DROP FUNCTION IF EXISTS zoho_accounts_scoped(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_exclude_ratings text[]);

CREATE OR REPLACE FUNCTION public.zoho_accounts_scoped(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(zoho_account_id text, account_name text, created_time timestamp with time zone, created_date date, rep_name text, origine_du_client text, service_interest text[], domaine_activite text, region_administrative text, rating text, is_bulk_import boolean, ventes_totales numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
    AND (p_reps    IS NULL OR a.rep_name          = ANY(p_reps))
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
$function$;

GRANT EXECUTE ON FUNCTION zoho_accounts_scoped(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_exclude_ratings text[], text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_zoho_account_kpis(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_account_kpis(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(accounts_created bigint, accounts_invoiced bigint, invoiced_rate numeric, revenue_attributed numeric, revenue_lifetime numeric, revenue_per_account numeric, avg_days_to_first_invoice numeric, ventes_royer numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps)
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
$function$;

GRANT EXECUTE ON FUNCTION get_zoho_account_kpis(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_zoho_accounts_by_rep(p_year integer, p_month integer, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_rep(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, NULL, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps)
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
$function$;

GRANT EXECUTE ON FUNCTION get_zoho_accounts_by_rep(p_year integer, p_month integer, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_zoho_accounts_by_source(p_year integer, p_month integer, p_rep text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_source(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, NULL, p_service, p_domaine, p_region, p_exclude_ratings, p_reps)
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
$function$;

GRANT EXECUTE ON FUNCTION get_zoho_accounts_by_source(p_year integer, p_month integer, p_rep text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_zoho_accounts_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_service(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, NULL, p_domaine, p_region, p_exclude_ratings, p_reps)
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
$function$;

GRANT EXECUTE ON FUNCTION get_zoho_accounts_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_zoho_accounts_by_domaine(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_region text, p_window_months integer, p_exclude_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_domaine(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, p_service, NULL, p_region, p_exclude_ratings, p_reps)
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
$function$;

GRANT EXECUTE ON FUNCTION get_zoho_accounts_by_domaine(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_region text, p_window_months integer, p_exclude_ratings text[], text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_zoho_accounts_monthly_summary(p_year integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_monthly_summary(p_year integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(month integer, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, NULL, p_rep, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps)
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
$function$;

GRANT EXECUTE ON FUNCTION get_zoho_accounts_monthly_summary(p_year integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], text[]) TO authenticated;
