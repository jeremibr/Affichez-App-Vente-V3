-- Advertising spend (Google Ads, Meta) and the RPCs that compare it with the
-- revenue of the CRM accounts attributed to each channel.
--
-- Attribution is by channel and calendar month: spend in a month is compared with
-- the accounts created in that month whose origine_du_client belongs to the
-- channel. The CRM stores no click identifiers, so spend is never joined to
-- revenue at campaign level.
--
-- A cohort keeps accruing revenue until its attribution window closes, so every
-- RPC returns window_ends_on and the UI marks periods whose window is still open.


-- ─── Spend ────────────────────────────────────────────────────────────────────
-- Daily per campaign. The sync re-pulls a rolling window because both platforms
-- restate recent spend (invalid-click credits, late conversions); the primary key
-- turns those re-pulls into idempotent upserts.

CREATE TABLE IF NOT EXISTS ad_spend_daily (
  platform        TEXT NOT NULL CHECK (platform IN ('google', 'meta')),
  -- Google: customer id, digits only. Meta: ad account id without the act_ prefix.
  ad_account_id   TEXT NOT NULL,
  campaign_id     TEXT NOT NULL,
  campaign_name   TEXT,
  campaign_status TEXT,
  spend_date      DATE NOT NULL,
  -- Ad account currency as reported by the platform. Revenue is CAD; the page
  -- warns when this is anything else.
  currency        TEXT,
  -- Full precision (Google reports micros). Rounded only in RPC output, so
  -- summed totals match the platform's own totals to the cent.
  spend           NUMERIC(18,6) NOT NULL DEFAULT 0,
  impressions     BIGINT        NOT NULL DEFAULT 0,
  clicks          BIGINT        NOT NULL DEFAULT 0,
  -- Platform-reported. Google: metrics.conversions. Meta: lead actions.
  conversions     NUMERIC(14,4) NOT NULL DEFAULT 0,
  -- Lead-typed actions; only Meta reports these.
  leads           NUMERIC(14,4) NOT NULL DEFAULT 0,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, ad_account_id, campaign_id, spend_date)
);

-- The PK leads on platform and cannot serve the date-range filter every RPC uses.
CREATE INDEX IF NOT EXISTS ad_spend_daily_date_idx
  ON ad_spend_daily (spend_date, platform);

COMMENT ON TABLE ad_spend_daily IS
  'Daily per-campaign ad spend from Google Ads and Meta. Written only by the '
  'ads-spend-sync edge function; re-pulled on a rolling window.';


-- ─── Access ───────────────────────────────────────────────────────────────────
-- Spend is admin-only at the row level. The RPCs below are SECURITY INVOKER, so a
-- non-admin caller receives zero spend rather than an error.

CREATE OR REPLACE FUNCTION public.app_is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.allowed_users u
     WHERE lower(u.email) = lower(auth.jwt() ->> 'email')
       AND u.role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.app_is_admin() TO authenticated;

ALTER TABLE ad_spend_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_spend_daily_select_admin" ON ad_spend_daily;
CREATE POLICY "ad_spend_daily_select_admin"
  ON ad_spend_daily FOR SELECT TO authenticated USING (public.app_is_admin());


-- ─── Helpers ──────────────────────────────────────────────────────────────────
-- SECURITY INVOKER sql functions without a SET clause, so the planner can inline
-- them (see CLAUDE.md, performance rule 1). References are schema-qualified.

-- Both channels, so callers always return a row per channel even with no data.
CREATE OR REPLACE FUNCTION public.ad_channels()
RETURNS TEXT[] LANGUAGE sql IMMUTABLE
AS $$ SELECT ARRAY['google', 'meta']; $$;

-- The origine_du_client values counted as each channel.
CREATE OR REPLACE FUNCTION public.ad_channel_source_map()
RETURNS TABLE (source_value TEXT, channel TEXT)
LANGUAGE sql IMMUTABLE
AS $$
  VALUES ('Publicité/Recherche Google', 'google'),
         ('Meta Ads',                   'meta');
$$;

-- Half-open [start, end) date range for a year, or a month within it. A NULL
-- year means all dates. Returned as bounds rather than applied with EXTRACT so
-- callers can filter with an index-servable range (CLAUDE.md, rule 2).
CREATE OR REPLACE FUNCTION public.ad_period(p_year INT, p_month INT)
RETURNS TABLE (period_start DATE, period_end DATE)
LANGUAGE sql IMMUTABLE
AS $$
  SELECT
    CASE
      WHEN p_year IS NULL  THEN '-infinity'::date
      WHEN p_month IS NULL THEN pg_catalog.make_date(p_year, 1, 1)
      ELSE pg_catalog.make_date(p_year, p_month, 1)
    END,
    CASE
      WHEN p_year IS NULL  THEN 'infinity'::date
      WHEN p_month IS NULL THEN pg_catalog.make_date(p_year + 1, 1, 1)
      ELSE (pg_catalog.make_date(p_year, p_month, 1) + INTERVAL '1 month')::date
    END;
$$;

-- Date by which every account created before p_period_end has had its full
-- attribution window. NULL when the window is uncapped or the period is unbounded.
CREATE OR REPLACE FUNCTION public.ad_window_ends_on(p_period_end DATE, p_months INT)
RETURNS DATE LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_months IS NULL OR p_period_end = 'infinity'::date THEN NULL
    ELSE (p_period_end + pg_catalog.make_interval(months => p_months))::date
  END;
$$;

GRANT EXECUTE ON FUNCTION public.ad_channels() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ad_channel_source_map() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ad_period(INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ad_window_ends_on(DATE, INT) TO authenticated;


-- ─── Performance per channel ──────────────────────────────────────────────────
-- Accounts and revenue go through zoho_accounts_scoped, the same scoping the
-- Comptes dashboard uses, so figures reconcile with its "Par source" table.
-- Ratios are NULL when their denominator is zero or missing.

CREATE OR REPLACE FUNCTION get_ad_performance(
  p_year            INT    DEFAULT NULL,
  p_month           INT    DEFAULT NULL,
  p_window_months   INT    DEFAULT 12,
  p_exclude_ratings TEXT[] DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur']
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
  window_ends_on       DATE
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH period AS (
    SELECT * FROM public.ad_period(p_year, p_month)
  ),
  ch AS (
    SELECT unnest(public.ad_channels()) AS channel
  ),
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
    WHERE d.spend_date >= p.period_start
      AND d.spend_date <  p.period_end
    GROUP BY d.platform
  ),
  src AS (
    SELECT m.channel, array_agg(m.source_value ORDER BY m.source_value) AS sources
    FROM public.ad_channel_source_map() m
    GROUP BY m.channel
  ),
  scoped AS (
    SELECT s.*, m.channel
    -- The month only applies within a year, matching ad_period's spend range.
    FROM public.zoho_accounts_scoped(
           p_year, CASE WHEN p_year IS NULL THEN NULL ELSE p_month END,
           NULL, NULL, NULL, NULL, NULL, p_exclude_ratings) s
    JOIN public.ad_channel_source_map() m ON m.source_value = s.origine_du_client
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
  )
  SELECT
    ch.channel,
    COALESCE(src.sources, ARRAY[]::TEXT[]),
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
    -- Divided by all accounts created, matching revenue_per_account on Comptes.
    ROUND(COALESCE(sp.spend, 0) / NULLIF(acct.accounts_created, 0), 2),
    ROUND(COALESCE(sp.spend, 0) / NULLIF(acct.accounts_invoiced, 0), 2),
    ROUND(COALESCE(acct.revenue_attributed, 0) / NULLIF(sp.spend, 0), 2),
    ROUND(COALESCE(acct.revenue_attributed, 0) - COALESCE(sp.spend, 0), 2),
    COALESCE(sp.days_with_spend, 0),
    (SELECT public.ad_window_ends_on(p.period_end, p_window_months) FROM period p)
  FROM ch
  LEFT JOIN sp   ON sp.channel   = ch.channel
  LEFT JOIN src  ON src.channel  = ch.channel
  LEFT JOIN acct ON acct.channel = ch.channel
  ORDER BY ch.channel;
$$;

GRANT EXECUTE ON FUNCTION get_ad_performance(INT, INT, INT, TEXT[]) TO authenticated;


-- ─── Monthly per channel ──────────────────────────────────────────────────────
-- All twelve months are returned for both channels, including empty ones.

CREATE OR REPLACE FUNCTION get_ad_monthly(
  p_year            INT,
  p_window_months   INT    DEFAULT 12,
  p_exclude_ratings TEXT[] DEFAULT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur']
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
  window_ends_on       DATE
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH grid AS (
    SELECT c.channel, m.month
    FROM unnest(public.ad_channels()) AS c(channel)
    CROSS JOIN generate_series(1, 12) AS m(month)
  ),
  sp AS (
    SELECT
      d.platform AS channel,
      EXTRACT(MONTH FROM d.spend_date)::INT AS month,
      sum(d.spend)       AS spend,
      sum(d.conversions) AS conversions
    FROM public.ad_spend_daily d
    WHERE d.spend_date >= pg_catalog.make_date(p_year, 1, 1)
      AND d.spend_date <  pg_catalog.make_date(p_year + 1, 1, 1)
    GROUP BY 1, 2
  ),
  scoped AS (
    SELECT s.*, m.channel
    FROM public.zoho_accounts_scoped(
           p_year, NULL, NULL, NULL, NULL, NULL, NULL, p_exclude_ratings) s
    JOIN public.ad_channel_source_map() m ON m.source_value = s.origine_du_client
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
    ROUND(COALESCE(sp.spend, 0) / NULLIF(acct.accounts_created, 0), 2),
    ROUND(COALESCE(acct.revenue_attributed, 0) / NULLIF(sp.spend, 0), 2),
    public.ad_window_ends_on(
      (pg_catalog.make_date(p_year, g.month, 1) + INTERVAL '1 month')::date,
      p_window_months)
  FROM grid g
  LEFT JOIN sp   ON sp.channel   = g.channel AND sp.month   = g.month
  LEFT JOIN acct ON acct.channel = g.channel AND acct.month = g.month
  ORDER BY g.channel, g.month;
$$;

GRANT EXECUTE ON FUNCTION get_ad_monthly(INT, INT, TEXT[]) TO authenticated;


-- ─── Campaigns ────────────────────────────────────────────────────────────────
-- Platform figures only; no revenue, since accounts cannot be traced to campaigns.

CREATE OR REPLACE FUNCTION get_ad_campaigns(
  p_year     INT  DEFAULT NULL,
  p_month    INT  DEFAULT NULL,
  p_platform TEXT DEFAULT NULL
)
RETURNS TABLE (
  platform        TEXT,
  ad_account_id   TEXT,
  campaign_id     TEXT,
  campaign_name   TEXT,
  campaign_status TEXT,
  currency        TEXT,
  spend           NUMERIC,
  impressions     BIGINT,
  clicks          BIGINT,
  conversions     NUMERIC,
  leads           NUMERIC,
  cpc             NUMERIC,
  cpm             NUMERIC,
  cost_per_conv   NUMERIC,
  first_date      DATE,
  last_date       DATE
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH period AS (SELECT * FROM public.ad_period(p_year, p_month))
  SELECT
    d.platform,
    d.ad_account_id,
    d.campaign_id,
    -- Latest name/status, in case the campaign was renamed.
    (array_agg(d.campaign_name   ORDER BY d.spend_date DESC))[1],
    (array_agg(d.campaign_status ORDER BY d.spend_date DESC))[1],
    (array_agg(d.currency        ORDER BY d.spend_date DESC))[1],
    ROUND(COALESCE(sum(d.spend), 0), 2),
    COALESCE(sum(d.impressions), 0),
    COALESCE(sum(d.clicks), 0),
    ROUND(COALESCE(sum(d.conversions), 0), 2),
    ROUND(COALESCE(sum(d.leads), 0), 2),
    ROUND(sum(d.spend) / NULLIF(sum(d.clicks), 0), 2),
    ROUND(sum(d.spend) * 1000 / NULLIF(sum(d.impressions), 0), 2),
    ROUND(sum(d.spend) / NULLIF(sum(d.conversions), 0), 2),
    min(d.spend_date),
    max(d.spend_date)
  FROM public.ad_spend_daily d, period p
  WHERE d.spend_date >= p.period_start
    AND d.spend_date <  p.period_end
    AND (p_platform IS NULL OR d.platform = p_platform)
  GROUP BY d.platform, d.ad_account_id, d.campaign_id
  HAVING sum(d.spend) > 0 OR sum(d.impressions) > 0
  ORDER BY 7 DESC;
$$;

GRANT EXECUTE ON FUNCTION get_ad_campaigns(INT, INT, TEXT) TO authenticated;


-- ─── Sync coverage ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_ad_spend_status()
RETURNS TABLE (
  platform     TEXT,
  ad_accounts  TEXT[],
  currencies   TEXT[],
  campaigns    BIGINT,
  first_date   DATE,
  last_date    DATE,
  days         BIGINT,
  total_spend  NUMERIC,
  last_synced  TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT
    c.platform,
    COALESCE(array_agg(DISTINCT d.ad_account_id) FILTER (WHERE d.ad_account_id IS NOT NULL), ARRAY[]::TEXT[]),
    COALESCE(array_agg(DISTINCT d.currency)      FILTER (WHERE d.currency      IS NOT NULL), ARRAY[]::TEXT[]),
    count(DISTINCT d.campaign_id),
    min(d.spend_date),
    max(d.spend_date),
    count(DISTINCT d.spend_date),
    ROUND(COALESCE(sum(d.spend), 0), 2),
    max(d.synced_at)
  FROM unnest(public.ad_channels()) AS c(platform)
  LEFT JOIN public.ad_spend_daily d ON d.platform = c.platform
  GROUP BY c.platform
  ORDER BY c.platform;
$$;

GRANT EXECUTE ON FUNCTION get_ad_spend_status() TO authenticated;
