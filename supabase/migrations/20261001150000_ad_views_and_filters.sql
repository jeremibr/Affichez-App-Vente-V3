-- Publicité: a third view for Google, and the account filters.
--
-- ─── 1. Three views ───────────────────────────────────────────────────────────
--
-- Until 2026-10-01 the source now called "Google Organique" was a mixed bucket:
-- a click on a Google ad, an organic Google search and the former "Internet"
-- value all landed in it. From that date the source is applied to organic
-- arrivals only and paid arrivals are tagged "Google Ads". The accounts created
-- before the date cannot be split after the fact, so they get a view of their
-- own instead of being counted as organic:
--
--   paid     Google Ads                              Meta Ads
--   organic  Google Organique, created >= the date   Meta Organique
--   unknown  Google Organique, created <  the date   (no Meta channel)
--
-- The date lives in ad_google_organic_since() and nowhere else. The map returns
-- it as a creation-date range per source, and every reader joins on that range,
-- so the organic and unknown cohorts can never overlap or leave a gap.
--
-- A view is selected with p_view. p_organic is still accepted, and it keeps
-- the meaning it had: p_organic => true without p_view is the previous organic
-- view, every "Google Organique" account whatever its date ('organic_all').
-- The frontend build that was live before this migration sends only p_organic,
-- so its screens show the same figures until the new build replaces it. p_view
-- wins when both are given.
--
-- ─── 2. Account filters ───────────────────────────────────────────────────────
--
-- p_reps, p_sources, p_services, p_domaines, p_regions narrow the ACCOUNTS (and
-- therefore the revenue). Spend cannot be narrowed the same way: a platform
-- reports it per campaign, never per rep, service, domain or region. Dividing
-- the whole channel's spend by a subset of its accounts would overstate the
-- cost and understate the return, so cost_per_account, cost_per_client, roas
-- and net are NULL whenever one of those four filters is set.
--
-- p_sources is different: every source belongs to one channel, so it selects
-- whole channels. A channel with no selected source is left out of the result,
-- and the ratios of the channels that remain are still exact.
--
-- No SET search_path on any of these: SECURITY INVOKER, and the helpers are
-- inlined by the planner (CLAUDE.md, performance rule 1).
--
-- Each function is dropped under both its old and its new signature before it
-- is created, so the file can be applied again without failing.

-- ─── Helpers ──────────────────────────────────────────────────────────────────

-- First creation date on which "Google Organique" means organic only.
CREATE OR REPLACE FUNCTION public.ad_google_organic_since()
RETURNS DATE LANGUAGE sql IMMUTABLE
AS $$ SELECT DATE '2026-10-01'; $$;

-- 'paid' | 'organic' | 'unknown' from p_view. Without p_view, the legacy
-- p_organic flag: 'organic_all' (no date split) or 'paid'.
CREATE OR REPLACE FUNCTION public.ad_resolve_view(p_view TEXT, p_organic BOOLEAN)
RETURNS TEXT LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_view IN ('paid', 'organic', 'unknown') THEN p_view
    WHEN COALESCE(p_organic, false)               THEN 'organic_all'
    ELSE 'paid'
  END;
$$;

DROP FUNCTION IF EXISTS public.ad_channel_source_map(BOOLEAN);
DROP FUNCTION IF EXISTS public.ad_channel_source_map(TEXT);

-- The sources counted as each channel in a view, with the creation-date range
-- [created_from, created_before) an account must fall in. NULL is unbounded.
CREATE FUNCTION public.ad_channel_source_map(p_view TEXT DEFAULT 'paid')
RETURNS TABLE (source_value TEXT, channel TEXT, created_from DATE, created_before DATE)
LANGUAGE sql IMMUTABLE
AS $$
  SELECT v.source_value, v.channel, v.created_from, v.created_before
  FROM (VALUES
    ('Google Ads',       'google', 'paid',    NULL::DATE,                       NULL::DATE),
    ('Meta Ads',         'meta',   'paid',    NULL,                             NULL),
    ('Google Organique', 'google', 'organic', public.ad_google_organic_since(), NULL),
    ('Meta Organique',   'meta',   'organic', NULL,                             NULL),
    ('Google Organique', 'google', 'unknown', NULL,                             public.ad_google_organic_since()),
    -- Legacy: what p_organic => true meant before the split. Not offered by the page.
    ('Google Organique', 'google', 'organic_all', NULL,                         NULL),
    ('Meta Organique',   'meta',   'organic_all', NULL,                         NULL)
  ) AS v(source_value, channel, view, created_from, created_before)
  WHERE v.view = COALESCE(p_view, 'paid');
$$;

DROP FUNCTION IF EXISTS public.ad_source_first_used(BOOLEAN);
DROP FUNCTION IF EXISTS public.ad_source_first_used(TEXT);

-- Creation date of the first account counted for each channel in a view.
CREATE FUNCTION public.ad_source_first_used(p_view TEXT DEFAULT 'paid')
RETURNS TABLE (channel TEXT, first_used DATE)
LANGUAGE sql STABLE
AS $$
  SELECT m.channel, min(public.zoho_local_date(a.created_time))
  FROM public.zoho_accounts a
  JOIN public.ad_channel_source_map(p_view) m
    ON m.source_value = a.origine_du_client
   AND (m.created_from   IS NULL OR public.zoho_local_date(a.created_time) >= m.created_from)
   AND (m.created_before IS NULL OR public.zoho_local_date(a.created_time) <  m.created_before)
  WHERE a.created_time IS NOT NULL
  GROUP BY m.channel;
$$;

GRANT EXECUTE ON FUNCTION public.ad_google_organic_since()      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ad_resolve_view(TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ad_channel_source_map(TEXT)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ad_source_first_used(TEXT)     TO authenticated, service_role;

-- ─── Performance per channel ──────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_ad_performance(INT, INT, INT, TEXT[], BOOLEAN);
DROP FUNCTION IF EXISTS public.get_ad_performance(
  INT, INT, INT, TEXT[], BOOLEAN, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[]);

CREATE FUNCTION public.get_ad_performance(
  p_year            INT     DEFAULT NULL,
  p_month           INT     DEFAULT NULL,
  p_window_months   INT     DEFAULT 12,
  p_exclude_ratings TEXT[]  DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur'],
  p_organic         BOOLEAN DEFAULT false,
  p_view            TEXT    DEFAULT NULL,
  p_reps            TEXT[]  DEFAULT NULL,
  p_sources         TEXT[]  DEFAULT NULL,
  p_services        TEXT[]  DEFAULT NULL,
  p_domaines        TEXT[]  DEFAULT NULL,
  p_regions         TEXT[]  DEFAULT NULL
)
RETURNS TABLE (
  channel              TEXT,
  sources              TEXT[],
  currencies           TEXT[],
  spend                NUMERIC,
  impressions          BIGINT,
  clicks               BIGINT,
  platform_conversions NUMERIC,
  platform_leads       NUMERIC,
  accounts_created     BIGINT,
  accounts_invoiced    BIGINT,
  revenue_attributed   NUMERIC,
  revenue_lifetime     NUMERIC,
  revenue_per_account  NUMERIC,
  cost_per_account     NUMERIC,
  cost_per_client      NUMERIC,
  roas                 NUMERIC,
  net                  NUMERIC,
  days_with_spend      BIGINT,
  window_ends_on       DATE,
  source_first_used    DATE,
  cohort_from          DATE,
  cohort_before        DATE
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH period AS (
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
$$;

GRANT EXECUTE ON FUNCTION public.get_ad_performance(
  INT, INT, INT, TEXT[], BOOLEAN, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[]) TO authenticated, service_role;

-- ─── Monthly per channel ──────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_ad_monthly(INT, INT, TEXT[], BOOLEAN);
DROP FUNCTION IF EXISTS public.get_ad_monthly(
  INT, INT, TEXT[], BOOLEAN, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[]);

CREATE FUNCTION public.get_ad_monthly(
  p_year            INT,
  p_window_months   INT     DEFAULT 12,
  p_exclude_ratings TEXT[]  DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur'],
  p_organic         BOOLEAN DEFAULT false,
  p_view            TEXT    DEFAULT NULL,
  p_reps            TEXT[]  DEFAULT NULL,
  p_sources         TEXT[]  DEFAULT NULL,
  p_services        TEXT[]  DEFAULT NULL,
  p_domaines        TEXT[]  DEFAULT NULL,
  p_regions         TEXT[]  DEFAULT NULL
)
RETURNS TABLE (
  channel              TEXT,
  month                INT,
  spend                NUMERIC,
  platform_conversions NUMERIC,
  accounts_created     BIGINT,
  accounts_invoiced    BIGINT,
  revenue_attributed   NUMERIC,
  revenue_per_account  NUMERIC,
  cost_per_account     NUMERIC,
  roas                 NUMERIC,
  window_ends_on       DATE,
  source_first_used    DATE
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH map AS (
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
$$;

GRANT EXECUTE ON FUNCTION public.get_ad_monthly(
  INT, INT, TEXT[], BOOLEAN, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[]) TO authenticated, service_role;

-- ─── Filter options ───────────────────────────────────────────────────────────
-- Drawn from the accounts the view actually counts, so every value offered
-- matches at least one account of the year. Sources are the view's own, listed
-- even in a year that has no account yet.

CREATE OR REPLACE FUNCTION public.get_ad_filter_options(
  p_year            INT    DEFAULT NULL,
  p_exclude_ratings TEXT[] DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur'],
  p_view            TEXT   DEFAULT 'paid'
)
RETURNS TABLE (
  sources  TEXT[],
  services TEXT[],
  reps     TEXT[],
  domaines TEXT[],
  regions  TEXT[]
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
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
                FROM scoped s WHERE COALESCE(btrim(s.region_administrative), '') NOT IN ('', '-None-')), '{}');
$$;

GRANT EXECUTE ON FUNCTION public.get_ad_filter_options(INT, TEXT[], TEXT) TO authenticated, service_role;
