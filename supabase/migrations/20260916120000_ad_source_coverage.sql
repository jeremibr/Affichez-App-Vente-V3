-- Source-tag coverage for the Publicité RPCs.
--
-- The CRM origins mapped to each channel only exist from a certain date
-- (e.g. "Publicité/Recherche Google" from 2026-02-16, "Meta Ads" from
-- 2024-08-21). Spend before that date has no tagged accounts to compare with.
--
--   * source_first_used: creation date of the first account carrying one of the
--     channel's origins, so the UI can flag periods that start before it.
--   * roas and net are NULL when the period has no tagged accounts: there is no
--     cohort to measure, and 0 / a negative net would read as a real result.
--
-- Return types change, so both functions are dropped and recreated.

-- ─── Helper ───────────────────────────────────────────────────────────────────
-- SECURITY INVOKER sql function without a SET clause (CLAUDE.md, performance rule 1).

CREATE OR REPLACE FUNCTION public.ad_source_first_used()
RETURNS TABLE (channel TEXT, first_used DATE)
LANGUAGE sql STABLE
AS $$
  SELECT m.channel, min((a.created_time AT TIME ZONE 'America/Toronto')::date)
  FROM public.zoho_accounts a
  JOIN public.ad_channel_source_map() m ON m.source_value = a.origine_du_client
  WHERE a.created_time IS NOT NULL
  GROUP BY m.channel;
$$;

GRANT EXECUTE ON FUNCTION public.ad_source_first_used() TO authenticated;


-- ─── Performance per channel ──────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_ad_performance(INT, INT, INT, TEXT[]);

CREATE FUNCTION public.get_ad_performance(
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
  window_ends_on       DATE,
  source_first_used    DATE
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
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0
         THEN ROUND(acct.revenue_attributed / NULLIF(sp.spend, 0), 2) END,
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0
         THEN ROUND(acct.revenue_attributed - COALESCE(sp.spend, 0), 2) END,
    COALESCE(sp.days_with_spend, 0),
    (SELECT public.ad_window_ends_on(p.period_end, p_window_months) FROM period p),
    fu.first_used
  FROM ch
  LEFT JOIN sp   ON sp.channel   = ch.channel
  LEFT JOIN src  ON src.channel  = ch.channel
  LEFT JOIN acct ON acct.channel = ch.channel
  LEFT JOIN public.ad_source_first_used() fu ON fu.channel = ch.channel
  ORDER BY ch.channel;
$$;

GRANT EXECUTE ON FUNCTION public.get_ad_performance(INT, INT, INT, TEXT[]) TO authenticated;


-- ─── Monthly per channel ──────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_ad_monthly(INT, INT, TEXT[]);

CREATE FUNCTION public.get_ad_monthly(
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
  window_ends_on       DATE,
  source_first_used    DATE
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
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0
         THEN ROUND(acct.revenue_attributed / NULLIF(sp.spend, 0), 2) END,
    public.ad_window_ends_on(
      (pg_catalog.make_date(p_year, g.month, 1) + INTERVAL '1 month')::date,
      p_window_months),
    fu.first_used
  FROM grid g
  LEFT JOIN sp   ON sp.channel   = g.channel AND sp.month   = g.month
  LEFT JOIN acct ON acct.channel = g.channel AND acct.month = g.month
  LEFT JOIN public.ad_source_first_used() fu ON fu.channel = g.channel
  ORDER BY g.channel, g.month;
$$;

GRANT EXECUTE ON FUNCTION public.get_ad_monthly(INT, INT, TEXT[]) TO authenticated;
