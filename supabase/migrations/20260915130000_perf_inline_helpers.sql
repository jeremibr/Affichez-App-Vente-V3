-- Let Postgres inline the helper functions again.
--
-- THE PROBLEM. Postgres inlines a `LANGUAGE sql` function into the calling
-- query only when, among other things, the function has **no SET clause**
-- (`pg_proc.proconfig IS NULL`). Every helper here carried
-- `SET search_path TO 'public'`, so none of them could be inlined. The live
-- plan for the Comptes dashboard showed the consequence:
--
--   ->  Function Scan on zoho_accounts_scoped  (actual time=48.235..48.656 rows=2546)
--
-- A *function scan*, not a table scan. The whole table is read and filtered
-- inside the function, the row count is a fixed guess, and the caller's
-- predicates and indexes cannot reach the table at all. Inlined, the same call
-- becomes an ordinary scan of zoho_accounts that the planner can index and
-- push filters into.
--
-- IS THIS SAFE? `SET search_path` matters because a hostile search_path can
-- make an unqualified name resolve to an attacker's object. That is an
-- escalation only for SECURITY DEFINER functions, which run as their owner.
-- Every function below is SECURITY INVOKER: it already runs with exactly the
-- caller's privileges, so a caller who poisons their own search_path gains
-- nothing they did not already have. Belt and braces anyway — **every
-- reference in these bodies is now schema-qualified**, so the resolution does
-- not depend on search_path in the first place.
--
-- tasks_visible_reps() is SECURITY DEFINER and deliberately keeps its SET
-- clause; it costs 3 ms and is not worth the risk.
--
-- SECOND CHANGE, in zoho_accounts_scoped and zoho_leads_scoped: the year
-- filter is now a RANGE on created_time instead of EXTRACT(YEAR FROM ...).
-- The two are exactly equivalent — a Montreal calendar year is the half-open
-- interval [Jan 1 00:00 America/Toronto, next Jan 1 00:00 America/Toronto) —
-- but only the range form can use zoho_accounts_created_idx. EXTRACT wraps the
-- column in a function call, which no btree index on that column can serve, so
-- selecting one year read all 20,737 accounts.
--
-- p_month stays on EXTRACT: months are only ever asked for together with a
-- year, so by then the range has already narrowed the scan to that year's rows.


-- ── leaf helpers ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.zoho_local_date(p_at timestamp with time zone)
RETURNS date LANGUAGE sql IMMUTABLE
AS $function$
  SELECT (p_at AT TIME ZONE 'America/Toronto')::date;
$function$;

CREATE OR REPLACE FUNCTION public.zoho_lead_local_date(p_at timestamp with time zone)
RETURNS date LANGUAGE sql IMMUTABLE
AS $function$
  SELECT (p_at AT TIME ZONE 'America/Toronto')::date;
$function$;

CREATE OR REPLACE FUNCTION public.zoho_service_key(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $function$
  SELECT pg_catalog.lower(
           pg_catalog.regexp_replace(
             pg_catalog.btrim(COALESCE(p_value, '')), '\s+', ' ', 'g'));
$function$;

CREATE OR REPLACE FUNCTION public.zoho_account_is_bulk_import(p_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE
AS $function$
  SELECT COALESCE(p_source, '') IN (
    'Client Royer & Fils / VotreLogo.ca',
    'Client PLOGG/BUCCO'
  );
$function$;

CREATE OR REPLACE FUNCTION public.zoho_internal_ratings()
RETURNS text[] LANGUAGE sql IMMUTABLE
AS $function$
  SELECT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur'];
$function$;

CREATE OR REPLACE FUNCTION public.zoho_account_window_end(p_created timestamp with time zone, p_months integer)
RETURNS date LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_months IS NULL THEN 'infinity'::date
    ELSE ((p_created AT TIME ZONE 'America/Toronto')::date
          + pg_catalog.make_interval(months => p_months))::date
  END;
$function$;


-- ── the scoping functions, the ones the dashboards live on ──────────────────

CREATE OR REPLACE FUNCTION public.zoho_accounts_scoped(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(zoho_account_id text, account_name text, created_time timestamp with time zone, created_date date, rep_name text, origine_du_client text, service_interest text[], domaine_activite text, region_administrative text, rating text, is_bulk_import boolean, ventes_totales numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    a.zoho_account_id, a.account_name, a.created_time,
    (a.created_time AT TIME ZONE 'America/Toronto')::date,
    a.rep_name, a.origine_du_client, a.service_interest,
    a.domaine_activite, a.region_administrative, a.rating,
    COALESCE(a.origine_du_client, '') IN ('Client Royer & Fils / VotreLogo.ca', 'Client PLOGG/BUCCO'),
    a.ventes_totales
  FROM public.zoho_accounts a
  WHERE a.created_time IS NOT NULL
    -- A range, not EXTRACT(YEAR ...): same rows, but this one can use the index.
    AND (p_year IS NULL OR (
          a.created_time >= pg_catalog.make_timestamptz(p_year,     1, 1, 0, 0, 0, 'America/Toronto')
      AND a.created_time <  pg_catalog.make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'America/Toronto')))
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
           WHERE public.zoho_service_key(v) = public.zoho_service_key(p_service)
        ))
    -- NULL means "no exclusions" so a caller can ask for the unfiltered book;
    -- omitting the argument gets the dashboard's default instead. An account with
    -- no rating at all (977 of them) is never excluded by this.
    AND (p_exclude_ratings IS NULL
         OR a.rating IS NULL
         OR NOT (a.rating = ANY(p_exclude_ratings)));
$function$;

CREATE OR REPLACE FUNCTION public.zoho_leads_scoped(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text)
 RETURNS TABLE(zoho_record_id text, account_id text, created_time timestamp with time zone, is_converted boolean, rep_name text, lead_source text, service_interest text[])
 LANGUAGE sql
 STABLE
AS $function$
  SELECT z.zoho_record_id, z.account_id, z.created_time, z.is_converted,
         z.rep_name, z.lead_source, z.service_interest
    FROM public.zoho_leads z
   WHERE z.stage = 'lead'
     -- AT TIME ZONE turns the timestamptz into local wall-clock time before the
     -- calendar fields are read, so a lead belongs to the month a rep in Quebec
     -- would say it arrived in. Expressed as a range so the index can serve it.
     AND (p_year IS NULL OR (
           z.created_time >= pg_catalog.make_timestamptz(p_year,     1, 1, 0, 0, 0, 'America/Toronto')
       AND z.created_time <  pg_catalog.make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'America/Toronto')))
     AND (p_month IS NULL OR EXTRACT(MONTH FROM z.created_time AT TIME ZONE 'America/Toronto')::INT = p_month)
     AND (p_rep     IS NULL OR z.rep_name    = p_rep)
     AND (p_source  IS NULL OR z.lead_source = p_source)
     -- Case-insensitive: Zoho's multi-select holds both "Distribution publicitaire"
     -- and "Distribution Publicitaire" (2,043 vs 166 leads). An exact @> match
     -- would silently drop one spelling.
     AND (p_service IS NULL OR EXISTS (
           SELECT 1 FROM unnest(z.service_interest) AS v
            WHERE public.zoho_service_key(v) = public.zoho_service_key(p_service)
         ));
$function$;


-- CREATE OR REPLACE is documented to replace the function's properties, but the
-- whole point of this migration is that proconfig ends up NULL, so it is worth
-- stating rather than assuming. A function with any SET clause left on it is
-- silently un-inlinable again, and nothing would fail loudly.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proconfig IS NOT NULL
       AND p.prosecdef = false          -- never touch SECURITY DEFINER
       AND p.proname IN ('zoho_local_date', 'zoho_lead_local_date',
                         'zoho_service_key', 'zoho_account_is_bulk_import',
                         'zoho_internal_ratings', 'zoho_account_window_end',
                         'zoho_accounts_scoped', 'zoho_leads_scoped')
  LOOP
    EXECUTE format('ALTER FUNCTION %s RESET ALL', r.sig);
  END LOOP;
END $$;
