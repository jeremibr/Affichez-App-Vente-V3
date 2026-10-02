-- Publicité: choose which ad accounts the spend is taken from.
--
-- A platform can be synced from several ad accounts (Google is two). Until now
-- the page always showed their sum. p_ad_accounts narrows the spend to the
-- accounts selected; NULL, the default, keeps every account.
--
-- What it narrows and what it cannot:
--
--   * spend, impressions, clicks, conversions and days of data follow the
--     selection;
--   * accounts created and revenue do not. They come from the CRM source
--     ("Google Ads"), and the CRM does not record which ad account a client
--     came from;
--   * cost per account, return and net are therefore the channel's accounts
--     against the spend of the selected ad accounts, and the page says so.
--     They are still computed: holding one ad account's spend against the
--     channel is exactly what the page showed when it had a single account.
--
-- The selection narrows only the platforms it names. Picking one Google
-- account leaves Meta whole; a selection that named no Meta account does not
-- mean "no Meta spend".
--
-- The parameter is appended with a default, so a browser still running the
-- previous build calls the same functions and gets what it got before.

-- ─── 1. Ad account names ──────────────────────────────────────────────────────
-- ad_spend_daily knows an account by its id only. This table carries the name
-- the platform gives it, written by ads-spend-sync on every run. It is a label
-- store and nothing else: the list of accounts on offer is read from
-- ad_spend_daily, so an account missing here is still selectable, by its id.

CREATE TABLE IF NOT EXISTS public.ad_accounts (
  platform      TEXT        NOT NULL,
  ad_account_id TEXT        NOT NULL,
  name          TEXT,
  currency      TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, ad_account_id)
);

COMMENT ON TABLE public.ad_accounts IS
  'Display name of each ad account, written by ads-spend-sync. Read by the Publicité filter.';

ALTER TABLE public.ad_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listed_users_only ON public.ad_accounts;
CREATE POLICY listed_users_only ON public.ad_accounts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.app_is_listed()));

DROP POLICY IF EXISTS ad_accounts_select_section ON public.ad_accounts;
CREATE POLICY ad_accounts_select_section ON public.ad_accounts
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access('publicite')));

REVOKE ALL ON public.ad_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ad_accounts TO authenticated;
GRANT ALL ON public.ad_accounts TO service_role;

-- Every account already on file, so the list is complete before the next sync.
INSERT INTO public.ad_accounts (platform, ad_account_id)
SELECT DISTINCT platform, ad_account_id FROM public.ad_spend_daily
ON CONFLICT (platform, ad_account_id) DO NOTHING;

-- The two Google accounts are known by name today, spelled as Google Ads has
-- them; the sync rewrites both on its next run.
UPDATE public.ad_accounts SET name = 'Affichez - GLOBAL/PUB'
 WHERE platform = 'google' AND ad_account_id = '5796613141' AND name IS NULL;
UPDATE public.ad_accounts SET name = 'Affichez- BOUTIQUE PROMO'
 WHERE platform = 'google' AND ad_account_id = '4373634595' AND name IS NULL;

-- ─── 2. The RPCs ──────────────────────────────────────────────────────────────
-- Bodies as in 20261002090000 (SECURITY DEFINER, the section check first), with
-- the `picked` CTE and one more condition on the spend. A function gaining a
-- parameter is dropped and created, never overloaded: two signatures under one
-- name make PostgREST refuse the call.

DROP FUNCTION IF EXISTS public.get_ad_performance(p_year integer, p_month integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]);
DROP FUNCTION IF EXISTS public.get_ad_performance(p_year integer, p_month integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[]);
CREATE FUNCTION public.get_ad_performance(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_organic boolean DEFAULT false, p_view text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ad_accounts text[] DEFAULT NULL::text[])
 RETURNS TABLE(channel text, sources text[], currencies text[], spend numeric, impressions bigint, clicks bigint, platform_conversions numeric, platform_leads numeric, accounts_created bigint, accounts_invoiced bigint, revenue_attributed numeric, revenue_lifetime numeric, revenue_per_account numeric, cost_per_account numeric, cost_per_client numeric, roas numeric, net numeric, days_with_spend bigint, window_ends_on date, source_first_used date, cohort_from date, cohort_before date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.app_require_section('publicite');

  WITH
  -- The platforms the ad-account selection speaks for. One Google account
  -- selected leaves Meta whole: a platform with none of its accounts in the
  -- list is not filtered. platform is NOT NULL, so NOT IN is safe here.
  picked AS (
    SELECT DISTINCT a.platform
    FROM public.ad_spend_daily a
    WHERE a.ad_account_id = ANY(p_ad_accounts)
  ),
  period AS (
    SELECT * FROM public.ad_period(p_year, p_month)
  ),
  map AS (
    SELECT m.*
    FROM public.ad_channel_source_map(public.ad_resolve_view(p_view, p_organic)) m
    WHERE p_sources IS NULL OR m.source_value = ANY(p_sources)
  ),
  src AS (
    SELECT m.channel,
           array_agg(DISTINCT m.source_value ORDER BY m.source_value) AS sources,
           min(m.created_from)   AS cohort_from,
           max(m.created_before) AS cohort_before
    FROM map m
    GROUP BY m.channel
  ),
  -- Spend belongs to the paid view only: the other two cost nothing.
  sp AS (
    SELECT
      d.platform AS channel,
      COALESCE(sum(d.spend), 0)       AS spend,
      COALESCE(sum(d.impressions), 0) AS impressions,
      COALESCE(sum(d.clicks), 0)      AS clicks,
      COALESCE(sum(d.conversions), 0) AS conversions,
      COALESCE(sum(d.leads), 0)       AS leads,
      count(DISTINCT d.spend_date)    AS days_with_spend,
      array_agg(DISTINCT d.currency) FILTER (WHERE d.currency IS NOT NULL) AS currencies
    FROM public.ad_spend_daily d, period p
    WHERE public.ad_resolve_view(p_view, p_organic) = 'paid'
      AND d.spend_date >= p.period_start
      AND d.spend_date <  p.period_end
      -- The selection narrows only the platforms it names (see `picked`).
      AND (p_ad_accounts IS NULL
           OR d.ad_account_id = ANY(p_ad_accounts)
           OR d.platform NOT IN (SELECT platform FROM picked))
    GROUP BY d.platform
  ),
  scoped AS (
    SELECT s.*, m.channel
    -- The month only applies within a year, matching ad_period's spend range.
    -- Sources are narrowed by the map join, so none is passed here.
    FROM public.zoho_accounts_scoped(
           p_year, CASE WHEN p_year IS NULL THEN NULL ELSE p_month END,
           NULL, NULL, NULL, NULL, NULL, p_exclude_ratings,
           p_reps, NULL, p_services, p_domaines, p_regions) s
    JOIN map m
      ON m.source_value = s.origine_du_client
     AND (m.created_from   IS NULL OR s.created_date >= m.created_from)
     AND (m.created_before IS NULL OR s.created_date <  m.created_before)
  ),
  per_acct AS (
    SELECT
      s.channel,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  public.zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS attributed,
      COALESCE(sum(i.amount), 0) AS lifetime
    FROM scoped s
    LEFT JOIN public.invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2
  ),
  acct AS (
    SELECT
      p.channel,
      count(*)                                  AS accounts_created,
      count(*) FILTER (WHERE p.attributed <> 0) AS accounts_invoiced,
      COALESCE(sum(p.attributed), 0)            AS revenue_attributed,
      COALESCE(sum(p.lifetime), 0)              AS revenue_lifetime
    FROM per_acct p
    GROUP BY p.channel
  ),
  -- True when the accounts are a subset the spend cannot be matched to.
  flags AS (
    SELECT (p_reps IS NOT NULL OR p_services IS NOT NULL
            OR p_domaines IS NOT NULL OR p_regions IS NOT NULL) AS narrowed
  )
  SELECT
    src.channel,
    src.sources,
    COALESCE(sp.currencies, ARRAY[]::TEXT[]),
    ROUND(COALESCE(sp.spend, 0), 2),
    COALESCE(sp.impressions, 0),
    COALESCE(sp.clicks, 0),
    COALESCE(sp.conversions, 0),
    COALESCE(sp.leads, 0),
    COALESCE(acct.accounts_created, 0),
    COALESCE(acct.accounts_invoiced, 0),
    COALESCE(acct.revenue_attributed, 0),
    COALESCE(acct.revenue_lifetime, 0),
    ROUND(COALESCE(acct.revenue_attributed, 0) / NULLIF(acct.accounts_created, 0), 2),
    -- Costs only exist against a spend, and only for the whole channel. Divided
    -- by all accounts created, matching revenue_per_account on Comptes.
    CASE WHEN COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(sp.spend / NULLIF(acct.accounts_created, 0), 2) END,
    CASE WHEN COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(sp.spend / NULLIF(acct.accounts_invoiced, 0), 2) END,
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0 AND NOT f.narrowed
         THEN ROUND(acct.revenue_attributed / NULLIF(sp.spend, 0), 2) END,
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0 AND COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(acct.revenue_attributed - sp.spend, 2) END,
    COALESCE(sp.days_with_spend, 0),
    (SELECT public.ad_window_ends_on(p.period_end, p_window_months) FROM period p),
    fu.first_used,
    src.cohort_from,
    src.cohort_before
  FROM src
  CROSS JOIN flags f
  LEFT JOIN sp   ON sp.channel   = src.channel
  LEFT JOIN acct ON acct.channel = src.channel
  LEFT JOIN public.ad_source_first_used(public.ad_resolve_view(p_view, p_organic)) fu
         ON fu.channel = src.channel
  ORDER BY src.channel;
$function$;

DROP FUNCTION IF EXISTS public.get_ad_monthly(p_year integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]);
DROP FUNCTION IF EXISTS public.get_ad_monthly(p_year integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[]);
CREATE FUNCTION public.get_ad_monthly(p_year integer, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_organic boolean DEFAULT false, p_view text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ad_accounts text[] DEFAULT NULL::text[])
 RETURNS TABLE(channel text, month integer, spend numeric, platform_conversions numeric, accounts_created bigint, accounts_invoiced bigint, revenue_attributed numeric, revenue_per_account numeric, cost_per_account numeric, roas numeric, window_ends_on date, source_first_used date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.app_require_section('publicite');

  WITH
  -- The platforms the ad-account selection speaks for. One Google account
  -- selected leaves Meta whole: a platform with none of its accounts in the
  -- list is not filtered. platform is NOT NULL, so NOT IN is safe here.
  picked AS (
    SELECT DISTINCT a.platform
    FROM public.ad_spend_daily a
    WHERE a.ad_account_id = ANY(p_ad_accounts)
  ),
  map AS (
    SELECT m.*
    FROM public.ad_channel_source_map(public.ad_resolve_view(p_view, p_organic)) m
    WHERE p_sources IS NULL OR m.source_value = ANY(p_sources)
  ),
  grid AS (
    SELECT c.channel, g.month
    FROM (SELECT DISTINCT channel FROM map) c
    CROSS JOIN generate_series(1, 12) AS g(month)
  ),
  sp AS (
    SELECT
      d.platform AS channel,
      EXTRACT(MONTH FROM d.spend_date)::INT AS month,
      sum(d.spend)       AS spend,
      sum(d.conversions) AS conversions
    FROM public.ad_spend_daily d
    WHERE public.ad_resolve_view(p_view, p_organic) = 'paid'
      AND d.spend_date >= pg_catalog.make_date(p_year, 1, 1)
      AND d.spend_date <  pg_catalog.make_date(p_year + 1, 1, 1)
      -- The selection narrows only the platforms it names (see `picked`).
      AND (p_ad_accounts IS NULL
           OR d.ad_account_id = ANY(p_ad_accounts)
           OR d.platform NOT IN (SELECT platform FROM picked))
    GROUP BY 1, 2
  ),
  scoped AS (
    SELECT s.*, m.channel
    FROM public.zoho_accounts_scoped(
           p_year, NULL, NULL, NULL, NULL, NULL, NULL, p_exclude_ratings,
           p_reps, NULL, p_services, p_domaines, p_regions) s
    JOIN map m
      ON m.source_value = s.origine_du_client
     AND (m.created_from   IS NULL OR s.created_date >= m.created_from)
     AND (m.created_before IS NULL OR s.created_date <  m.created_before)
  ),
  per_acct AS (
    SELECT
      s.channel,
      EXTRACT(MONTH FROM s.created_date)::INT AS month,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  public.zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS attributed
    FROM scoped s
    LEFT JOIN public.invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2, 3
  ),
  acct AS (
    SELECT
      p.channel, p.month,
      count(*)                                  AS accounts_created,
      count(*) FILTER (WHERE p.attributed <> 0) AS accounts_invoiced,
      COALESCE(sum(p.attributed), 0)            AS revenue_attributed
    FROM per_acct p
    GROUP BY 1, 2
  ),
  flags AS (
    SELECT (p_reps IS NOT NULL OR p_services IS NOT NULL
            OR p_domaines IS NOT NULL OR p_regions IS NOT NULL) AS narrowed
  )
  SELECT
    g.channel,
    g.month,
    ROUND(COALESCE(sp.spend, 0), 2),
    ROUND(COALESCE(sp.conversions, 0), 2),
    COALESCE(acct.accounts_created, 0),
    COALESCE(acct.accounts_invoiced, 0),
    COALESCE(acct.revenue_attributed, 0),
    ROUND(COALESCE(acct.revenue_attributed, 0) / NULLIF(acct.accounts_created, 0), 2),
    CASE WHEN COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(sp.spend / NULLIF(acct.accounts_created, 0), 2) END,
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0 AND NOT f.narrowed
         THEN ROUND(acct.revenue_attributed / NULLIF(sp.spend, 0), 2) END,
    public.ad_window_ends_on(
      (pg_catalog.make_date(p_year, g.month, 1) + INTERVAL '1 month')::date,
      p_window_months),
    fu.first_used
  FROM grid g
  CROSS JOIN flags f
  LEFT JOIN sp   ON sp.channel   = g.channel AND sp.month   = g.month
  LEFT JOIN acct ON acct.channel = g.channel AND acct.month = g.month
  LEFT JOIN public.ad_source_first_used(public.ad_resolve_view(p_view, p_organic)) fu
         ON fu.channel = g.channel
  ORDER BY g.channel, g.month;
$function$;

-- The return type gains a column, so the function is dropped and created again.
DROP FUNCTION IF EXISTS public.get_ad_filter_options(p_year integer, p_exclude_ratings text[], p_view text);
CREATE FUNCTION public.get_ad_filter_options(p_year integer DEFAULT NULL::integer, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_view text DEFAULT 'paid'::text)
 RETURNS TABLE(sources text[], services text[], reps text[], domaines text[], regions text[], ad_accounts jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.app_require_section('publicite');

  WITH map AS (
    SELECT m.* FROM public.ad_channel_source_map(public.ad_resolve_view(p_view, false)) m
  ),
  scoped AS (
    SELECT s.*
    FROM public.zoho_accounts_scoped(
           p_year, NULL, NULL, NULL, NULL, NULL, NULL, p_exclude_ratings) s
    JOIN map m
      ON m.source_value = s.origine_du_client
     AND (m.created_from   IS NULL OR s.created_date >= m.created_from)
     AND (m.created_before IS NULL OR s.created_date <  m.created_before)
  )
  SELECT
    COALESCE((SELECT array_agg(DISTINCT m.source_value ORDER BY m.source_value) FROM map m), '{}'),
    -- Folded through zoho_service_key, then labelled from the shared map, so a
    -- service reads the same way here as on Comptes.
    COALESCE((SELECT array_agg(DISTINCT l.label ORDER BY l.label)
                FROM (SELECT DISTINCT public.zoho_service_key(v) AS key
                        FROM scoped s, LATERAL unnest(s.service_interest) AS v
                       WHERE btrim(v) <> '') k
                JOIN public.zoho_service_labels l ON l.key = k.key), '{}'),
    COALESCE((SELECT array_agg(DISTINCT s.rep_name ORDER BY s.rep_name)
                FROM scoped s WHERE COALESCE(btrim(s.rep_name), '') <> ''), '{}'),
    COALESCE((SELECT array_agg(DISTINCT s.domaine_activite ORDER BY s.domaine_activite)
                FROM scoped s WHERE COALESCE(btrim(s.domaine_activite), '') NOT IN ('', '-None-')), '{}'),
    COALESCE((SELECT array_agg(DISTINCT s.region_administrative ORDER BY s.region_administrative)
                FROM scoped s WHERE COALESCE(btrim(s.region_administrative), '') NOT IN ('', '-None-')), '{}'),
    -- Every ad account that has spend on file, named from ad_accounts when a
    -- sync has read its name. Not narrowed by year or view: the list is the
    -- same whatever is on screen.
    COALESCE((SELECT jsonb_agg(jsonb_build_object('platform', x.platform, 'id', x.ad_account_id, 'name', n.name)
                               ORDER BY x.platform, n.name NULLS LAST, x.ad_account_id)
                FROM (SELECT DISTINCT platform, ad_account_id FROM public.ad_spend_daily) x
                LEFT JOIN public.ad_accounts n
                       ON n.platform = x.platform AND n.ad_account_id = x.ad_account_id), '[]'::jsonb);
$function$;

-- SECURITY DEFINER: not callable by PUBLIC or anon, as before.
REVOKE ALL ON FUNCTION public.get_ad_performance(p_year integer, p_month integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_performance(p_year integer, p_month integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_ad_monthly(p_year integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_monthly(p_year integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_ad_filter_options(p_year integer, p_exclude_ratings text[], p_view text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_filter_options(p_year integer, p_exclude_ratings text[], p_view text) TO authenticated, service_role;
