-- Current campaign list per ad platform, for the campaign status filter.
--
-- Status lives in its own table rather than on ad_spend_daily: Meta insights carry
-- no status, and daily rows older than the rolling window are never re-synced, so
-- a status copied onto them would go stale. ads-spend-sync refreshes this table
-- from each platform's full campaign list on every run.

CREATE TABLE IF NOT EXISTS ad_campaigns (
  platform        TEXT NOT NULL CHECK (platform IN ('google', 'meta')),
  ad_account_id   TEXT NOT NULL,
  campaign_id     TEXT NOT NULL,
  campaign_name   TEXT,
  -- Normalised across platforms. Google ENABLED/PAUSED/REMOVED,
  -- Meta ACTIVE/PAUSED/DELETED/ARCHIVED.
  status          TEXT NOT NULL CHECK (status IN ('active', 'paused', 'removed', 'unknown')),
  platform_status TEXT,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, ad_account_id, campaign_id)
);

COMMENT ON TABLE ad_campaigns IS
  'Current name and status of every Google Ads / Meta campaign. Refreshed by '
  'ads-spend-sync on every run.';

ALTER TABLE ad_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_campaigns_select_admin" ON ad_campaigns;
CREATE POLICY "ad_campaigns_select_admin"
  ON ad_campaigns FOR SELECT TO authenticated USING (public.app_is_admin());


-- ─── Campaigns RPC ────────────────────────────────────────────────────────────
-- Adds the current status and returns spend unrounded, so the table total equals
-- the channel total exactly. Return type changes, so the function is recreated.

DROP FUNCTION IF EXISTS public.get_ad_campaigns(INT, INT, TEXT);

CREATE FUNCTION public.get_ad_campaigns(
  p_year     INT  DEFAULT NULL,
  p_month    INT  DEFAULT NULL,
  p_platform TEXT DEFAULT NULL
)
RETURNS TABLE (
  platform        TEXT,
  ad_account_id   TEXT,
  campaign_id     TEXT,
  campaign_name   TEXT,
  status          TEXT,
  platform_status TEXT,
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
  WITH period AS (SELECT * FROM public.ad_period(p_year, p_month)),
  agg AS (
    SELECT
      d.platform,
      d.ad_account_id,
      d.campaign_id,
      (array_agg(d.campaign_name ORDER BY d.spend_date DESC))[1] AS campaign_name,
      (array_agg(d.currency      ORDER BY d.spend_date DESC))[1] AS currency,
      sum(d.spend)       AS spend,
      sum(d.impressions) AS impressions,
      sum(d.clicks)      AS clicks,
      sum(d.conversions) AS conversions,
      sum(d.leads)       AS leads,
      min(d.spend_date)  AS first_date,
      max(d.spend_date)  AS last_date
    FROM public.ad_spend_daily d, period p
    WHERE d.spend_date >= p.period_start
      AND d.spend_date <  p.period_end
      AND (p_platform IS NULL OR d.platform = p_platform)
    GROUP BY d.platform, d.ad_account_id, d.campaign_id
    HAVING sum(d.spend) > 0 OR sum(d.impressions) > 0
  )
  SELECT
    a.platform,
    a.ad_account_id,
    a.campaign_id,
    COALESCE(c.campaign_name, a.campaign_name),
    COALESCE(c.status, 'unknown'),
    c.platform_status,
    a.currency,
    a.spend,
    a.impressions,
    a.clicks,
    ROUND(a.conversions, 2),
    ROUND(a.leads, 2),
    ROUND(a.spend / NULLIF(a.clicks, 0), 2),
    ROUND(a.spend * 1000 / NULLIF(a.impressions, 0), 2),
    ROUND(a.spend / NULLIF(a.conversions, 0), 2),
    a.first_date,
    a.last_date
  FROM agg a
  LEFT JOIN public.ad_campaigns c
    ON c.platform = a.platform
   AND c.ad_account_id = a.ad_account_id
   AND c.campaign_id = a.campaign_id
  ORDER BY a.spend DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_ad_campaigns(INT, INT, TEXT) TO authenticated;
