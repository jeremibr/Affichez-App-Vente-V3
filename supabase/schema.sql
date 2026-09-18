-- supabase/schema.sql — snapshot of the live `public` schema, 2026-09-18.
--
-- REFERENCE ONLY. This file is deliberately NOT under supabase/migrations/, so
-- `supabase db push` and the CI deploy ignore it entirely. Nothing applies it.
--
-- Why it exists: a lot of this database has never been in the repo, and that has
-- blocked or complicated four separate fixes. Objects that existed only here,
-- invisible to review and absent from a fresh clone:
--
--   * 8 RPCs the frontend calls every day — get_weekly_detail,
--     get_inv_weekly_detail, get_quarterly_yoy, get_inv_quarterly_yoy,
--     get_available_weeks, get_inv_available_weeks, get_distinct_rep_names,
--     search_clients. Between them they power the whole Weekly Detail page, the
--     per-rep quarterly tables, the rep dropdowns and client search.
--   * all 13 views, including the 8 with owner rights that bypassed invoices RLS
--   * the payroll tables (paye_entries, paye_meta, rep_comm_rates)
--
-- Two of those RPCs are what blocks the YoY zero-vs-unknown fix described in
-- STATS-INTEGRITY.md: the team-total functions are in the repo, the per-rep ones
-- were not, so changing only the visible half would print "—" above rows still
-- printing 0.
--
-- This is a SNAPSHOT and will go stale. It is not the source of truth — the
-- migrations are. Regenerate with Docker running:
--
--     export SUPABASE_DB_PASSWORD=...        # never commit this
--     supabase db dump -s public -f supabase/schema.sql
--
-- Contents at capture: 99 functions, 26 tables, 13 views, 1 materialized view,
-- 37 policies. Schema only — no rows, no secrets (`access_token` appears as a
-- column name on zoho_oauth_token, never a value).




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."department_enum" AS ENUM (
    'MULTI-ANNONCEURS',
    'PROMOTIONNEL',
    'DIST. PUBLICITAIRE SOLO',
    'NUMERIQUE',
    'APPLICATION',
    'SERVICES IA',
    'EVENEMENT'
);


ALTER TYPE "public"."department_enum" OWNER TO "postgres";


COMMENT ON TYPE "public"."department_enum" IS 'Affichez billing departments. EVENEMENT was added 2026-09-07 after the sync stopped discarding unrecognised departments and revealed 160 invoices Zoho had been billing under "ÉVÈNEMENT" since May 2025. Objectives are set per department: objectives_factures has no rows for EVENEMENT yet, so it will show actuals against a zero target until somebody sets them.';



CREATE TYPE "public"."invoice_status_enum" AS ENUM (
    'sent',
    'viewed',
    'paid',
    'partial',
    'overdue',
    'void',
    'avoir'
);


ALTER TYPE "public"."invoice_status_enum" OWNER TO "postgres";


CREATE TYPE "public"."office_enum" AS ENUM (
    'QC',
    'MTL'
);


ALTER TYPE "public"."office_enum" OWNER TO "postgres";


CREATE TYPE "public"."sale_status_enum" AS ENUM (
    'accepted',
    'invoiced',
    'declined'
);


ALTER TYPE "public"."sale_status_enum" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ad_channel_source_map"() RETURNS TABLE("source_value" "text", "channel" "text")
    LANGUAGE "sql" IMMUTABLE
    AS $$
  VALUES ('Publicité/Recherche Google', 'google'),
         ('Meta Ads',                   'meta');
$$;


ALTER FUNCTION "public"."ad_channel_source_map"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ad_channels"() RETURNS "text"[]
    LANGUAGE "sql" IMMUTABLE
    AS $$ SELECT ARRAY['google', 'meta']; $$;


ALTER FUNCTION "public"."ad_channels"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ad_period"("p_year" integer, "p_month" integer) RETURNS TABLE("period_start" "date", "period_end" "date")
    LANGUAGE "sql" IMMUTABLE
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


ALTER FUNCTION "public"."ad_period"("p_year" integer, "p_month" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ad_source_first_used"() RETURNS TABLE("channel" "text", "first_used" "date")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT m.channel, min((a.created_time AT TIME ZONE 'America/Toronto')::date)
  FROM public.zoho_accounts a
  JOIN public.ad_channel_source_map() m ON m.source_value = a.origine_du_client
  WHERE a.created_time IS NOT NULL
  GROUP BY m.channel;
$$;


ALTER FUNCTION "public"."ad_source_first_used"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ad_window_ends_on"("p_period_end" "date", "p_months" integer) RETURNS "date"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE
    WHEN p_months IS NULL OR p_period_end = 'infinity'::date THEN NULL
    ELSE (p_period_end + pg_catalog.make_interval(months => p_months))::date
  END;
$$;


ALTER FUNCTION "public"."ad_window_ends_on"("p_period_end" "date", "p_months" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.allowed_users u
     WHERE lower(u.email) = lower(auth.jwt() ->> 'email')
       AND u.role = 'admin'
  );
$$;


ALTER FUNCTION "public"."app_is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compute_week_boundaries"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  -- ISO week: Monday (1) to Sunday (7)
  NEW.week_start := (NEW.sale_date - ((EXTRACT(ISODOW FROM NEW.sale_date)::INTEGER - 1) || ' days')::INTERVAL)::DATE;
  NEW.week_end := (NEW.week_start + INTERVAL '6 days')::DATE;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."compute_week_boundaries"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_books_customers"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inserted INTEGER;
BEGIN
  WITH candidates AS (
    -- DISTINCT ON keeps one row per customer, preferring the most recent invoice
    -- so customer_name reflects the latest spelling in Books.
    SELECT DISTINCT ON (i.books_customer_id)
           i.books_customer_id, i.office, i.client_name
      FROM invoices i
     WHERE i.books_customer_id IS NOT NULL
       AND i.office IS NOT NULL   -- the org id is needed to call Zoho
     ORDER BY i.books_customer_id, i.invoice_date DESC NULLS LAST
  ), ins AS (
    INSERT INTO zoho_books_customers (books_customer_id, office, customer_name, link_status)
    SELECT books_customer_id, office, client_name, 'pending' FROM candidates
    ON CONFLICT (books_customer_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_inserted FROM ins;

  RETURN v_inserted;
END;
$$;


ALTER FUNCTION "public"."enqueue_books_customers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_account_contacts"("p_account_id" "text") RETURNS TABLE("zoho_record_id" "text", "stage" "text", "full_name" "text", "email" "text", "phone" "text", "rep_name" "text", "lead_status" "text", "created_time" timestamp with time zone, "zoho_crm_url" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT z.zoho_record_id, z.stage, z.full_name, z.email, z.phone,
         z.rep_name, z.lead_status, z.created_time, z.zoho_crm_url
    FROM zoho_leads_unique z
   WHERE p_account_id IS NOT NULL
     AND z.account_id = p_account_id
   ORDER BY (z.stage = 'contact') DESC, z.created_time DESC NULLS LAST;
$$;


ALTER FUNCTION "public"."get_account_contacts"("p_account_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_account_invoice_totals"("p_account_ids" "text"[]) RETURNS TABLE("account_id" "text", "invoice_count" integer, "credit_count" integer, "total_amount" numeric, "last_invoice_date" "date")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$ SELECT * FROM get_lead_invoice_totals(p_account_ids); $$;


ALTER FUNCTION "public"."get_account_invoice_totals"("p_account_ids" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_account_invoices"("p_account_id" "text") RETURNS TABLE("zoho_id" "text", "invoice_number" "text", "client_name" "text", "amount" numeric, "invoice_date" "date", "status" "text", "is_avoir" boolean, "department" "text", "office" "text", "rep_name" "text", "books_customer_id" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$ SELECT * FROM get_lead_invoices(p_account_id); $$;


ALTER FUNCTION "public"."get_account_invoices"("p_account_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_account_revenue_by_department"("p_account_id" "text") RETURNS TABLE("year" integer, "department" "text", "invoice_count" bigint, "credit_count" bigint, "total_amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."get_account_revenue_by_department"("p_account_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ad_campaigns"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_platform" "text" DEFAULT NULL::"text") RETURNS TABLE("platform" "text", "ad_account_id" "text", "campaign_id" "text", "campaign_name" "text", "status" "text", "platform_status" "text", "currency" "text", "spend" numeric, "impressions" bigint, "clicks" bigint, "conversions" numeric, "leads" numeric, "cpc" numeric, "cpm" numeric, "cost_per_conv" numeric, "first_date" "date", "last_date" "date")
    LANGUAGE "sql" STABLE
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


ALTER FUNCTION "public"."get_ad_campaigns"("p_year" integer, "p_month" integer, "p_platform" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ad_monthly"("p_year" integer, "p_window_months" integer DEFAULT 12, "p_exclude_ratings" "text"[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::"text", 'Fournisseur'::"text"]) RETURNS TABLE("channel" "text", "month" integer, "spend" numeric, "platform_conversions" numeric, "accounts_created" bigint, "accounts_invoiced" bigint, "revenue_attributed" numeric, "revenue_per_account" numeric, "cost_per_account" numeric, "roas" numeric, "window_ends_on" "date", "source_first_used" "date")
    LANGUAGE "sql" STABLE
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


ALTER FUNCTION "public"."get_ad_monthly"("p_year" integer, "p_window_months" integer, "p_exclude_ratings" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ad_performance"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_window_months" integer DEFAULT 12, "p_exclude_ratings" "text"[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::"text", 'Fournisseur'::"text"]) RETURNS TABLE("channel" "text", "sources" "text"[], "currencies" "text"[], "spend" numeric, "impressions" bigint, "clicks" bigint, "platform_conversions" numeric, "platform_leads" numeric, "accounts_created" bigint, "accounts_invoiced" bigint, "revenue_attributed" numeric, "revenue_lifetime" numeric, "revenue_per_account" numeric, "cost_per_account" numeric, "cost_per_client" numeric, "roas" numeric, "net" numeric, "days_with_spend" bigint, "window_ends_on" "date", "source_first_used" "date")
    LANGUAGE "sql" STABLE
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


ALTER FUNCTION "public"."get_ad_performance"("p_year" integer, "p_month" integer, "p_window_months" integer, "p_exclude_ratings" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ad_spend_status"() RETURNS TABLE("platform" "text", "ad_accounts" "text"[], "currencies" "text"[], "campaigns" bigint, "first_date" "date", "last_date" "date", "days" bigint, "total_spend" numeric, "last_synced" timestamp with time zone)
    LANGUAGE "sql" STABLE
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


ALTER FUNCTION "public"."get_ad_spend_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_available_weeks"("p_year" integer DEFAULT NULL::integer, "p_office" "public"."office_enum" DEFAULT NULL::"public"."office_enum", "p_status" "public"."sale_status_enum" DEFAULT NULL::"public"."sale_status_enum") RETURNS TABLE("week_start" "date", "week_end" "date", "total_amount" numeric, "num_sales" bigint)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  SELECT s.week_start, s.week_end, COALESCE(SUM(s.amount),0), COUNT(*)
  FROM sales s
  WHERE (p_year IS NULL OR s.year = p_year)
    AND s.status::text != 'declined'
    AND (p_office IS NULL OR s.office = p_office)
    AND (p_status IS NULL OR s.status = p_status)
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (s.rep_name IS NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  GROUP BY s.week_start, s.week_end
  ORDER BY s.week_start DESC;
END;
$$;


ALTER FUNCTION "public"."get_available_weeks"("p_year" integer, "p_office" "public"."office_enum", "p_status" "public"."sale_status_enum") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_creator_detail"("p_creator" "text", "p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_office" "text" DEFAULT NULL::"text", "p_module" "text" DEFAULT NULL::"text") RETURNS TABLE("module" "text", "doc_number" "text", "doc_date" "date", "client_name" "text", "department" "text", "office" "text", "sold_by" "text", "status" "text", "amount" numeric, "is_avoir" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT 'devis', s.quote_number, s.sale_date, s.client_name,
         COALESCE(s.department::TEXT, 'Non assigné'), s.office::TEXT,
         s.rep_name, s.status::TEXT, s.amount, FALSE
    FROM sales s
   WHERE s.created_by_name = p_creator
     AND (p_module IS NULL OR p_module = 'devis')
     AND (p_year   IS NULL OR EXTRACT(YEAR  FROM s.sale_date)::INT = p_year)
     AND (p_month  IS NULL OR EXTRACT(MONTH FROM s.sale_date)::INT = p_month)
     AND (p_office IS NULL OR s.office::TEXT = p_office)
  UNION ALL
  SELECT 'factures', v.invoice_number, v.invoice_date, v.client_name,
         COALESCE(v.department, 'Non assigné'), v.office::TEXT,
         v.rep_name, v.status::TEXT, v.amount, v.is_avoir
    FROM invoices v
   WHERE v.created_by_name = p_creator
     AND (p_module IS NULL OR p_module = 'factures')
     AND (p_year   IS NULL OR EXTRACT(YEAR  FROM v.invoice_date)::INT = p_year)
     AND (p_month  IS NULL OR EXTRACT(MONTH FROM v.invoice_date)::INT = p_month)
     AND (p_office IS NULL OR v.office::TEXT = p_office)
  ORDER BY 3 DESC NULLS LAST, 2 DESC;
$$;


ALTER FUNCTION "public"."get_creator_detail"("p_creator" "text", "p_year" integer, "p_month" integer, "p_office" "text", "p_module" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_creator_summary"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_office" "text" DEFAULT NULL::"text") RETURNS TABLE("creator" "text", "quotes_created" bigint, "quotes_won" bigint, "quotes_amount" numeric, "quotes_won_amount" numeric, "invoices_created" bigint, "invoices_amount" numeric, "win_rate" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  WITH q AS (
    SELECT COALESCE(s.created_by_name, 'Inconnu') AS creator,
           count(*) AS created,
           count(*) FILTER (WHERE s.status = 'invoiced') AS won,
           COALESCE(sum(s.amount), 0) AS amt,
           COALESCE(sum(s.amount) FILTER (WHERE s.status = 'invoiced'), 0) AS won_amt
      FROM sales s
     WHERE s.created_by_name IS NOT NULL
       AND (p_year   IS NULL OR EXTRACT(YEAR  FROM s.sale_date)::INT = p_year)
       AND (p_month  IS NULL OR EXTRACT(MONTH FROM s.sale_date)::INT = p_month)
       AND (p_office IS NULL OR s.office::TEXT = p_office)
     GROUP BY 1
  ),
  i AS (
    SELECT COALESCE(v.created_by_name, 'Inconnu') AS creator,
           -- Credit notes are not something anybody "created" in the sense meant
           -- here, and counting them would make a busy month look busier.
           count(*) FILTER (WHERE NOT v.is_avoir) AS created,
           COALESCE(sum(v.amount), 0) AS amt
      FROM invoices v
     WHERE v.created_by_name IS NOT NULL
       AND (p_year   IS NULL OR EXTRACT(YEAR  FROM v.invoice_date)::INT = p_year)
       AND (p_month  IS NULL OR EXTRACT(MONTH FROM v.invoice_date)::INT = p_month)
       AND (p_office IS NULL OR v.office::TEXT = p_office)
     GROUP BY 1
  )
  SELECT
    COALESCE(q.creator, i.creator),
    COALESCE(q.created, 0),
    COALESCE(q.won, 0),
    COALESCE(q.amt, 0),
    COALESCE(q.won_amt, 0),
    COALESCE(i.created, 0),
    COALESCE(i.amt, 0),
    CASE WHEN COALESCE(q.created, 0) = 0 THEN 0
         ELSE ROUND(COALESCE(q.won, 0) * 100.0 / q.created, 1) END
  FROM q FULL OUTER JOIN i ON i.creator = q.creator
  ORDER BY COALESCE(q.created, 0) + COALESCE(i.created, 0) DESC;
$$;


ALTER FUNCTION "public"."get_creator_summary"("p_year" integer, "p_month" integer, "p_office" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_dashboard_kpis"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("ytd_total" numeric, "ytd_count" bigint, "avg_deal_size" numeric, "annual_target" numeric, "pct_of_target" numeric, "invoiced_total" numeric, "accepted_total" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  WITH filtered_sales AS (
    SELECT amount, status FROM sales
    WHERE EXTRACT(year FROM sale_date::date) = p_year
      AND status::text != 'declined'
      AND (p_office IS NULL OR office::text = p_office)
      AND (p_status IS NULL OR status::text = p_status)
      AND (p_month  IS NULL OR EXTRACT(month FROM sale_date::date) = p_month)
      AND (p_dept   IS NULL OR department::text = p_dept)
      AND (p_rep    IS NULL OR rep_name = p_rep)
      AND (p_reps   IS NULL OR rep_name = ANY(p_reps))
      AND client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (rep_name IS NULL OR p_reps IS NOT NULL OR rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  ),
  agg AS (
    SELECT COALESCE(SUM(amount),0) AS ytd_total, COUNT(*) AS ytd_count,
      COALESCE(AVG(amount),0) AS avg_deal_size,
      COALESCE(SUM(amount) FILTER (WHERE status::text='invoiced'),0) AS invoiced_total,
      COALESCE(SUM(amount) FILTER (WHERE status::text='accepted'),0) AS accepted_total
    FROM filtered_sales
  ),
  obj AS (
    SELECT COALESCE(SUM(o_target), 0) AS annual_target
    FROM (
      SELECT target_amount AS o_target FROM rep_objectives
      WHERE p_office IS NULL
        AND p_rep IS NOT NULL AND rep_name = p_rep AND module = 'devis' AND year = p_year
        AND (p_month IS NULL OR month = p_month)
      UNION ALL
      SELECT target_amount AS o_target FROM objectives
      WHERE p_office IS NULL
        AND p_rep IS NULL AND year = p_year
        AND (p_month IS NULL OR month = p_month)
        AND (p_dept IS NULL OR department::text = p_dept)
    ) combined
  )
  SELECT agg.ytd_total, agg.ytd_count, agg.avg_deal_size, obj.annual_target,
    CASE WHEN obj.annual_target=0 THEN 0
         ELSE ROUND((agg.ytd_total/obj.annual_target*100)::numeric,1) END,
    agg.invoiced_total, agg.accepted_total
  FROM agg, obj;
$$;


ALTER FUNCTION "public"."get_dashboard_kpis"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_distinct_rep_names"() RETURNS TABLE("rep_name" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT DISTINCT s.rep_name FROM sales s WHERE s.rep_name IS NOT NULL
  UNION
  SELECT DISTINCT i.rep_name FROM invoices i WHERE i.rep_name IS NOT NULL
  ORDER BY 1;
$$;


ALTER FUNCTION "public"."get_distinct_rep_names"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_inv_available_weeks"("p_year" integer DEFAULT NULL::integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text") RETURNS TABLE("week_start" "date", "week_end" "date", "total_amount" numeric, "num_sales" bigint)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    date_trunc('week', i.invoice_date)::date,
    (date_trunc('week', i.invoice_date)::date + 6)::date,
    COALESCE(SUM(i.amount),0)::numeric,
    COUNT(*)::bigint
  FROM invoices i
  WHERE (p_year IS NULL OR EXTRACT(year FROM i.invoice_date)::int = p_year)
    AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
              ELSE i.status::text = p_status END)
    AND (p_office IS NULL OR i.office::text = p_office)
    AND (p_rep    IS NULL OR i.rep_name = p_rep)
    AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (i.rep_name IS NULL OR i.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  GROUP BY date_trunc('week', i.invoice_date)::date, (date_trunc('week', i.invoice_date)::date + 6)::date
  ORDER BY 1 DESC;
END;
$$;


ALTER FUNCTION "public"."get_inv_available_weeks"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_inv_dashboard_kpis"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("ytd_total" numeric, "ytd_count" bigint, "avg_deal_size" numeric, "annual_target" numeric, "pct_of_target" numeric, "paid_total" numeric, "partial_total" numeric, "avoir_total" numeric)
    LANGUAGE "sql"
    AS $$
  WITH filtered AS (
    SELECT amount, status, is_avoir FROM invoices
    WHERE EXTRACT(year FROM invoice_date)::int = p_year
      AND (CASE WHEN p_status IS NULL THEN status::text NOT IN ('void')
                ELSE status::text = p_status END)
      AND (p_office IS NULL OR office::text = p_office)
      AND (p_month  IS NULL OR EXTRACT(month FROM invoice_date)::int = p_month)
      AND (p_dept   IS NULL OR department::text = p_dept)
      AND (p_rep    IS NULL OR rep_name = p_rep)
      AND (p_reps IS NULL OR rep_name = ANY(p_reps))
      AND client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (rep_name IS NULL OR p_reps IS NOT NULL OR rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  ),
  agg AS (
    SELECT
      COALESCE(SUM(amount),0)::numeric                                         AS ytd_total,
      COUNT(*) FILTER (WHERE NOT is_avoir)                                      AS ytd_count,
      COALESCE(AVG(amount) FILTER (WHERE NOT is_avoir),0)::numeric             AS avg_deal_size,
      COALESCE(SUM(amount) FILTER (WHERE status::text='paid'),  0)::numeric    AS paid_total,
      COALESCE(SUM(amount) FILTER (WHERE status::text='partial'),0)::numeric   AS partial_total,
      COALESCE(SUM(amount) FILTER (WHERE is_avoir),             0)::numeric    AS avoir_total
    FROM filtered
  ),
  obj AS (
    SELECT COALESCE(SUM(o_target),0)::numeric AS annual_target
    FROM (
      SELECT target_amount AS o_target FROM rep_objectives
      WHERE p_office IS NULL
        AND p_rep IS NOT NULL AND rep_name=p_rep AND module='factures' AND year=p_year
        AND (p_month IS NULL OR month=p_month)
      UNION ALL
      SELECT target_amount AS o_target FROM objectives_factures
      WHERE p_office IS NULL
        AND p_rep IS NULL AND year=p_year
        AND (p_month IS NULL OR month=p_month)
        AND (p_dept IS NULL OR department::text=p_dept)
    ) combined
  )
  SELECT agg.ytd_total, agg.ytd_count, agg.avg_deal_size, obj.annual_target,
    CASE WHEN obj.annual_target=0 THEN 0
         ELSE ROUND((agg.ytd_total/obj.annual_target*100)::numeric,1) END,
    agg.paid_total, agg.partial_total, agg.avoir_total
  FROM agg, obj;
$$;


ALTER FUNCTION "public"."get_inv_dashboard_kpis"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_inv_quarterly_yoy"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text") RETURNS TABLE("quarter" integer, "rep_name" "text", "office" "text", "current_avg" numeric, "previous_avg" numeric, "resultat" numeric, "deal_count" bigint)
    LANGUAGE "sql"
    AS $$
WITH fq_weeks AS (
  SELECT year, quarter, start_date, end_date, num_weeks,
    CASE WHEN end_date < CURRENT_DATE THEN num_weeks
         WHEN start_date > CURRENT_DATE THEN 1
         ELSE LEAST(num_weeks, CEIL((CURRENT_DATE - start_date + 1)::float / 7)::int)
    END AS weeks_completed
  FROM fiscal_quarters
),
current_year AS (
  SELECT fq.quarter, i.rep_name, COALESCE(p_office,'Tous')::text AS office,
    (SUM(i.amount)::numeric / MAX(fq.weeks_completed)) AS avg_deal, COUNT(*)::bigint AS deal_count
  FROM invoices i
  JOIN fq_weeks fq ON i.invoice_date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year
    AND NOT i.is_avoir
    AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
              ELSE i.status::text = p_status END)
    AND (p_office IS NULL OR i.office::text = p_office)
    AND (p_rep    IS NULL OR i.rep_name = p_rep)
    AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND i.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
    AND i.rep_name IS NOT NULL
  GROUP BY fq.quarter, i.rep_name
),
previous_year AS (
  SELECT fq.quarter, i.rep_name,
    (SUM(i.amount)::numeric / MAX(fq.weeks_completed)) AS avg_deal
  FROM invoices i
  JOIN fq_weeks fq ON i.invoice_date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year - 1
    AND NOT i.is_avoir
    AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
              ELSE i.status::text = p_status END)
    AND (p_office IS NULL OR i.office::text = p_office)
    AND (p_rep    IS NULL OR i.rep_name = p_rep)
    AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND i.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
    AND i.rep_name IS NOT NULL
  GROUP BY fq.quarter, i.rep_name
)
SELECT cy.quarter, cy.rep_name, cy.office,
  cy.avg_deal, COALESCE(py.avg_deal,0),
  cy.avg_deal - COALESCE(py.avg_deal,0), cy.deal_count
FROM current_year cy
LEFT JOIN previous_year py ON cy.quarter=py.quarter AND cy.rep_name=py.rep_name
ORDER BY cy.quarter, cy.rep_name;
$$;


ALTER FUNCTION "public"."get_inv_quarterly_yoy"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_inv_quarterly_yoy_totals"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text") RETURNS TABLE("quarter" integer, "current_total" numeric, "previous_total" numeric)
    LANGUAGE "sql" STABLE
    AS $$
WITH fq_weeks AS (
  SELECT year, quarter, start_date, end_date, num_weeks,
    CASE WHEN end_date < CURRENT_DATE THEN num_weeks
         WHEN start_date > CURRENT_DATE THEN 1
         ELSE LEAST(num_weeks, CEIL((CURRENT_DATE - start_date + 1)::float / 7)::int)
    END AS weeks_completed
  FROM fiscal_quarters
),
cur AS (
  SELECT fq.quarter, SUM(i.amount)::numeric / MAX(fq.weeks_completed) AS total
  FROM invoices i
  JOIN fq_weeks fq ON i.invoice_date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year
    AND NOT i.is_avoir
    AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
              ELSE i.status::text = p_status END)
    AND (p_office IS NULL OR i.office::text = p_office)
    AND i.rep_name IS NOT NULL
    AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND i.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
  GROUP BY fq.quarter
),
prev AS (
  SELECT fq.quarter, SUM(i.amount)::numeric / MAX(fq.weeks_completed) AS total
  FROM invoices i
  JOIN fq_weeks fq ON i.invoice_date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year - 1
    AND NOT i.is_avoir
    AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
              ELSE i.status::text = p_status END)
    AND (p_office IS NULL OR i.office::text = p_office)
    AND i.rep_name IS NOT NULL
    AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND i.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
  GROUP BY fq.quarter
)
SELECT q.quarter,
       COALESCE(cur.total, 0)::numeric  AS current_total,
       COALESCE(prev.total, 0)::numeric AS previous_total
FROM (SELECT DISTINCT quarter FROM fq_weeks) q
LEFT JOIN cur  ON cur.quarter  = q.quarter
LEFT JOIN prev ON prev.quarter = q.quarter
ORDER BY q.quarter;
$$;


ALTER FUNCTION "public"."get_inv_quarterly_yoy_totals"("p_year" integer, "p_office" "text", "p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_inv_rep_leaderboard"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("rep_name" "text", "office" "text", "total_amount" numeric, "deal_count" bigint, "avg_deal" numeric, "rank" bigint)
    LANGUAGE "sql"
    AS $$
  WITH base AS (
    SELECT i.rep_name, MAX(i.office::text) AS office,
      SUM(i.amount)::numeric                               AS total_amount,
      COUNT(*) FILTER (WHERE NOT i.is_avoir)::bigint       AS deal_count,
      AVG(i.amount) FILTER (WHERE NOT i.is_avoir)::numeric AS avg_deal
    FROM invoices i
    WHERE EXTRACT(year FROM i.invoice_date)::int = p_year
      AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
                ELSE i.status::text = p_status END)
      AND (p_office IS NULL OR i.office::text = p_office)
      AND (p_month  IS NULL OR EXTRACT(month FROM i.invoice_date)::int = p_month)
      AND (p_dept   IS NULL OR i.department::text = p_dept)
      AND (p_rep    IS NULL OR i.rep_name = p_rep)
      AND (p_reps IS NULL OR i.rep_name = ANY(p_reps))
      AND i.rep_name IS NOT NULL
      AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (p_reps IS NOT NULL OR i.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    GROUP BY i.rep_name
  )
  SELECT rep_name, office, total_amount, deal_count, avg_deal,
    ROW_NUMBER() OVER (ORDER BY total_amount DESC)
  FROM base ORDER BY total_amount DESC;
$$;


ALTER FUNCTION "public"."get_inv_rep_leaderboard"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_inv_sommaire"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("month" integer, "department" "text", "objectif" numeric, "actual_amount" numeric, "pct_atteint" numeric, "deal_count" bigint)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o.month AS o_month, o.department AS o_dept, o.target_amount AS o_total
    FROM objectives_factures o
    WHERE o.year = p_year
      AND p_office IS NULL
  ),
  inv_agg AS (
    SELECT EXTRACT(month FROM i.invoice_date)::int AS i_month,
      i.department AS i_dept,
      COALESCE(SUM(i.amount),0)::numeric AS i_total, COUNT(*)::bigint AS i_count
    FROM invoices i
    WHERE EXTRACT(year FROM i.invoice_date)::int = p_year
      AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
                ELSE i.status::text = p_status END)
      AND (p_office IS NULL OR i.office::text = p_office)
      AND (p_rep    IS NULL OR i.rep_name = p_rep)
      AND (p_reps IS NULL OR i.rep_name = ANY(p_reps))
      AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (i.rep_name IS NULL OR p_reps IS NOT NULL OR i.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    GROUP BY EXTRACT(month FROM i.invoice_date)::int, i.department
  ),
  all_combos AS (
    SELECT o_month AS m, o_dept AS d FROM obj
    UNION SELECT i_month AS m, i_dept AS d FROM inv_agg
  )
  SELECT ac.m::int, ac.d, COALESCE(o.o_total,0), COALESCE(ia.i_total,0),
    CASE WHEN COALESCE(o.o_total,0) > 0
         THEN ROUND((COALESCE(ia.i_total,0)/o.o_total)*100,2) ELSE 0::numeric END,
    COALESCE(ia.i_count,0)
  FROM all_combos ac
  LEFT JOIN obj     o  ON o.o_month=ac.m AND o.o_dept=ac.d
  LEFT JOIN inv_agg ia ON ia.i_month=ac.m AND ia.i_dept=ac.d
  ORDER BY ac.m, ac.d;
END;
$$;


ALTER FUNCTION "public"."get_inv_sommaire"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_inv_sommaire_grand_total"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("month" integer, "objectif" numeric, "actual_amount" numeric, "pct_atteint" numeric, "deal_count" bigint)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o_month, SUM(o_target)::numeric AS o_total
    FROM (
      SELECT ro.month AS o_month, ro.target_amount AS o_target FROM rep_objectives ro
      WHERE p_office IS NULL
        AND p_rep IS NOT NULL AND ro.rep_name=p_rep AND ro.module='factures' AND ro.year=p_year
      UNION ALL
      SELECT of2.month AS o_month, of2.target_amount AS o_target FROM objectives_factures of2
      WHERE p_office IS NULL
        AND p_rep IS NULL AND of2.year=p_year
    ) combined GROUP BY o_month
  ),
  inv_agg AS (
    SELECT EXTRACT(month FROM i.invoice_date)::int AS i_month,
      COALESCE(SUM(i.amount),0)::numeric AS i_total, COUNT(*)::bigint AS i_count
    FROM invoices i
    WHERE EXTRACT(year FROM i.invoice_date)::int = p_year
      AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
                ELSE i.status::text = p_status END)
      AND (p_office IS NULL OR i.office::text = p_office)
      AND (p_rep    IS NULL OR i.rep_name = p_rep)
      AND (p_reps IS NULL OR i.rep_name = ANY(p_reps))
      AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (i.rep_name IS NULL OR p_reps IS NOT NULL OR i.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    GROUP BY EXTRACT(month FROM i.invoice_date)::int
  ),
  all_months AS (SELECT o_month AS m FROM obj UNION SELECT i_month AS m FROM inv_agg)
  SELECT am.m::int, COALESCE(o.o_total,0), COALESCE(ia.i_total,0),
    CASE WHEN COALESCE(o.o_total,0) > 0
         THEN ROUND((COALESCE(ia.i_total,0)/o.o_total)*100,2) ELSE 0::numeric END,
    COALESCE(ia.i_count,0)
  FROM all_months am
  LEFT JOIN obj     o  ON o.o_month  = am.m
  LEFT JOIN inv_agg ia ON ia.i_month = am.m
  ORDER BY am.m;
END;
$$;


ALTER FUNCTION "public"."get_inv_sommaire_grand_total"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_inv_top_clients"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 10, "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("client_name" "text", "total_amount" numeric, "deal_count" bigint, "office" "text")
    LANGUAGE "sql"
    AS $$
  SELECT i.client_name,
    SUM(i.amount)::numeric                          AS total_amount,
    COUNT(*) FILTER (WHERE NOT i.is_avoir)::bigint  AS deal_count,
    COALESCE(MAX(i.office::text), p_office)
  FROM invoices i
  WHERE EXTRACT(year FROM i.invoice_date)::int = p_year
    AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
              ELSE i.status::text = p_status END)
    AND (p_office IS NULL OR i.office::text = p_office)
    AND (p_month  IS NULL OR EXTRACT(month FROM i.invoice_date)::int = p_month)
    AND (p_dept   IS NULL OR i.department::text = p_dept)
    AND (p_rep    IS NULL OR i.rep_name = p_rep)
      AND (p_reps IS NULL OR i.rep_name = ANY(p_reps))
    AND i.client_name IS NOT NULL
    AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (i.rep_name IS NULL OR p_reps IS NOT NULL OR i.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  GROUP BY i.client_name HAVING SUM(i.amount) > 0
  ORDER BY 2 DESC LIMIT p_limit;
$$;


ALTER FUNCTION "public"."get_inv_top_clients"("p_year" integer, "p_office" "text", "p_status" "text", "p_limit" integer, "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_inv_weekly_detail"("p_week_start" "date", "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text") RETURNS TABLE("invoice_date" "text", "client_name" "text", "amount" numeric, "invoice_number" "text", "rep_name" "text", "department" "text", "zoho_department_label" "text", "office" "text", "status" "text", "is_avoir" boolean, "zoho_id" "text")
    LANGUAGE "sql"
    AS $$
  SELECT i.invoice_date::text, i.client_name, i.amount::numeric, i.invoice_number,
    i.rep_name, i.department, i.zoho_department_label, i.office::text, i.status::text, i.is_avoir, i.zoho_id
  FROM invoices i
  WHERE i.invoice_date >= p_week_start
    AND i.invoice_date < p_week_start + 7
    AND (p_office IS NULL OR i.office::text = p_office)
    AND (p_rep    IS NULL OR i.rep_name = p_rep)
    AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (i.rep_name IS NULL OR i.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
              ELSE i.status::text = p_status END)
  ORDER BY i.invoice_date DESC;
$$;


ALTER FUNCTION "public"."get_inv_weekly_detail"("p_week_start" "date", "p_office" "text", "p_status" "text", "p_rep" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_invoice_linkage_status"() RETURNS TABLE("customers_total" integer, "customers_pending" integer, "customers_linked" integer, "customers_unlinked" integer, "customers_error" integer, "invoices_total" integer, "invoices_with_account" integer)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT
    (SELECT count(*)::INTEGER FROM zoho_books_customers),
    (SELECT count(*)::INTEGER FROM zoho_books_customers WHERE link_status = 'pending'),
    (SELECT count(*)::INTEGER FROM zoho_books_customers WHERE link_status = 'linked'),
    (SELECT count(*)::INTEGER FROM zoho_books_customers WHERE link_status = 'unlinked'),
    (SELECT count(*)::INTEGER FROM zoho_books_customers WHERE link_status = 'error'),
    (SELECT count(*)::INTEGER FROM invoices),
    (SELECT count(*)::INTEGER FROM invoices WHERE crm_account_id IS NOT NULL);
$$;


ALTER FUNCTION "public"."get_invoice_linkage_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_invoice_unassigned_summary"("p_year" integer DEFAULT NULL::integer, "p_office" "text" DEFAULT NULL::"text", "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("unassigned_count" bigint, "unassigned_amount" numeric, "internal_count" bigint, "internal_amount" numeric, "assigned_amount" numeric, "total_count" bigint, "total_amount" numeric, "unassigned_share" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  WITH scoped AS (
    SELECT i.amount, i.crm_account_id, invoice_is_internal(i.client_name) AS internal
      FROM invoices i
     WHERE (p_year   IS NULL OR EXTRACT(YEAR  FROM i.invoice_date)::INT = p_year)
       AND (p_month  IS NULL OR EXTRACT(MONTH FROM i.invoice_date)::INT = p_month)
       AND (p_office IS NULL OR i.office     = p_office)
       AND (p_dept   IS NULL OR i.department = p_dept)
       AND (p_rep    IS NULL OR i.rep_name   = p_rep)
      AND (p_reps IS NULL OR i.rep_name = ANY(p_reps))
  ), agg AS (
    SELECT
      count(*) FILTER (WHERE crm_account_id IS NULL AND NOT internal)        AS un_n,
      COALESCE(sum(amount) FILTER (WHERE crm_account_id IS NULL AND NOT internal), 0) AS un_amt,
      count(*) FILTER (WHERE internal)                                      AS int_n,
      COALESCE(sum(amount) FILTER (WHERE internal), 0)                      AS int_amt,
      COALESCE(sum(amount) FILTER (WHERE crm_account_id IS NOT NULL AND NOT internal), 0) AS as_amt,
      count(*)                                                              AS all_n,
      COALESCE(sum(amount), 0)                                              AS all_amt
      FROM scoped
  )
  SELECT
    un_n, un_amt, int_n, int_amt, as_amt, all_n, all_amt,
    -- Share of non-internal billing that cannot be attributed. Guarded against a
    -- zero or negative denominator (a month of nothing but credit notes).
    CASE WHEN (un_amt + as_amt) <= 0 THEN 0
         ELSE ROUND(un_amt * 100.0 / (un_amt + as_amt), 1) END
  FROM agg;
$$;


ALTER FUNCTION "public"."get_invoice_unassigned_summary"("p_year" integer, "p_office" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_lead_invoice_totals"("p_account_ids" "text"[]) RETURNS TABLE("account_id" "text", "invoice_count" integer, "credit_count" integer, "total_amount" numeric, "last_invoice_date" "date")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT
    i.crm_account_id,
    count(*) FILTER (WHERE NOT i.is_avoir)::INTEGER,
    count(*) FILTER (WHERE i.is_avoir)::INTEGER,
    -- Avoirs are stored negative, so a plain sum is already the net figure.
    COALESCE(sum(i.amount), 0),
    max(i.invoice_date)
  FROM invoices i
  WHERE i.crm_account_id = ANY(p_account_ids)
  GROUP BY i.crm_account_id;
$$;


ALTER FUNCTION "public"."get_lead_invoice_totals"("p_account_ids" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_lead_invoices"("p_account_id" "text") RETURNS TABLE("zoho_id" "text", "invoice_number" "text", "client_name" "text", "amount" numeric, "invoice_date" "date", "status" "text", "is_avoir" boolean, "department" "text", "office" "text", "rep_name" "text", "books_customer_id" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT
    i.zoho_id, i.invoice_number, i.client_name, i.amount, i.invoice_date,
    i.status::TEXT, i.is_avoir, i.department, i.office, i.rep_name,
    i.books_customer_id
  FROM invoices i
  WHERE p_account_id IS NOT NULL
    AND i.crm_account_id = p_account_id
  ORDER BY i.invoice_date DESC NULLS LAST, i.invoice_number DESC;
$$;


ALTER FUNCTION "public"."get_lead_invoices"("p_account_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_leads_by_rep"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text") RETURNS TABLE("rep_name" "text", "nb_leads" bigint, "nb_won" bigint, "total_amount" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    rep_name,
    COUNT(*)                                            AS nb_leads,
    COUNT(*) FILTER (WHERE lead_status = 'won')         AS nb_won,
    COALESCE(SUM(amount_sold), 0)                       AS total_amount
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_month   IS NULL OR EXTRACT(MONTH FROM lead_date)::INT = p_month)
    AND (p_source  IS NULL OR source           = p_source)
    AND (p_service IS NULL OR service_interest = p_service)
  GROUP BY rep_name
  ORDER BY nb_leads DESC
$$;


ALTER FUNCTION "public"."get_leads_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_leads_by_service"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text") RETURNS TABLE("service_interest" "text", "nb_leads" bigint, "nb_won" bigint, "total_amount" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    COALESCE(service_interest, 'NON MENTIONNÉ') AS service_interest,
    COUNT(*)                                            AS nb_leads,
    COUNT(*) FILTER (WHERE lead_status = 'won')         AS nb_won,
    COALESCE(SUM(amount_sold), 0)                       AS total_amount
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_month   IS NULL OR EXTRACT(MONTH FROM lead_date)::INT = p_month)
    AND (p_rep     IS NULL OR rep_name = p_rep)
    AND (p_source  IS NULL OR source   = p_source)
  GROUP BY service_interest
  ORDER BY nb_leads DESC
$$;


ALTER FUNCTION "public"."get_leads_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_leads_by_source"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text") RETURNS TABLE("source" "text", "nb_leads" bigint, "nb_won" bigint, "total_amount" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    source,
    COUNT(*)                                            AS nb_leads,
    COUNT(*) FILTER (WHERE lead_status = 'won')         AS nb_won,
    COALESCE(SUM(amount_sold), 0)                       AS total_amount
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_month   IS NULL OR EXTRACT(MONTH FROM lead_date)::INT = p_month)
    AND (p_rep     IS NULL OR rep_name         = p_rep)
    AND (p_service IS NULL OR service_interest = p_service)
  GROUP BY source
  ORDER BY nb_leads DESC
$$;


ALTER FUNCTION "public"."get_leads_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_leads_detail"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 500) RETURNS TABLE("id" "uuid", "created_at" timestamp with time zone, "lead_date" "date", "rep_name" "text", "source" "text", "service_interest" "text", "amount_sold" numeric, "zoho_lead_id" "text", "zoho_contact_id" "text", "zoho_crm_url" "text", "notes" "text", "lead_status" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    id, created_at, lead_date, rep_name, source,
    service_interest, amount_sold, zoho_lead_id,
    zoho_contact_id, zoho_crm_url, notes, lead_status
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_month   IS NULL OR EXTRACT(MONTH FROM lead_date)::INT = p_month)
    AND (p_rep     IS NULL OR rep_name         = p_rep)
    AND (p_source  IS NULL OR source           = p_source)
    AND (p_service IS NULL OR service_interest = p_service)
  ORDER BY lead_date DESC
  LIMIT p_limit
$$;


ALTER FUNCTION "public"."get_leads_detail"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_leads_kpis"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text") RETURNS TABLE("total_leads" bigint, "won_leads" bigint, "conversion_rate" numeric, "total_amount" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    COUNT(*)                                              AS total_leads,
    COUNT(*) FILTER (WHERE lead_status = 'won')           AS won_leads,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE lead_status = 'won') * 100.0 / COUNT(*), 1)
    END                                                   AS conversion_rate,
    COALESCE(SUM(amount_sold), 0)                         AS total_amount
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_month   IS NULL OR EXTRACT(MONTH FROM lead_date)::INT = p_month)
    AND (p_rep     IS NULL OR rep_name         = p_rep)
    AND (p_source  IS NULL OR source           = p_source)
    AND (p_service IS NULL OR service_interest = p_service)
$$;


ALTER FUNCTION "public"."get_leads_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_leads_monthly_summary"("p_year" integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text") RETURNS TABLE("month" integer, "nb_leads" bigint, "nb_won" bigint, "total_amount" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    EXTRACT(MONTH FROM lead_date)::INT              AS month,
    COUNT(*)                                        AS nb_leads,
    COUNT(*) FILTER (WHERE lead_status = 'won')     AS nb_won,
    COALESCE(SUM(amount_sold), 0)                   AS total_amount
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_rep     IS NULL OR rep_name         = p_rep)
    AND (p_source  IS NULL OR source           = p_source)
    AND (p_service IS NULL OR service_interest = p_service)
  GROUP BY EXTRACT(MONTH FROM lead_date)::INT
  ORDER BY month
$$;


ALTER FUNCTION "public"."get_leads_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_permissions"() RETURNS json
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT COALESCE(
    (SELECT json_build_object(
        'role',                role,
        'can_access_factures', can_access_factures,
        'rep_name',            rep_name
      ) FROM allowed_users WHERE lower(email) = lower(auth.jwt() ->> 'email')
      LIMIT 1),
    json_build_object(
        'role',                'member',
        'can_access_factures', false,
        'rep_name',            null
    )
  );
$$;


ALTER FUNCTION "public"."get_my_permissions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_quarterly_yoy"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text") RETURNS TABLE("quarter" integer, "rep_name" "text", "office" "text", "current_avg" numeric, "previous_avg" numeric, "resultat" numeric, "deal_count" bigint)
    LANGUAGE "sql" STABLE
    AS $$
WITH fq_weeks AS (
  SELECT year, quarter, start_date, end_date, num_weeks,
    CASE WHEN end_date < CURRENT_DATE THEN num_weeks
         WHEN start_date > CURRENT_DATE THEN 1
         ELSE LEAST(num_weeks, CEIL((CURRENT_DATE - start_date + 1)::float / 7)::int)
    END AS weeks_completed
  FROM fiscal_quarters
),
current_year AS (
  SELECT fq.quarter, s.rep_name, COALESCE(p_office,'Tous')::text AS office,
    SUM(s.amount)::numeric / MAX(fq.weeks_completed) AS avg_deal, COUNT(*)::bigint AS deal_count
  FROM sales s
  JOIN fq_weeks fq ON s.sale_date::date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year
    AND s.status::text != 'declined'
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND s.rep_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND s.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
  GROUP BY fq.quarter, s.rep_name
),
previous_year AS (
  SELECT fq.quarter, s.rep_name,
    SUM(s.amount)::numeric / MAX(fq.weeks_completed) AS avg_deal
  FROM sales s
  JOIN fq_weeks fq ON s.sale_date::date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year - 1
    AND s.status::text != 'declined'
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND s.rep_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND s.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
  GROUP BY fq.quarter, s.rep_name
)
SELECT cy.quarter, cy.rep_name, cy.office,
  cy.avg_deal, COALESCE(py.avg_deal,0),
  cy.avg_deal - COALESCE(py.avg_deal,0), cy.deal_count
FROM current_year cy
LEFT JOIN previous_year py ON cy.quarter=py.quarter AND cy.rep_name=py.rep_name
ORDER BY cy.quarter, cy.rep_name;
$$;


ALTER FUNCTION "public"."get_quarterly_yoy"("p_year" integer, "p_office" "text", "p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_quarterly_yoy_totals"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text") RETURNS TABLE("quarter" integer, "current_total" numeric, "previous_total" numeric)
    LANGUAGE "sql" STABLE
    AS $$
WITH fq_weeks AS (
  SELECT year, quarter, start_date, end_date, num_weeks,
    CASE WHEN end_date < CURRENT_DATE THEN num_weeks
         WHEN start_date > CURRENT_DATE THEN 1
         ELSE LEAST(num_weeks, CEIL((CURRENT_DATE - start_date + 1)::float / 7)::int)
    END AS weeks_completed
  FROM fiscal_quarters
),
cur AS (
  SELECT fq.quarter, SUM(s.amount)::numeric / MAX(fq.weeks_completed) AS total
  FROM sales s
  JOIN fq_weeks fq ON s.sale_date::date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year
    AND s.status::text != 'declined'
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND s.rep_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND s.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
  GROUP BY fq.quarter
),
prev AS (
  SELECT fq.quarter, SUM(s.amount)::numeric / MAX(fq.weeks_completed) AS total
  FROM sales s
  JOIN fq_weeks fq ON s.sale_date::date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year - 1
    AND s.status::text != 'declined'
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND s.rep_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND s.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
  GROUP BY fq.quarter
)
SELECT q.quarter,
       COALESCE(cur.total, 0)::numeric  AS current_total,
       COALESCE(prev.total, 0)::numeric AS previous_total
FROM (SELECT DISTINCT quarter FROM fq_weeks) q
LEFT JOIN cur  ON cur.quarter  = q.quarter
LEFT JOIN prev ON prev.quarter = q.quarter
ORDER BY q.quarter;
$$;


ALTER FUNCTION "public"."get_quarterly_yoy_totals"("p_year" integer, "p_office" "text", "p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_quote_creator_link_status"() RETURNS TABLE("quotes_total" integer, "quotes_linked" integer, "quotes_pending" integer, "quotes_error" integer, "invoices_total" integer, "invoices_linked" integer, "distinct_creators" integer)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT
    (SELECT count(*)::INT FROM sales),
    (SELECT count(*)::INT FROM sales WHERE creator_link_status = 'linked'),
    (SELECT count(*)::INT FROM sales WHERE creator_link_status = 'pending'),
    (SELECT count(*)::INT FROM sales WHERE creator_link_status = 'error'),
    (SELECT count(*)::INT FROM invoices),
    (SELECT count(*)::INT FROM invoices WHERE created_by_name IS NOT NULL),
    (SELECT count(DISTINCT c)::INT FROM (
       SELECT created_by_name c FROM sales    WHERE created_by_name IS NOT NULL
       UNION
       SELECT created_by_name   FROM invoices WHERE created_by_name IS NOT NULL
     ) u);
$$;


ALTER FUNCTION "public"."get_quote_creator_link_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_rep_dept_actuals_devis"("p_rep" "text", "p_year" integer) RETURNS TABLE("month" integer, "department" "text", "actual_amount" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT s.month, s.department::text, SUM(s.amount) AS actual_amount
  FROM sales s
  WHERE s.rep_name = p_rep
    AND s.year = p_year
    AND s.department IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
  GROUP BY s.month, s.department::text;
$$;


ALTER FUNCTION "public"."get_rep_dept_actuals_devis"("p_rep" "text", "p_year" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_rep_dept_actuals_factures"("p_rep" "text", "p_year" integer) RETURNS TABLE("month" integer, "department" "text", "actual_amount" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT EXTRACT(MONTH FROM i.invoice_date)::int,
         -- Never dropped: a row with no department still moved money, and the
         -- total above these cards counts it.
         COALESCE(i.department, 'Non assigné'),
         SUM(i.amount)
    FROM invoices i
   WHERE i.rep_name = p_rep
     AND EXTRACT(YEAR FROM i.invoice_date) = p_year
     AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
     AND (i.rep_name IS NULL OR i.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
   GROUP BY 1, 2;
$$;


ALTER FUNCTION "public"."get_rep_dept_actuals_factures"("p_rep" "text", "p_year" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_rep_dept_actuals_factures"("p_rep" "text", "p_year" integer) IS 'Per-department billing for one rep. Net of credit notes, and returns rows with no department under "Non assigné", so the cards sum to the total shown above them. Both were true of the total already and neither was true here.';



CREATE OR REPLACE FUNCTION "public"."get_rep_leaderboard"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("rep_name" "text", "office" "text", "total_amount" numeric, "deal_count" bigint, "avg_deal" numeric, "rank" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  WITH base AS (
    SELECT s.rep_name, MAX(s.office::text) AS office,
      SUM(s.amount)::numeric AS total_amount, COUNT(*) AS deal_count, AVG(s.amount)::numeric AS avg_deal
    FROM sales s
    WHERE EXTRACT(year FROM s.sale_date::date) = p_year
      AND s.status::text != 'declined'
      AND (p_office IS NULL OR s.office::text = p_office)
      AND (p_status IS NULL OR s.status::text = p_status)
      AND (p_month  IS NULL OR EXTRACT(month FROM s.sale_date::date) = p_month)
      AND (p_dept   IS NULL OR s.department::text = p_dept)
      AND (p_rep    IS NULL OR s.rep_name = p_rep)
      AND (p_reps   IS NULL OR s.rep_name = ANY(p_reps))
      AND s.rep_name IS NOT NULL
      AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (p_reps IS NOT NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    GROUP BY s.rep_name
  )
  SELECT base.rep_name, base.office, base.total_amount, base.deal_count, base.avg_deal,
    ROW_NUMBER() OVER (ORDER BY base.total_amount DESC)
  FROM base ORDER BY base.total_amount DESC;
$$;


ALTER FUNCTION "public"."get_rep_leaderboard"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_sales_team"() RETURNS SETOF "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT DISTINCT au.rep_name
    FROM public.allowed_users au
   WHERE au.rep_name IS NOT NULL
     AND btrim(au.rep_name) <> ''
   ORDER BY 1;
$$;


ALTER FUNCTION "public"."get_sales_team"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_sommaire"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("month" integer, "department" "public"."department_enum", "objectif" numeric, "actual_amount" numeric, "pct_atteint" numeric, "deal_count" bigint)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o.month AS o_month, o.department AS o_dept, o.target_amount AS o_total
    FROM objectives o
    WHERE o.year = p_year
      AND p_rep IS NULL AND p_reps IS NULL
      AND p_office IS NULL
  ),
  sales_agg AS (
    SELECT s.month AS s_month, s.department AS s_dept,
      COALESCE(SUM(s.amount), 0) AS s_total, COUNT(*)::bigint AS s_count
    FROM sales s
    WHERE s.year = p_year
      AND s.status::text != 'declined'
      AND (p_office IS NULL OR s.office::text = p_office)
      AND (p_status IS NULL OR s.status::text = p_status)
      AND (p_rep    IS NULL OR s.rep_name = p_rep)
      AND (p_reps   IS NULL OR s.rep_name = ANY(p_reps))
      AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (s.rep_name IS NULL OR p_reps IS NOT NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    GROUP BY s.month, s.department
  ),
  all_combos AS (
    SELECT o_month AS m, o_dept AS d FROM obj
    UNION SELECT s_month AS m, s_dept AS d FROM sales_agg
  )
  SELECT ac.m::int, ac.d,
    COALESCE(o.o_total,0), COALESCE(sa.s_total,0),
    CASE WHEN COALESCE(o.o_total,0) > 0
         THEN ROUND((COALESCE(sa.s_total,0)/o.o_total)*100,2) ELSE 0::numeric END,
    COALESCE(sa.s_count,0)
  FROM all_combos ac
  LEFT JOIN obj       o  ON o.o_month=ac.m AND o.o_dept=ac.d
  LEFT JOIN sales_agg sa ON sa.s_month=ac.m AND sa.s_dept=ac.d
  ORDER BY ac.m, ac.d;
END;
$$;


ALTER FUNCTION "public"."get_sommaire"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_sommaire_grand_total"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("month" integer, "objectif" numeric, "actual_amount" numeric, "pct_atteint" numeric, "deal_count" bigint)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o_month, SUM(o_target) AS o_total
    FROM (
      SELECT ro.month AS o_month, ro.target_amount AS o_target FROM rep_objectives ro
      WHERE p_office IS NULL
        AND p_rep IS NOT NULL AND ro.rep_name = p_rep AND ro.module = 'devis' AND ro.year = p_year
      UNION ALL
      SELECT od.month AS o_month, od.target_amount AS o_target FROM objectives od
      WHERE p_office IS NULL
        AND p_rep IS NULL AND od.year = p_year
    ) combined GROUP BY o_month
  ),
  sales_agg AS (
    SELECT s.month AS s_month,
      COALESCE(SUM(s.amount), 0) AS s_total, COUNT(*)::bigint AS s_count
    FROM sales s
    WHERE s.year = p_year
      AND s.status::text != 'declined'
      AND (p_office IS NULL OR s.office::text = p_office)
      AND (p_status IS NULL OR s.status::text = p_status)
      AND (p_rep    IS NULL OR s.rep_name = p_rep)
      AND (p_reps   IS NULL OR s.rep_name = ANY(p_reps))
      AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (s.rep_name IS NULL OR p_reps IS NOT NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    GROUP BY s.month
  ),
  all_months AS (SELECT o_month AS m FROM obj UNION SELECT s_month AS m FROM sales_agg)
  SELECT am.m::int, COALESCE(o.o_total,0), COALESCE(sa.s_total,0),
    CASE WHEN COALESCE(o.o_total,0) > 0
         THEN ROUND((COALESCE(sa.s_total,0)/o.o_total)*100,2) ELSE 0::numeric END,
    COALESCE(sa.s_count,0)
  FROM all_months am
  LEFT JOIN obj       o  ON o.o_month  = am.m
  LEFT JOIN sales_agg sa ON sa.s_month = am.m
  ORDER BY am.m;
END;
$$;


ALTER FUNCTION "public"."get_sommaire_grand_total"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tasks_available_weeks"("p_year" integer) RETURNS TABLE("week_start" "date", "week_end" "date", "nb_created" bigint, "nb_completed" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  WITH b AS (
    SELECT date_trunc('week', make_date(p_year,     1, 4))::timestamptz AS lo,
           date_trunc('week', make_date(p_year + 1, 1, 4))::timestamptz AS hi
  ),
  visible AS (SELECT tasks_visible_reps() AS rep_name),
  ev AS (
    SELECT date_trunc('week', t.created_time)::date AS wk, 'c'::text AS kind
    FROM zoho_tasks t, b
    WHERE t.rep_name IN (SELECT rep_name FROM visible)
      AND t.created_time >= b.lo AND t.created_time < b.hi
    UNION ALL
    SELECT date_trunc('week', t.closed_time)::date, 'd'
    FROM zoho_tasks t, b
    WHERE t.rep_name IN (SELECT rep_name FROM visible)
      AND t.closed_time IS NOT NULL
      AND t.closed_time >= b.lo AND t.closed_time < b.hi
  )
  SELECT wk AS week_start, (wk + 6) AS week_end,
    COUNT(*) FILTER (WHERE kind = 'c') AS nb_created,
    COUNT(*) FILTER (WHERE kind = 'd') AS nb_completed
  FROM ev GROUP BY wk ORDER BY wk DESC
$$;


ALTER FUNCTION "public"."get_tasks_available_weeks"("p_year" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tasks_by_rep"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_week_start" "date" DEFAULT NULL::"date") RETURNS TABLE("rep_name" "text", "nb_created" bigint, "nb_completed" bigint, "nb_touched" bigint, "completion_rate" numeric, "avg_days_to_close" numeric, "nb_open" bigint, "nb_overdue" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT rep_name,
    COUNT(*) FILTER (WHERE in_created)   AS nb_created,
    COUNT(*) FILTER (WHERE in_completed) AS nb_completed,
    COUNT(*) FILTER (WHERE in_touched)   AS nb_touched,
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_completed) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS completion_rate,
    ROUND(AVG(EXTRACT(EPOCH FROM (closed_time - created_time)) / 86400.0)
          FILTER (WHERE in_completed), 1) AS avg_days_to_close,
    COUNT(*) FILTER (WHERE closed_time IS NULL) AS nb_open,
    COUNT(*) FILTER (WHERE closed_time IS NULL AND due_date IS NOT NULL AND due_date < CURRENT_DATE) AS nb_overdue
  FROM (
    SELECT rep_name, created_time, closed_time, due_date,
      (CASE WHEN p_week_start IS NOT NULL
            THEN created_time >= p_week_start::timestamptz AND created_time < (p_week_start + 7)::timestamptz
            ELSE EXTRACT(YEAR FROM created_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM created_time)::INT = p_month) END) AS in_created,
      (CASE WHEN p_week_start IS NOT NULL
            THEN closed_time IS NOT NULL AND closed_time >= p_week_start::timestamptz AND closed_time < (p_week_start + 7)::timestamptz
            ELSE closed_time IS NOT NULL AND EXTRACT(YEAR FROM closed_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM closed_time)::INT = p_month) END) AS in_completed,
      (CASE WHEN p_week_start IS NOT NULL
            THEN modified_time >= p_week_start::timestamptz AND modified_time < (p_week_start + 7)::timestamptz
            ELSE EXTRACT(YEAR FROM modified_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM modified_time)::INT = p_month) END) AS in_touched
    FROM zoho_tasks
    WHERE rep_name IN (SELECT tasks_visible_reps())
  ) t
  GROUP BY rep_name
  HAVING COUNT(*) FILTER (WHERE in_created) > 0
      OR COUNT(*) FILTER (WHERE in_touched) > 0
      OR COUNT(*) FILTER (WHERE closed_time IS NULL) > 0
  ORDER BY nb_completed DESC, nb_created DESC
$$;


ALTER FUNCTION "public"."get_tasks_by_rep"("p_year" integer, "p_month" integer, "p_week_start" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tasks_by_status"("p_rep" "text" DEFAULT NULL::"text") RETURNS TABLE("status" "text", "nb" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT COALESCE(status, 'Non défini') AS status, COUNT(*) AS nb
  FROM zoho_tasks
  WHERE closed_time IS NULL AND rep_name IN (SELECT tasks_visible_reps())
    AND (p_rep IS NULL OR rep_name = p_rep)
  GROUP BY COALESCE(status, 'Non défini')
  ORDER BY nb DESC
$$;


ALTER FUNCTION "public"."get_tasks_by_status"("p_rep" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tasks_kpis"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_week_start" "date" DEFAULT NULL::"date") RETURNS TABLE("total_created" bigint, "total_completed" bigint, "completion_rate" numeric, "total_touched" bigint, "total_open" bigint, "total_overdue" bigint, "active_reps" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    COUNT(*) FILTER (WHERE in_created)   AS total_created,
    COUNT(*) FILTER (WHERE in_completed) AS total_completed,
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_completed) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS completion_rate,
    COUNT(*) FILTER (WHERE in_touched)   AS total_touched,
    COUNT(*) FILTER (WHERE closed_time IS NULL) AS total_open,
    COUNT(*) FILTER (WHERE closed_time IS NULL AND due_date IS NOT NULL AND due_date < CURRENT_DATE) AS total_overdue,
    COUNT(DISTINCT rep_name) FILTER (WHERE in_created OR in_touched) AS active_reps
  FROM (
    SELECT rep_name, closed_time, due_date,
      (CASE WHEN p_week_start IS NOT NULL
            THEN created_time >= p_week_start::timestamptz AND created_time < (p_week_start + 7)::timestamptz
            ELSE EXTRACT(YEAR FROM created_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM created_time)::INT = p_month) END) AS in_created,
      (CASE WHEN p_week_start IS NOT NULL
            THEN closed_time IS NOT NULL AND closed_time >= p_week_start::timestamptz AND closed_time < (p_week_start + 7)::timestamptz
            ELSE closed_time IS NOT NULL AND EXTRACT(YEAR FROM closed_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM closed_time)::INT = p_month) END) AS in_completed,
      (CASE WHEN p_week_start IS NOT NULL
            THEN modified_time >= p_week_start::timestamptz AND modified_time < (p_week_start + 7)::timestamptz
            ELSE EXTRACT(YEAR FROM modified_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM modified_time)::INT = p_month) END) AS in_touched
    FROM zoho_tasks
    WHERE rep_name IN (SELECT tasks_visible_reps()) AND (p_rep IS NULL OR rep_name = p_rep)
  ) t
$$;


ALTER FUNCTION "public"."get_tasks_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_week_start" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tasks_weekly"("p_year" integer, "p_rep" "text" DEFAULT NULL::"text") RETURNS TABLE("week_start" "date", "nb_created" bigint, "nb_completed" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  WITH b AS (
    SELECT date_trunc('week', make_date(p_year,     1, 4))::timestamptz AS lo,
           date_trunc('week', make_date(p_year + 1, 1, 4))::timestamptz AS hi
  ),
  visible AS (SELECT tasks_visible_reps() AS rep_name),
  c AS (
    SELECT date_trunc('week', t.created_time)::date AS ws, COUNT(*) AS nb
    FROM zoho_tasks t, b
    WHERE t.rep_name IN (SELECT rep_name FROM visible)
      AND t.created_time >= b.lo AND t.created_time < b.hi
      AND (p_rep IS NULL OR t.rep_name = p_rep)
    GROUP BY 1
  ),
  d AS (
    SELECT date_trunc('week', t.closed_time)::date AS ws, COUNT(*) AS nb
    FROM zoho_tasks t, b
    WHERE t.rep_name IN (SELECT rep_name FROM visible)
      AND t.closed_time IS NOT NULL
      AND t.closed_time >= b.lo AND t.closed_time < b.hi
      AND (p_rep IS NULL OR t.rep_name = p_rep)
    GROUP BY 1
  )
  SELECT COALESCE(c.ws, d.ws) AS week_start,
         COALESCE(c.nb, 0)    AS nb_created,
         COALESCE(d.nb, 0)    AS nb_completed
  FROM c FULL OUTER JOIN d ON c.ws = d.ws
  ORDER BY week_start
$$;


ALTER FUNCTION "public"."get_tasks_weekly"("p_year" integer, "p_rep" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tasks_wow"("p_rep" "text" DEFAULT NULL::"text") RETURNS TABLE("rep_name" "text", "created_this_week" bigint, "created_last_week" bigint, "completed_this_week" bigint, "completed_last_week" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT t.rep_name,
    COUNT(*) FILTER (WHERE t.created_time >= b.this_monday) AS created_this_week,
    COUNT(*) FILTER (WHERE t.created_time >= b.last_monday AND t.created_time < b.this_monday) AS created_last_week,
    COUNT(*) FILTER (WHERE t.closed_time IS NOT NULL AND t.closed_time >= b.this_monday) AS completed_this_week,
    COUNT(*) FILTER (WHERE t.closed_time IS NOT NULL AND t.closed_time >= b.last_monday AND t.closed_time < b.this_monday) AS completed_last_week
  FROM zoho_tasks t
  CROSS JOIN (
    SELECT date_trunc('week', CURRENT_DATE) AS this_monday,
           date_trunc('week', CURRENT_DATE) - INTERVAL '7 days' AS last_monday
  ) b
  WHERE t.rep_name IN (SELECT tasks_visible_reps())
    AND (p_rep IS NULL OR t.rep_name = p_rep)
    AND (t.created_time >= b.last_monday
         OR (t.closed_time IS NOT NULL AND t.closed_time >= b.last_monday))
  GROUP BY t.rep_name, b.this_monday, b.last_monday
  HAVING COUNT(*) FILTER (WHERE t.created_time >= b.last_monday
                            OR (t.closed_time IS NOT NULL AND t.closed_time >= b.last_monday)) > 0
  ORDER BY completed_this_week DESC, created_this_week DESC
$$;


ALTER FUNCTION "public"."get_tasks_wow"("p_rep" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_top_clients"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 10, "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("client_name" "text", "total_amount" numeric, "deal_count" bigint, "office" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT s.client_name, SUM(s.amount)::numeric, COUNT(*), COALESCE(MAX(s.office::text), p_office)
  FROM sales s
  WHERE EXTRACT(year FROM sale_date::date) = p_year
    AND s.status::text != 'declined'
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND (p_month  IS NULL OR EXTRACT(month FROM sale_date::date) = p_month)
    AND (p_dept   IS NULL OR s.department::text = p_dept)
    AND (p_rep    IS NULL OR s.rep_name = p_rep)
    AND (p_reps   IS NULL OR s.rep_name = ANY(p_reps))
    AND s.client_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (s.rep_name IS NULL OR p_reps IS NOT NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  GROUP BY s.client_name ORDER BY 2 DESC LIMIT p_limit;
$$;


ALTER FUNCTION "public"."get_top_clients"("p_year" integer, "p_office" "text", "p_status" "text", "p_limit" integer, "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_unassigned_invoices"("p_year" integer DEFAULT NULL::integer, "p_office" "text" DEFAULT NULL::"text", "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 500) RETURNS TABLE("zoho_id" "text", "invoice_number" "text", "client_name" "text", "amount" numeric, "invoice_date" "date", "status" "text", "is_avoir" boolean, "department" "text", "office" "text", "rep_name" "text", "reason" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT
    i.zoho_id, i.invoice_number, i.client_name, i.amount, i.invoice_date,
    i.status::TEXT, i.is_avoir, i.department, i.office, i.rep_name,
    CASE
      WHEN i.books_customer_id IS NULL THEN 'Aucun client Zoho Books'
      WHEN c.books_customer_id IS NULL THEN 'Client pas encore analysé'
      WHEN c.link_status = 'unlinked'  THEN 'Client sans compte CRM'
      WHEN c.link_status = 'error'     THEN 'Erreur de liaison'
      ELSE 'En attente de liaison'
    END
  FROM invoices i
  LEFT JOIN zoho_books_customers c ON c.books_customer_id = i.books_customer_id
  WHERE i.crm_account_id IS NULL
    AND NOT invoice_is_internal(i.client_name)
    AND (p_year   IS NULL OR EXTRACT(YEAR  FROM i.invoice_date)::INT = p_year)
    AND (p_month  IS NULL OR EXTRACT(MONTH FROM i.invoice_date)::INT = p_month)
    AND (p_office IS NULL OR i.office     = p_office)
    AND (p_dept   IS NULL OR i.department = p_dept)
    AND (p_rep    IS NULL OR i.rep_name   = p_rep)
  ORDER BY abs(i.amount) DESC, i.invoice_date DESC
  LIMIT p_limit;
$$;


ALTER FUNCTION "public"."get_unassigned_invoices"("p_year" integer, "p_office" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_unmapped_department_summary"() RETURNS TABLE("module" "text", "zoho_label" "text", "record_count" bigint, "total_amount" numeric, "first_seen" "date", "last_seen" "date")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT 'devis', COALESCE(s.zoho_department_label, '(vide)'),
         count(*), COALESCE(sum(s.amount), 0), min(s.sale_date), max(s.sale_date)
    FROM sales s
   WHERE s.department IS NULL
   GROUP BY 2
  UNION ALL
  SELECT 'factures', COALESCE(v.zoho_department_label, '(vide)'),
         count(*), COALESCE(sum(v.amount), 0), min(v.invoice_date), max(v.invoice_date)
    FROM invoices v
   WHERE v.department IS NULL
   GROUP BY 2
  ORDER BY 3 DESC;
$$;


ALTER FUNCTION "public"."get_unmapped_department_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_weekly_detail"("p_week_start" "date", "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text") RETURNS TABLE("sale_date" "text", "client_name" "text", "amount" numeric, "quote_number" "text", "rep_name" "text", "department" "text", "zoho_department_label" "text", "office" "text", "status" "text", "zoho_id" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT s.sale_date::text, s.client_name, s.amount::numeric, s.quote_number,
    s.rep_name, s.department, s.zoho_department_label, s.office::text, s.status::text, s.zoho_id
  FROM sales s
  WHERE s.sale_date::date >= p_week_start
    AND s.sale_date::date < p_week_start + 7
    AND (p_office IS NULL OR s.office::text = p_office)
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (s.rep_name IS NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    AND (CASE WHEN p_status IS NULL THEN s.status::text != 'declined'
              ELSE s.status::text = p_status END)
  ORDER BY s.sale_date DESC;
$$;


ALTER FUNCTION "public"."get_weekly_detail"("p_week_start" "date", "p_office" "text", "p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_weekly_mandates"("p_week_start" "date") RETURNS TABLE("client_name" "text", "departments" "text"[], "nb_quotes" bigint, "total_amount" numeric, "is_new" boolean)
    LANGUAGE "sql" STABLE
    AS $$
  WITH won AS (
    SELECT s.client_name, s.department, s.amount
    FROM sales s
    WHERE s.week_start = p_week_start
      AND s.status::text <> 'declined'
      AND s.client_name IS NOT NULL
      AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND s.rep_name    NOT IN (SELECT rep_name    FROM excluded_reps)
  ),
  agg AS (
    SELECT w.client_name,
           array_agg(DISTINCT w.department::text ORDER BY w.department::text) AS departments,
           COUNT(*)::bigint AS nb_quotes,
           SUM(w.amount)::numeric AS total_amount
    FROM won w
    GROUP BY w.client_name
  )
  SELECT a.client_name, a.departments, a.nb_quotes, a.total_amount,
         NOT EXISTS (
           SELECT 1 FROM sales s2
           WHERE s2.client_name = a.client_name
             AND s2.status::text <> 'declined'
             AND s2.sale_date < p_week_start
         ) AS is_new
  FROM agg a
  ORDER BY a.total_amount DESC NULLS LAST, a.client_name;
$$;


ALTER FUNCTION "public"."get_weekly_mandates"("p_week_start" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_weekly_trend"("p_year" integer, "p_office" "public"."office_enum" DEFAULT NULL::"public"."office_enum", "p_status" "public"."sale_status_enum" DEFAULT NULL::"public"."sale_status_enum", "p_weeks" integer DEFAULT 12) RETURNS TABLE("week_start" "date", "total_amount" numeric, "deal_count" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT s.week_start, SUM(s.amount) AS total_amount, COUNT(*) AS deal_count
  FROM sales s
  WHERE s.year = p_year
    AND s.status::text != 'declined'
    AND (p_office IS NULL OR s.office = p_office)
    AND (p_status IS NULL OR s.status = p_status)
  GROUP BY s.week_start
  ORDER BY s.week_start DESC
  LIMIT p_weeks;
END;
$$;


ALTER FUNCTION "public"."get_weekly_trend"("p_year" integer, "p_office" "public"."office_enum", "p_status" "public"."sale_status_enum", "p_weeks" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_account_filter_options"("p_year" integer DEFAULT NULL::integer, "p_exclude_ratings" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("years" integer[], "sources" "text"[], "services" "text"[], "service_variants" "jsonb", "reps" "text"[], "domaines" "text"[], "regions" "text"[], "ratings" "text"[])
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."get_zoho_account_filter_options"("p_year" integer, "p_exclude_ratings" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_account_kpis"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text", "p_domaine" "text" DEFAULT NULL::"text", "p_region" "text" DEFAULT NULL::"text", "p_window_months" integer DEFAULT 12, "p_exclude_ratings" "text"[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::"text", 'Fournisseur'::"text"], "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("accounts_created" bigint, "accounts_invoiced" bigint, "invoiced_rate" numeric, "revenue_attributed" numeric, "revenue_lifetime" numeric, "revenue_per_account" numeric, "avg_days_to_first_invoice" numeric, "ventes_royer" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_zoho_account_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_accounts_by_domaine"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text", "p_region" "text" DEFAULT NULL::"text", "p_window_months" integer DEFAULT 12, "p_exclude_ratings" "text"[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::"text", 'Fournisseur'::"text"], "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("label" "text", "nb_accounts" bigint, "nb_invoiced" bigint, "total_amount" numeric, "revenue_per_account" numeric, "is_bulk_import" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_zoho_accounts_by_domaine"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_accounts_by_rep"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text", "p_domaine" "text" DEFAULT NULL::"text", "p_region" "text" DEFAULT NULL::"text", "p_window_months" integer DEFAULT 12, "p_exclude_ratings" "text"[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::"text", 'Fournisseur'::"text"], "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("label" "text", "nb_accounts" bigint, "nb_invoiced" bigint, "total_amount" numeric, "revenue_per_account" numeric, "is_bulk_import" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_zoho_accounts_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_accounts_by_service"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_domaine" "text" DEFAULT NULL::"text", "p_region" "text" DEFAULT NULL::"text", "p_window_months" integer DEFAULT 12, "p_exclude_ratings" "text"[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::"text", 'Fournisseur'::"text"], "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("label" "text", "nb_accounts" bigint, "nb_invoiced" bigint, "total_amount" numeric, "revenue_per_account" numeric, "is_bulk_import" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_zoho_accounts_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_accounts_by_source"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text", "p_domaine" "text" DEFAULT NULL::"text", "p_region" "text" DEFAULT NULL::"text", "p_window_months" integer DEFAULT 12, "p_exclude_ratings" "text"[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::"text", 'Fournisseur'::"text"], "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("label" "text", "nb_accounts" bigint, "nb_invoiced" bigint, "total_amount" numeric, "revenue_per_account" numeric, "is_bulk_import" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_zoho_accounts_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_accounts_monthly_summary"("p_year" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text", "p_domaine" "text" DEFAULT NULL::"text", "p_region" "text" DEFAULT NULL::"text", "p_window_months" integer DEFAULT 12, "p_exclude_ratings" "text"[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::"text", 'Fournisseur'::"text"], "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("month" integer, "nb_accounts" bigint, "nb_invoiced" bigint, "total_amount" numeric, "revenue_per_account" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_zoho_accounts_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_lead_filter_options"("p_year" integer DEFAULT NULL::integer, "p_stage" "text" DEFAULT NULL::"text") RETURNS TABLE("sources" "text"[], "services" "text"[], "reps" "text"[], "service_variants" "jsonb")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  WITH scoped AS (
    SELECT source_resolved AS lead_source,
           service_resolved AS service_interest,
           rep_name
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


ALTER FUNCTION "public"."get_zoho_lead_filter_options"("p_year" integer, "p_stage" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_lead_kpis"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text") RETURNS TABLE("leads_received" bigint, "leads_converted" bigint, "leads_invoiced" bigint, "conversion_rate" numeric, "invoiced_rate" numeric, "revenue_attributed" numeric, "revenue_lifetime" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."get_zoho_lead_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_leads_by_rep"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text") RETURNS TABLE("label" "text", "nb_leads" bigint, "nb_converted" bigint, "nb_invoiced" bigint, "total_amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."get_zoho_leads_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_leads_by_service"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text") RETURNS TABLE("label" "text", "nb_leads" bigint, "nb_converted" bigint, "nb_invoiced" bigint, "total_amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."get_zoho_leads_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_leads_by_source"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text") RETURNS TABLE("label" "text", "nb_leads" bigint, "nb_converted" bigint, "nb_invoiced" bigint, "total_amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."get_zoho_leads_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_zoho_leads_monthly_summary"("p_year" integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text") RETURNS TABLE("month" bigint, "nb_leads" bigint, "nb_converted" bigint, "nb_invoiced" bigint, "total_amount" numeric)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."get_zoho_leads_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invoice_is_internal"("p_client_name" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(p_client_name, '') ILIKE '%affichez%';
$$;


ALTER FUNCTION "public"."invoice_is_internal"("p_client_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invoices_fill_crm_account"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- A miss leaves both NULL, which is the right answer: the customer is not yet
  -- resolved, or has no CRM account. The resolver fills it in later via trigger 2.
  SELECT c.crm_account_id, c.crm_contact_id
    INTO NEW.crm_account_id, NEW.crm_contact_id
    FROM zoho_books_customers c
   WHERE c.books_customer_id = NEW.books_customer_id
     AND c.link_status = 'linked';
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."invoices_fill_crm_account"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."preserve_first_sale_date"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF OLD.sale_date IS NOT NULL THEN
    NEW.sale_date := OLD.sale_date;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."preserve_first_sale_date"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_zoho_service_labels"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.zoho_service_labels;
END;
$$;


ALTER FUNCTION "public"."refresh_zoho_service_labels"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_clients"("p_query" "text", "p_limit" integer DEFAULT 20) RETURNS TABLE("client_name" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT DISTINCT t.client_name
  FROM (
    SELECT s.client_name FROM sales s WHERE s.client_name ILIKE '%' || p_query || '%' AND s.client_name IS NOT NULL
    UNION ALL
    SELECT i.client_name FROM invoices i WHERE i.client_name ILIKE '%' || p_query || '%' AND i.client_name IS NOT NULL
  ) t
  WHERE t.client_name NOT IN (SELECT ec.client_name FROM excluded_clients ec)
  ORDER BY 1
  LIMIT p_limit;
$$;


ALTER FUNCTION "public"."search_clients"("p_query" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_allowed_users_to_auth"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  new_meta jsonb;
BEGIN
  new_meta := jsonb_build_object(
    'role',                COALESCE(NEW.role, 'member'),
    'can_access_factures', COALESCE(NEW.can_access_factures, false),
    'rep_name',            NEW.rep_name
  );

  UPDATE auth.users
  SET raw_user_meta_data =
        COALESCE(raw_user_meta_data, '{}'::jsonb) || new_meta
  WHERE lower(email) = lower(NEW.email);

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_allowed_users_to_auth"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tasks_visible_reps"() RETURNS SETOF "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT au.rep_name FROM allowed_users au
  WHERE au.rep_name IS NOT NULL
    AND normalize(au.rep_name, NFC) <> ALL (ARRAY[
      normalize('Simon Fortin Massé', NFC),
      normalize('Magasin Affichez', NFC),
      normalize('Charles Côté', NFC),
      normalize('Pier-Alexandre Lévesque', NFC),
      normalize('Vente interne', NFC)
    ]);
$$;


ALTER FUNCTION "public"."tasks_visible_reps"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_account_departments"("p_account_id" "text") RETURNS "text"[]
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT array_agg(DISTINCT btrim(i.department) ORDER BY btrim(i.department))
    FROM invoices i
   WHERE p_account_id IS NOT NULL
     AND i.crm_account_id = p_account_id
     AND i.department IS NOT NULL
     AND btrim(i.department) <> '';
$$;


ALTER FUNCTION "public"."zoho_account_departments"("p_account_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_account_is_bulk_import"("p_source" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT COALESCE(p_source, '') IN (
    'Client Royer & Fils / VotreLogo.ca',
    'Client PLOGG/BUCCO'
  );
$$;


ALTER FUNCTION "public"."zoho_account_is_bulk_import"("p_source" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_account_services"("p_account_id" "text") RETURNS "text"[]
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT NULLIF(a.service_interest, '{}'::TEXT[])
    FROM zoho_accounts a
   WHERE p_account_id IS NOT NULL
     AND a.zoho_account_id = p_account_id;
$$;


ALTER FUNCTION "public"."zoho_account_services"("p_account_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_account_source"("p_account_id" "text") RETURNS "text"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT a.origine_du_client
    FROM zoho_accounts a
   WHERE p_account_id IS NOT NULL
     AND a.zoho_account_id = p_account_id;
$$;


ALTER FUNCTION "public"."zoho_account_source"("p_account_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_account_window_end"("p_created" timestamp with time zone, "p_months" integer) RETURNS "date"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE
    WHEN p_months IS NULL THEN 'infinity'::date
    ELSE ((p_created AT TIME ZONE 'America/Toronto')::date
          + pg_catalog.make_interval(months => p_months))::date
  END;
$$;


ALTER FUNCTION "public"."zoho_account_window_end"("p_created" timestamp with time zone, "p_months" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_accounts_scoped"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text", "p_domaine" "text" DEFAULT NULL::"text", "p_region" "text" DEFAULT NULL::"text", "p_exclude_ratings" "text"[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::"text", 'Fournisseur'::"text"], "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("zoho_account_id" "text", "account_name" "text", "created_time" timestamp with time zone, "created_date" "date", "rep_name" "text", "origine_du_client" "text", "service_interest" "text"[], "domaine_activite" "text", "region_administrative" "text", "rating" "text", "is_bulk_import" boolean, "ventes_totales" numeric)
    LANGUAGE "sql" STABLE
    AS $$
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
$$;


ALTER FUNCTION "public"."zoho_accounts_scoped"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_exclude_ratings" "text"[], "p_reps" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_books_customers_propagate"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE invoices i
     SET crm_account_id = NEW.crm_account_id,
         crm_contact_id = NEW.crm_contact_id
   WHERE i.books_customer_id = NEW.books_customer_id
     AND (i.crm_account_id IS DISTINCT FROM NEW.crm_account_id
       OR i.crm_contact_id IS DISTINCT FROM NEW.crm_contact_id);
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."zoho_books_customers_propagate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_internal_ratings"() RETURNS "text"[]
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur'];
$$;


ALTER FUNCTION "public"."zoho_internal_ratings"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."zoho_internal_ratings"() IS 'Zoho Rating values that mark an Affichez entity rather than a client. Excluded by default on the Comptes dashboard and detail table; both keep a filter to switch them back on. Mirrored by zoho_accounts_scoped''s p_exclude_ratings default.';



CREATE OR REPLACE FUNCTION "public"."zoho_lead_local_date"("p_at" timestamp with time zone) RETURNS "date"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT (p_at AT TIME ZONE 'America/Toronto')::date;
$$;


ALTER FUNCTION "public"."zoho_lead_local_date"("p_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_leads_inherit_attribution"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_source   TEXT;
  v_services TEXT[];
BEGIN
  IF NEW.stage = 'lead' AND NEW.converted_contact_id IS NOT NULL THEN
    -- A lead landed: push its attribution down onto the contact it became.
    -- This re-fires the trigger on that contact row, but only one level deep —
    -- the row then has a non-null lead_source, so the ELSIF below can't match.
    UPDATE zoho_leads c
       SET lead_source           = COALESCE(c.lead_source, NEW.lead_source),
           service_interest      = CASE WHEN cardinality(c.service_interest) = 0
                                        THEN NEW.service_interest
                                        ELSE c.service_interest END,
           attribution_inherited = TRUE
     WHERE c.zoho_record_id = NEW.converted_contact_id
       AND c.stage = 'contact'
       AND NEW.lead_source IS NOT NULL
       AND (c.lead_source IS NULL OR cardinality(c.service_interest) = 0);

  ELSIF NEW.stage = 'contact' AND NEW.lead_source IS NULL THEN
    -- A contact landed first: pull attribution from the lead that points at it.
    -- Assigned via locals, not SELECT INTO NEW.*, because a miss would set every
    -- target to NULL and blow up the NOT NULL on attribution_inherited.
    SELECT l.lead_source, l.service_interest
      INTO v_source, v_services
      FROM zoho_leads l
     WHERE l.converted_contact_id = NEW.zoho_record_id
       AND l.stage = 'lead'
     ORDER BY l.converted_time DESC NULLS LAST
     LIMIT 1;

    IF v_source IS NOT NULL THEN
      NEW.lead_source           := v_source;
      NEW.service_interest      := COALESCE(v_services, '{}');
      NEW.attribution_inherited := TRUE;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."zoho_leads_inherit_attribution"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_leads_scoped"("p_year" integer DEFAULT NULL::integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_service" "text" DEFAULT NULL::"text") RETURNS TABLE("zoho_record_id" "text", "account_id" "text", "created_time" timestamp with time zone, "is_converted" boolean, "rep_name" "text", "lead_source" "text", "service_interest" "text"[])
    LANGUAGE "sql" STABLE
    AS $$
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
$$;


ALTER FUNCTION "public"."zoho_leads_scoped"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_local_date"("p_at" timestamp with time zone) RETURNS "date"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT (p_at AT TIME ZONE 'America/Toronto')::date;
$$;


ALTER FUNCTION "public"."zoho_local_date"("p_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_normalise_service_interest"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.service_interest := zoho_service_canonical_array(NEW.service_interest);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."zoho_normalise_service_interest"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_service_canonical"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  WITH norm AS (
    -- lowercase, accents stripped, punctuation dropped, whitespace collapsed
    SELECT regexp_replace(
             regexp_replace(
               lower(translate(COALESCE(p_value, ''),
                               'àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ',
                               'aaaeeeeiioouuucAAAEEEEIIOOUUUC')),
               '[^a-z0-9 ]', ' ', 'g'),
             '\s+', ' ', 'g') AS k
  )
  SELECT CASE
    -- Anything that is imprimés / articles / vêtements + promo is this service,
    -- however it was typed. Written as a rule rather than a list of the eight
    -- known spellings so a ninth invented next month folds in on its own.
    WHEN (SELECT btrim(k) FROM norm) = '' THEN NULL
    WHEN (SELECT k FROM norm) LIKE '%promo%'
     AND ((SELECT k FROM norm) LIKE '%imprim%'
       OR (SELECT k FROM norm) LIKE '%article%'
       OR (SELECT k FROM norm) LIKE '%vetement%')
      THEN 'Imprimés, articles et vêtements promo'
    -- "Imprimés" on its own, with no "promo" to match above.
    WHEN btrim((SELECT k FROM norm)) IN ('imprimes', 'imprime')
      THEN 'Imprimés, articles et vêtements promo'
    ELSE btrim(p_value)
  END;
$$;


ALTER FUNCTION "public"."zoho_service_canonical"("p_value" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."zoho_service_canonical"("p_value" "text") IS 'Folds every spelling of the promotional-products service onto one value. Applied by trigger on zoho_accounts and zoho_leads so a re-sync cannot undo it. Leaves every other service untouched.';



CREATE OR REPLACE FUNCTION "public"."zoho_service_canonical_array"("p_values" "text"[]) RETURNS "text"[]
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT array_agg(DISTINCT c ORDER BY c)
       FROM (SELECT zoho_service_canonical(v) AS c
               FROM unnest(COALESCE(p_values, '{}')) AS v) x
      WHERE c IS NOT NULL AND btrim(c) <> ''),
    '{}');
$$;


ALTER FUNCTION "public"."zoho_service_canonical_array"("p_values" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."zoho_service_key"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT pg_catalog.lower(
           pg_catalog.regexp_replace(
             pg_catalog.btrim(COALESCE(p_value, '')), '\s+', ' ', 'g'));
$$;


ALTER FUNCTION "public"."zoho_service_key"("p_value" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."ad_campaigns" (
    "platform" "text" NOT NULL,
    "ad_account_id" "text" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "campaign_name" "text",
    "status" "text" NOT NULL,
    "platform_status" "text",
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ad_campaigns_platform_check" CHECK (("platform" = ANY (ARRAY['google'::"text", 'meta'::"text"]))),
    CONSTRAINT "ad_campaigns_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'removed'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."ad_campaigns" OWNER TO "postgres";


COMMENT ON TABLE "public"."ad_campaigns" IS 'Current name and status of every Google Ads / Meta campaign. Refreshed by ads-spend-sync on every run.';



CREATE TABLE IF NOT EXISTS "public"."ad_spend_daily" (
    "platform" "text" NOT NULL,
    "ad_account_id" "text" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "campaign_name" "text",
    "campaign_status" "text",
    "spend_date" "date" NOT NULL,
    "currency" "text",
    "spend" numeric(18,6) DEFAULT 0 NOT NULL,
    "impressions" bigint DEFAULT 0 NOT NULL,
    "clicks" bigint DEFAULT 0 NOT NULL,
    "conversions" numeric(14,4) DEFAULT 0 NOT NULL,
    "leads" numeric(14,4) DEFAULT 0 NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ad_spend_daily_platform_check" CHECK (("platform" = ANY (ARRAY['google'::"text", 'meta'::"text"])))
);


ALTER TABLE "public"."ad_spend_daily" OWNER TO "postgres";


COMMENT ON TABLE "public"."ad_spend_daily" IS 'Daily per-campaign ad spend from Google Ads and Meta. Written only by the ads-spend-sync edge function; re-pulled on a rolling window.';



CREATE TABLE IF NOT EXISTS "public"."allowed_users" (
    "email" "text" NOT NULL,
    "name" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "can_access_factures" boolean DEFAULT false NOT NULL,
    "rep_name" "text",
    CONSTRAINT "allowed_users_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."allowed_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."department_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "zoho_label" "text" NOT NULL,
    "internal_department" "public"."department_enum" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."department_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."excluded_clients" (
    "id" integer NOT NULL,
    "client_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."excluded_clients" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."excluded_clients_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."excluded_clients_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."excluded_clients_id_seq" OWNED BY "public"."excluded_clients"."id";



CREATE TABLE IF NOT EXISTS "public"."excluded_reps" (
    "id" integer NOT NULL,
    "rep_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."excluded_reps" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."excluded_reps_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."excluded_reps_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."excluded_reps_id_seq" OWNED BY "public"."excluded_reps"."id";



CREATE TABLE IF NOT EXISTS "public"."fiscal_quarters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "year" integer NOT NULL,
    "quarter" integer NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "num_weeks" integer DEFAULT 13 NOT NULL,
    CONSTRAINT "fiscal_quarters_quarter_check" CHECK ((("quarter" >= 1) AND ("quarter" <= 4)))
);


ALTER TABLE "public"."fiscal_quarters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "zoho_id" "text" NOT NULL,
    "invoice_number" "text",
    "client_name" "text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "rep_name" "text",
    "department" "text",
    "zoho_department_label" "text",
    "office" "text",
    "invoice_date" "date",
    "status" "public"."invoice_status_enum" DEFAULT 'sent'::"public"."invoice_status_enum" NOT NULL,
    "is_avoir" boolean DEFAULT false NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "books_customer_id" "text",
    "crm_account_id" "text",
    "crm_contact_id" "text",
    "created_by_name" "text",
    "created_by_id" "text",
    CONSTRAINT "invoices_office_check" CHECK (("office" = ANY (ARRAY['QC'::"text", 'MTL'::"text"])))
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


COMMENT ON TABLE "public"."invoices" IS 'Zoho Books invoices and credit notes, both organisations. RLS: readable by authenticated users only; written solely by the sync edge functions under the service-role key.';



COMMENT ON COLUMN "public"."invoices"."books_customer_id" IS 'Zoho Books customer_id. The raw link; always available from the sync.';



COMMENT ON COLUMN "public"."invoices"."crm_account_id" IS 'Zoho CRM account id, resolved via zoho_books_customers. NULL when the Books customer has no CRM account. Maintained by trigger, never written by the sync.';



COMMENT ON COLUMN "public"."invoices"."created_by_name" IS 'Zoho Books invoice.created_by - who keyed the invoice in, which is often NOT rep_name (the salesperson). Free: present on the list endpoint.';



CREATE TABLE IF NOT EXISTS "public"."leads" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "lead_date" "date" NOT NULL,
    "rep_name" "text" NOT NULL,
    "source" "text" NOT NULL,
    "service_interest" "text",
    "amount_sold" numeric DEFAULT 0 NOT NULL,
    "zoho_lead_id" "text",
    "zoho_contact_id" "text",
    "zoho_crm_url" "text",
    "notes" "text",
    "lead_status" "text" DEFAULT 'active'::"text" NOT NULL,
    CONSTRAINT "leads_lead_status_check" CHECK (("lead_status" = ANY (ARRAY['active'::"text", 'won'::"text", 'lost'::"text"])))
);


ALTER TABLE "public"."leads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."objectives" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "year" integer NOT NULL,
    "month" integer NOT NULL,
    "department" "public"."department_enum" NOT NULL,
    "target_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "objectives_month_check" CHECK ((("month" >= 1) AND ("month" <= 12)))
);


ALTER TABLE "public"."objectives" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."objectives_factures" (
    "id" integer NOT NULL,
    "year" integer NOT NULL,
    "month" integer NOT NULL,
    "department" "text" NOT NULL,
    "target_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    CONSTRAINT "objectives_factures_month_check" CHECK ((("month" >= 1) AND ("month" <= 12)))
);


ALTER TABLE "public"."objectives_factures" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."objectives_factures_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."objectives_factures_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."objectives_factures_id_seq" OWNED BY "public"."objectives_factures"."id";



CREATE TABLE IF NOT EXISTS "public"."paye_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rep_name" "text" NOT NULL,
    "year" integer NOT NULL,
    "pay_date" "text" DEFAULT ''::"text" NOT NULL,
    "base_salary" numeric(12,2),
    "commission" numeric(12,2),
    "expenses" numeric(12,2),
    "holidays" numeric(12,2),
    "vacation" numeric(12,2),
    "note" "text" DEFAULT ''::"text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."paye_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."paye_meta" (
    "rep_name" "text" NOT NULL,
    "year" integer NOT NULL,
    "previous_year_balance" numeric(12,2) DEFAULT 0 NOT NULL,
    "annual_bonus" numeric(12,2) DEFAULT 0 NOT NULL,
    "commission_prev_year" numeric(12,2) DEFAULT 0 NOT NULL,
    "bank_balance" numeric(12,2) DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."paye_meta" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rep_comm_rates" (
    "rep_name" "text" NOT NULL,
    "rate" numeric(5,4) DEFAULT 0.05 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."rep_comm_rates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rep_objectives" (
    "id" integer NOT NULL,
    "rep_name" "text" NOT NULL,
    "module" "text" NOT NULL,
    "year" integer NOT NULL,
    "month" integer NOT NULL,
    "target_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "rep_objectives_module_check" CHECK (("module" = ANY (ARRAY['devis'::"text", 'factures'::"text"]))),
    CONSTRAINT "rep_objectives_month_check" CHECK ((("month" >= 1) AND ("month" <= 12)))
);


ALTER TABLE "public"."rep_objectives" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rep_objectives_dept" (
    "id" integer NOT NULL,
    "rep_name" "text" NOT NULL,
    "module" "text" NOT NULL,
    "year" integer NOT NULL,
    "month" integer NOT NULL,
    "department" "text" NOT NULL,
    "target_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "rep_objectives_dept_module_check" CHECK (("module" = ANY (ARRAY['devis'::"text", 'factures'::"text"]))),
    CONSTRAINT "rep_objectives_dept_month_check" CHECK ((("month" >= 1) AND ("month" <= 12)))
);


ALTER TABLE "public"."rep_objectives_dept" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."rep_objectives_dept_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."rep_objectives_dept_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."rep_objectives_dept_id_seq" OWNED BY "public"."rep_objectives_dept"."id";



CREATE SEQUENCE IF NOT EXISTS "public"."rep_objectives_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."rep_objectives_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."rep_objectives_id_seq" OWNED BY "public"."rep_objectives"."id";



CREATE TABLE IF NOT EXISTS "public"."reps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "office" "public"."office_enum" DEFAULT 'QC'::"public"."office_enum" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."reps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "zoho_id" "text" NOT NULL,
    "sale_date" "date" NOT NULL,
    "client_name" "text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "quote_number" "text",
    "rep_id" "uuid",
    "zoho_department_label" "text",
    "department" "public"."department_enum",
    "week_start" "date" NOT NULL,
    "week_end" "date" NOT NULL,
    "month" integer GENERATED ALWAYS AS ((EXTRACT(month FROM "sale_date"))::integer) STORED,
    "year" integer GENERATED ALWAYS AS ((EXTRACT(year FROM "sale_date"))::integer) STORED,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "office" "public"."office_enum" NOT NULL,
    "status" "public"."sale_status_enum" DEFAULT 'accepted'::"public"."sale_status_enum",
    "rep_name" "text",
    "created_by_name" "text",
    "created_by_id" "text",
    "creator_link_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "creator_link_error" "text"
);


ALTER TABLE "public"."sales" OWNER TO "postgres";


COMMENT ON TABLE "public"."sales" IS 'Zoho Books estimates that reached accepted/invoiced, both organisations. Holds WON quotes only — see STATS-INTEGRITY.md before computing any ratio. Written solely by zoho-sync under the service-role key.';



COMMENT ON COLUMN "public"."sales"."created_by_id" IS 'Zoho Books estimate.created_by_id, available only on the DETAIL endpoint, so it costs one API call per quote. Filled by zoho-quote-creator-sync and resolved to a name through zoho_books_users.';



CREATE TABLE IF NOT EXISTS "public"."sync_state" (
    "key" "text" NOT NULL,
    "last_modified_time" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cursor_token" "text"
);


ALTER TABLE "public"."sync_state" OWNER TO "postgres";


COMMENT ON COLUMN "public"."sync_state"."cursor_token" IS 'Zoho page_token for an in-progress paginated walk. NULL when no walk is mid-flight. Bound to the exact query that produced it — a changed filter invalidates it.';



CREATE OR REPLACE VIEW "public"."v_inv_weekly_summary" AS
 SELECT ("date_trunc"('week'::"text", ("invoice_date")::timestamp with time zone))::"date" AS "week_start",
    (("date_trunc"('week'::"text", ("invoice_date")::timestamp with time zone))::"date" + 6) AS "week_end",
    "rep_name",
    "office",
    ("status")::"text" AS "status",
    "department",
    "sum"("amount") AS "total_amount",
    "count"(*) AS "num_sales"
   FROM "public"."invoices"
  WHERE (("rep_name" IS NOT NULL) AND (("status")::"text" <> ALL (ARRAY['void'::"text", 'avoir'::"text"])) AND (NOT "is_avoir") AND (NOT ("client_name" IN ( SELECT "excluded_clients"."client_name"
           FROM "public"."excluded_clients"))) AND (NOT ("rep_name" IN ( SELECT "excluded_reps"."rep_name"
           FROM "public"."excluded_reps"))))
  GROUP BY (("date_trunc"('week'::"text", ("invoice_date")::timestamp with time zone))::"date"), (("date_trunc"('week'::"text", ("invoice_date")::timestamp with time zone))::"date" + 6), "rep_name", "office", "status", "department";


ALTER VIEW "public"."v_inv_weekly_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_monthly_dept_totals" AS
 SELECT "year",
    "month",
    "department",
    COALESCE("sum"("amount"), (0)::numeric) AS "total_amount"
   FROM "public"."sales"
  WHERE (("status")::"text" <> 'declined'::"text")
  GROUP BY "year", "month", "department"
  ORDER BY "year", "month", "department";


ALTER VIEW "public"."v_monthly_dept_totals" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_monthly_grand_totals" AS
 SELECT "year",
    "month",
    COALESCE("sum"("amount"), (0)::numeric) AS "total_amount"
   FROM "public"."sales"
  WHERE (("status")::"text" <> 'declined'::"text")
  GROUP BY "year", "month"
  ORDER BY "year", "month";


ALTER VIEW "public"."v_monthly_grand_totals" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_monthly_rep_totals" AS
 SELECT "s"."year",
    "s"."month",
    "r"."name" AS "rep_name",
    "r"."office",
    "s"."department",
    COALESCE("sum"("s"."amount"), (0)::numeric) AS "total_amount",
    "count"(*) AS "num_sales"
   FROM ("public"."sales" "s"
     JOIN "public"."reps" "r" ON (("r"."id" = "s"."rep_id")))
  WHERE (("s"."status")::"text" <> 'declined'::"text")
  GROUP BY "s"."year", "s"."month", "r"."name", "r"."office", "s"."department"
  ORDER BY "s"."year", "s"."month", "r"."name", "s"."department";


ALTER VIEW "public"."v_monthly_rep_totals" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_quarterly_rep_averages" AS
 SELECT "fq"."year",
    "fq"."quarter",
    "r"."name" AS "rep_name",
    COALESCE("sum"("s"."amount"), (0)::numeric) AS "quarter_total",
        CASE
            WHEN ("fq"."end_date" > CURRENT_DATE) THEN GREATEST(1, ((CURRENT_DATE - "fq"."start_date") / 7))
            ELSE "fq"."num_weeks"
        END AS "num_weeks",
    "round"((COALESCE("sum"("s"."amount"), (0)::numeric) / (GREATEST(1,
        CASE
            WHEN ("fq"."end_date" > CURRENT_DATE) THEN ((CURRENT_DATE - "fq"."start_date") / 7)
            ELSE "fq"."num_weeks"
        END))::numeric), 2) AS "weekly_average"
   FROM (("public"."fiscal_quarters" "fq"
     CROSS JOIN "public"."reps" "r")
     LEFT JOIN "public"."sales" "s" ON ((("s"."rep_id" = "r"."id") AND ("s"."sale_date" >= "fq"."start_date") AND ("s"."sale_date" <= "fq"."end_date") AND (("s"."status")::"text" <> 'declined'::"text"))))
  WHERE ("r"."is_active" = true)
  GROUP BY "fq"."year", "fq"."quarter", "fq"."num_weeks", "fq"."start_date", "fq"."end_date", "r"."name"
  ORDER BY "fq"."year", "fq"."quarter", "r"."name";


ALTER VIEW "public"."v_quarterly_rep_averages" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_quarterly_yoy" WITH ("security_invoker"='true') AS
 SELECT "curr"."year" AS "current_year",
    "curr"."quarter",
    "curr"."rep_name",
    COALESCE("curr"."weekly_average", (0)::numeric) AS "current_avg",
    COALESCE("prev"."weekly_average", (0)::numeric) AS "previous_avg",
    "round"((COALESCE("curr"."weekly_average", (0)::numeric) - COALESCE("prev"."weekly_average", (0)::numeric)), 2) AS "resultat"
   FROM ("public"."v_quarterly_rep_averages" "curr"
     LEFT JOIN "public"."v_quarterly_rep_averages" "prev" ON ((("prev"."rep_name" = "curr"."rep_name") AND ("prev"."year" = ("curr"."year" - 1)) AND ("prev"."quarter" = "curr"."quarter"))))
  ORDER BY "curr"."year" DESC, "curr"."quarter", "curr"."rep_name";


ALTER VIEW "public"."v_quarterly_yoy" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_sommaire" WITH ("security_invoker"='true') AS
 SELECT "o"."year",
    "o"."month",
    "o"."department",
    "o"."target_amount" AS "objectif",
    COALESCE("m"."total_amount", (0)::numeric) AS "actual_amount",
        CASE
            WHEN ("o"."target_amount" > (0)::numeric) THEN "round"(((COALESCE("m"."total_amount", (0)::numeric) / "o"."target_amount") * (100)::numeric), 2)
            ELSE (0)::numeric
        END AS "pct_atteint"
   FROM ("public"."objectives" "o"
     LEFT JOIN "public"."v_monthly_dept_totals" "m" ON ((("m"."year" = "o"."year") AND ("m"."month" = "o"."month") AND ("m"."department" = "o"."department"))))
  ORDER BY "o"."year", "o"."month", "o"."department";


ALTER VIEW "public"."v_sommaire" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_sommaire_grand_total" WITH ("security_invoker"='true') AS
 SELECT "year",
    "month",
    "sum"("objectif") AS "objectif",
    "sum"("actual_amount") AS "actual_amount",
        CASE
            WHEN ("sum"("objectif") > (0)::numeric) THEN "round"((("sum"("actual_amount") / "sum"("objectif")) * (100)::numeric), 2)
            ELSE (0)::numeric
        END AS "pct_atteint"
   FROM "public"."v_sommaire"
  GROUP BY "year", "month"
  ORDER BY "year", "month";


ALTER VIEW "public"."v_sommaire_grand_total" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_weekly_dept_totals" AS
 SELECT "week_start",
    "week_end",
    "department",
    COALESCE("sum"("amount"), (0)::numeric) AS "total_amount",
    "count"(*) AS "num_sales"
   FROM "public"."sales"
  WHERE (("status")::"text" <> 'declined'::"text")
  GROUP BY "week_start", "week_end", "department"
  ORDER BY "week_start" DESC, "department";


ALTER VIEW "public"."v_weekly_dept_totals" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_weekly_grand_totals" AS
 SELECT "week_start",
    "week_end",
    COALESCE("sum"("amount"), (0)::numeric) AS "total_amount",
    "count"(*) AS "num_sales"
   FROM "public"."sales"
  WHERE (("status")::"text" <> 'declined'::"text")
  GROUP BY "week_start", "week_end"
  ORDER BY "week_start" DESC;


ALTER VIEW "public"."v_weekly_grand_totals" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_weekly_summary" AS
 SELECT ("date_trunc"('week'::"text", ("sale_date")::timestamp without time zone))::"date" AS "week_start",
    (("date_trunc"('week'::"text", ("sale_date")::timestamp without time zone))::"date" + 6) AS "week_end",
    "rep_name",
    ("office")::"text" AS "office",
    ("status")::"text" AS "status",
    "department",
    "sum"("amount") AS "total_amount",
    "count"(*) AS "num_sales"
   FROM "public"."sales"
  WHERE (("rep_name" IS NOT NULL) AND (("status")::"text" <> 'declined'::"text") AND (NOT ("client_name" IN ( SELECT "excluded_clients"."client_name"
           FROM "public"."excluded_clients"))) AND (NOT ("rep_name" IN ( SELECT "excluded_reps"."rep_name"
           FROM "public"."excluded_reps"))))
  GROUP BY (("date_trunc"('week'::"text", ("sale_date")::timestamp without time zone))::"date"), (("date_trunc"('week'::"text", ("sale_date")::timestamp without time zone))::"date" + 6), "rep_name", "office", "status", "department";


ALTER VIEW "public"."v_weekly_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."webhook_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "zoho_id" "text",
    "action" "text" NOT NULL,
    "status_code" integer DEFAULT 200 NOT NULL,
    "payload" "jsonb",
    "error_message" "text"
);


ALTER TABLE "public"."webhook_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."zoho_accounts" (
    "zoho_account_id" "text" NOT NULL,
    "account_name" "text",
    "origine_du_client" "text",
    "service_interest" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "modified_time" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "phone" "text",
    "website" "text",
    "billing_street" "text",
    "billing_city" "text",
    "billing_state" "text",
    "billing_code" "text",
    "billing_country" "text",
    "description" "text",
    "zoho_crm_url" "text",
    "owner_id" "text",
    "owner_name" "text",
    "owner_email" "text",
    "rep_name" "text",
    "charge_de_projets" "text",
    "created_time" timestamp with time zone,
    "last_activity_time" timestamp with time zone,
    "rating" "text",
    "domaine_activite" "text",
    "region_administrative" "text",
    "region_cible" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "type_marche" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "periode_publicitaire" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "nombre_employes" "text",
    "budget_publicitaire_annuel" numeric,
    "potentiel_multi_annonceurs" "text",
    "potentiel_services_ia" boolean,
    "revendeur" boolean,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "parent_account_id" "text",
    "parent_account_name" "text",
    "nombre_taches" integer,
    "derniere_tache_fermee" "date",
    "ventes_2022" numeric,
    "ventes_2023" numeric,
    "ventes_2024" numeric,
    "ventes_2025" numeric,
    "ventes_2026" numeric,
    "ventes_totales" numeric
);


ALTER TABLE "public"."zoho_accounts" OWNER TO "postgres";


COMMENT ON TABLE "public"."zoho_accounts" IS 'Zoho CRM Accounts. The record behind the Comptes module, and the source of the two attribution fields a Contact does not carry itself. Synced by zoho-account-sync; never written from the app.';



COMMENT ON COLUMN "public"."zoho_accounts"."origine_du_client" IS 'Accounts."Origine du client". A different picklist from Leads.Lead_Source - only 13 values are shared between them. Kept in Zoho''s own wording.';



COMMENT ON COLUMN "public"."zoho_accounts"."rep_name" IS 'Owner resolved through allowed_users.email, so the name matches the one the Devis and Factures modules use for the same person.';



COMMENT ON COLUMN "public"."zoho_accounts"."created_time" IS 'Zoho Created_Time. The axis of the Comptes module: which month an account arrived in, and the zero point of the revenue attribution window.';



COMMENT ON COLUMN "public"."zoho_accounts"."rating" IS 'Zoho Rating picklist. "Compte interne : Ne pas reprendre" (1,937 rows) marks Affichez''s own entities and is excluded by default on the dashboard.';



COMMENT ON COLUMN "public"."zoho_accounts"."ventes_totales" IS 'Zoho Ventes totales 2022-2026. Populated ONLY for Client Royer & Fils / VotreLogo.ca accounts, whose invoices live outside the Books orgs we sync. Never added into revenue_attributed or revenue_lifetime.';



CREATE OR REPLACE VIEW "public"."zoho_accounts_enriched" WITH ("security_invoker"='true') AS
 SELECT "a"."zoho_account_id",
    "a"."account_name",
    "a"."phone",
    "a"."website",
    "a"."description",
    "a"."billing_street",
    "a"."billing_city",
    "a"."billing_state",
    "a"."billing_code",
    "a"."billing_country",
    "a"."owner_name",
    "a"."owner_email",
    "a"."rep_name",
    "a"."charge_de_projets",
    "a"."created_time",
    "public"."zoho_local_date"("a"."created_time") AS "created_date",
    "a"."modified_time",
    "a"."last_activity_time",
    "a"."origine_du_client",
    "a"."service_interest",
    "a"."domaine_activite",
    "a"."region_administrative",
    "a"."region_cible",
    "a"."type_marche",
    "a"."periode_publicitaire",
    "a"."nombre_employes",
    "a"."budget_publicitaire_annuel",
    "a"."potentiel_multi_annonceurs",
    "a"."potentiel_services_ia",
    "a"."revendeur",
    "a"."rating",
    "a"."tags",
    "a"."parent_account_id",
    "a"."parent_account_name",
    "a"."nombre_taches",
    "a"."derniere_tache_fermee",
    "a"."ventes_totales",
    "a"."ventes_2026",
    "a"."ventes_2025",
    "a"."zoho_crm_url",
    COALESCE("i"."invoice_count", 0) AS "invoice_count",
    COALESCE("i"."credit_count", 0) AS "credit_count",
    COALESCE("i"."revenue_lifetime", (0)::numeric) AS "revenue_lifetime",
    "i"."first_invoice_date",
    "i"."last_invoice_date",
    ("i"."invoice_count" IS NOT NULL) AS "has_invoices",
    "public"."zoho_account_is_bulk_import"("a"."origine_du_client") AS "is_bulk_import",
    COALESCE(("a"."rating" = ANY ("public"."zoho_internal_ratings"())), false) AS "is_internal",
        CASE
            WHEN ("cardinality"("a"."service_interest") > 0) THEN "a"."service_interest"
            ELSE COALESCE("i"."departments", '{}'::"text"[])
        END AS "service_resolved",
        CASE
            WHEN ("cardinality"("a"."service_interest") > 0) THEN 'crm'::"text"
            WHEN (COALESCE("cardinality"("i"."departments"), 0) > 0) THEN 'invoice'::"text"
            ELSE 'none'::"text"
        END AS "service_origin"
   FROM ("public"."zoho_accounts" "a"
     LEFT JOIN ( SELECT "invoices"."crm_account_id",
            ("count"(*) FILTER (WHERE (NOT "invoices"."is_avoir")))::integer AS "invoice_count",
            ("count"(*) FILTER (WHERE "invoices"."is_avoir"))::integer AS "credit_count",
            COALESCE("sum"("invoices"."amount"), (0)::numeric) AS "revenue_lifetime",
            "min"("invoices"."invoice_date") AS "first_invoice_date",
            "max"("invoices"."invoice_date") AS "last_invoice_date",
            "array_agg"(DISTINCT "invoices"."department" ORDER BY "invoices"."department") FILTER (WHERE (("invoices"."department" IS NOT NULL) AND (NOT "invoices"."is_avoir"))) AS "departments"
           FROM "public"."invoices"
          WHERE ("invoices"."crm_account_id" IS NOT NULL)
          GROUP BY "invoices"."crm_account_id") "i" ON (("i"."crm_account_id" = "a"."zoho_account_id")));


ALTER VIEW "public"."zoho_accounts_enriched" OWNER TO "postgres";


COMMENT ON VIEW "public"."zoho_accounts_enriched" IS 'One row per Zoho CRM account with its lifetime invoice rollup attached. Backs the Comptes detail table, which filters and paginates server-side. Revenue is lifetime; the 12-month attribution window lives in get_zoho_account_kpis and the breakdown RPCs, not here.';



CREATE TABLE IF NOT EXISTS "public"."zoho_books_customers" (
    "books_customer_id" "text" NOT NULL,
    "office" "text" NOT NULL,
    "customer_name" "text",
    "crm_account_id" "text",
    "crm_contact_id" "text",
    "link_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "last_error" "text",
    "resolved_at" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "zoho_books_customers_link_status_check" CHECK (("link_status" = ANY (ARRAY['pending'::"text", 'linked'::"text", 'unlinked'::"text", 'error'::"text"]))),
    CONSTRAINT "zoho_books_customers_office_check" CHECK (("office" = ANY (ARRAY['QC'::"text", 'MTL'::"text"])))
);


ALTER TABLE "public"."zoho_books_customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."zoho_books_users" (
    "user_id" "text" NOT NULL,
    "office" "text" NOT NULL,
    "name" "text",
    "email" "text",
    "status" "text",
    "rep_name" "text",
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."zoho_books_users" OWNER TO "postgres";


COMMENT ON TABLE "public"."zoho_books_users" IS 'Zoho Books org users, cached so an estimate''s created_by_id can be turned into a name. 133 users in QC, 17 in MTL as of 2026-09-07. Refreshed by zoho-quote-creator-sync at the start of each run.';



CREATE TABLE IF NOT EXISTS "public"."zoho_leads" (
    "zoho_record_id" "text" NOT NULL,
    "stage" "text" NOT NULL,
    "full_name" "text",
    "first_name" "text",
    "last_name" "text",
    "company" "text",
    "phone" "text",
    "email" "text",
    "owner_name" "text",
    "owner_email" "text",
    "rep_name" "text",
    "created_time" timestamp with time zone,
    "modified_time" timestamp with time zone,
    "lead_source" "text",
    "service_interest" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "lead_status" "text",
    "attribution_inherited" boolean DEFAULT false NOT NULL,
    "is_converted" boolean DEFAULT false NOT NULL,
    "converted_contact_id" "text",
    "converted_account_id" "text",
    "converted_deal_id" "text",
    "converted_time" timestamp with time zone,
    "zoho_crm_url" "text",
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "account_id" "text",
    CONSTRAINT "zoho_leads_stage_check" CHECK (("stage" = ANY (ARRAY['lead'::"text", 'contact'::"text"])))
);


ALTER TABLE "public"."zoho_leads" OWNER TO "postgres";


COMMENT ON COLUMN "public"."zoho_leads"."account_id" IS 'Zoho CRM account id this record belongs to. Contacts: Account_Name.id. Leads: Converted_Account.id, NULL while unconverted. Joins to invoices.crm_account_id.';



CREATE OR REPLACE VIEW "public"."zoho_leads_unique" WITH ("security_invoker"='true') AS
 SELECT "zoho_record_id",
    "stage",
    "full_name",
    "first_name",
    "last_name",
    "company",
    "phone",
    "email",
    "owner_name",
    "owner_email",
    "rep_name",
    "created_time",
    "modified_time",
    "lead_source",
    "service_interest",
    "lead_status",
    "attribution_inherited",
    "is_converted",
    "converted_contact_id",
    "converted_account_id",
    "converted_deal_id",
    "converted_time",
    "zoho_crm_url",
    "synced_at",
    "account_id",
    (("account_id" IS NOT NULL) AND (EXISTS ( SELECT 1
           FROM "public"."invoices" "i"
          WHERE ("i"."crm_account_id" = "l"."account_id")))) AS "has_invoices",
        CASE
            WHEN ("stage" <> 'contact'::"text") THEN "lead_source"
            WHEN (("account_id" IS NOT NULL) AND (EXISTS ( SELECT 1
               FROM "public"."invoices" "i"
              WHERE ("i"."crm_account_id" = "l"."account_id")))) THEN COALESCE("public"."zoho_account_source"("account_id"), "lead_source")
            ELSE COALESCE("lead_source", "public"."zoho_account_source"("account_id"))
        END AS "source_resolved",
        CASE
            WHEN ("stage" <> 'contact'::"text") THEN "service_interest"
            ELSE COALESCE("public"."zoho_account_departments"("account_id"), NULLIF("service_interest", '{}'::"text"[]), "public"."zoho_account_services"("account_id"), '{}'::"text"[])
        END AS "service_resolved",
        CASE
            WHEN ("stage" <> 'contact'::"text") THEN 'own'::"text"
            WHEN (("account_id" IS NOT NULL) AND (EXISTS ( SELECT 1
               FROM "public"."invoices" "i"
              WHERE ("i"."crm_account_id" = "l"."account_id"))) AND ("public"."zoho_account_source"("account_id") IS NOT NULL)) THEN 'account'::"text"
            WHEN ("lead_source" IS NOT NULL) THEN
            CASE
                WHEN "attribution_inherited" THEN 'lead'::"text"
                ELSE 'own'::"text"
            END
            WHEN ("public"."zoho_account_source"("account_id") IS NOT NULL) THEN 'account'::"text"
            ELSE NULL::"text"
        END AS "source_origin",
        CASE
            WHEN ("stage" <> 'contact'::"text") THEN 'own'::"text"
            WHEN ("public"."zoho_account_departments"("account_id") IS NOT NULL) THEN 'invoice'::"text"
            WHEN ("cardinality"("service_interest") > 0) THEN
            CASE
                WHEN "attribution_inherited" THEN 'lead'::"text"
                ELSE 'own'::"text"
            END
            WHEN ("public"."zoho_account_services"("account_id") IS NOT NULL) THEN 'account'::"text"
            ELSE NULL::"text"
        END AS "service_origin"
   FROM "public"."zoho_leads" "l"
  WHERE (("stage" = 'contact'::"text") OR (NOT "is_converted") OR ((NOT (EXISTS ( SELECT 1
           FROM "public"."zoho_leads" "c"
          WHERE (("c"."zoho_record_id" = "l"."converted_contact_id") AND ("c"."stage" = 'contact'::"text"))))) AND (NOT (("email" IS NOT NULL) AND ("btrim"("email") <> ''::"text") AND (( SELECT "count"(*) AS "count"
           FROM "public"."zoho_leads" "c"
          WHERE (("c"."stage" = 'contact'::"text") AND ("lower"("btrim"("c"."email")) = "lower"("btrim"("l"."email"))))) = 1)))));


ALTER VIEW "public"."zoho_leads_unique" OWNER TO "postgres";


COMMENT ON VIEW "public"."zoho_leads_unique" IS 'zoho_leads with converted leads hidden behind the contact they became, plus has_invoices and the resolved attribution pair. Use source_resolved / service_resolved for anything user-facing: lead_source and service_interest are Zoho''s raw Leads-module values and are empty for most contacts. Directory view - use zoho_leads with stage = ''lead'' for funnel counts.';



CREATE TABLE IF NOT EXISTS "public"."zoho_oauth_token" (
    "key" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."zoho_oauth_token" OWNER TO "postgres";


CREATE MATERIALIZED VIEW "public"."zoho_service_labels" AS
 WITH "raw" AS (
         SELECT "btrim"("s"."s") AS "v",
            true AS "from_leads"
           FROM "public"."zoho_leads" "z",
            LATERAL "unnest"("z"."service_interest") "s"("s")
        UNION ALL
         SELECT "btrim"("s"."s") AS "btrim",
            false
           FROM "public"."zoho_accounts" "a",
            LATERAL "unnest"("a"."service_interest") "s"("s")
        UNION ALL
         SELECT "btrim"("i"."department") AS "btrim",
            false
           FROM "public"."invoices" "i"
          WHERE ("i"."department" IS NOT NULL)
        ), "keyed" AS (
         SELECT "public"."zoho_service_key"("r"."v") AS "key",
            "r"."v",
            "r"."from_leads"
           FROM "raw" "r"
          WHERE ("r"."v" <> ''::"text")
        )
 SELECT "key",
    COALESCE("mode"() WITHIN GROUP (ORDER BY "v") FILTER (WHERE "from_leads"), "mode"() WITHIN GROUP (ORDER BY "v")) AS "label",
    "array_agg"(DISTINCT "v" ORDER BY "v") AS "variants"
   FROM "keyed"
  GROUP BY "key"
  WITH NO DATA;


ALTER MATERIALIZED VIEW "public"."zoho_service_labels" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."zoho_tasks" (
    "zoho_task_id" "text" NOT NULL,
    "subject" "text",
    "rep_name" "text",
    "rep_email" "text",
    "status" "text",
    "priority" "text",
    "due_date" "date",
    "created_time" timestamp with time zone,
    "modified_time" timestamp with time zone,
    "closed_time" timestamp with time zone,
    "related_module" "text",
    "related_name" "text",
    "zoho_crm_url" "text",
    "office" "text",
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."zoho_tasks" OWNER TO "postgres";


ALTER TABLE ONLY "public"."excluded_clients" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."excluded_clients_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."excluded_reps" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."excluded_reps_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."objectives_factures" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."objectives_factures_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."rep_objectives" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."rep_objectives_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."rep_objectives_dept" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."rep_objectives_dept_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ad_campaigns"
    ADD CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("platform", "ad_account_id", "campaign_id");



ALTER TABLE ONLY "public"."ad_spend_daily"
    ADD CONSTRAINT "ad_spend_daily_pkey" PRIMARY KEY ("platform", "ad_account_id", "campaign_id", "spend_date");



ALTER TABLE ONLY "public"."allowed_users"
    ADD CONSTRAINT "allowed_users_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."department_mappings"
    ADD CONSTRAINT "department_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."department_mappings"
    ADD CONSTRAINT "department_mappings_zoho_label_key" UNIQUE ("zoho_label");



ALTER TABLE ONLY "public"."excluded_clients"
    ADD CONSTRAINT "excluded_clients_client_name_key" UNIQUE ("client_name");



ALTER TABLE ONLY "public"."excluded_clients"
    ADD CONSTRAINT "excluded_clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."excluded_reps"
    ADD CONSTRAINT "excluded_reps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."excluded_reps"
    ADD CONSTRAINT "excluded_reps_rep_name_key" UNIQUE ("rep_name");



ALTER TABLE ONLY "public"."fiscal_quarters"
    ADD CONSTRAINT "fiscal_quarters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fiscal_quarters"
    ADD CONSTRAINT "fiscal_quarters_year_quarter_key" UNIQUE ("year", "quarter");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("zoho_id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."objectives_factures"
    ADD CONSTRAINT "objectives_factures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."objectives_factures"
    ADD CONSTRAINT "objectives_factures_year_month_department_key" UNIQUE ("year", "month", "department");



ALTER TABLE ONLY "public"."objectives"
    ADD CONSTRAINT "objectives_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."objectives"
    ADD CONSTRAINT "objectives_year_month_department_key" UNIQUE ("year", "month", "department");



ALTER TABLE ONLY "public"."paye_entries"
    ADD CONSTRAINT "paye_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."paye_meta"
    ADD CONSTRAINT "paye_meta_pkey" PRIMARY KEY ("rep_name", "year");



ALTER TABLE ONLY "public"."rep_comm_rates"
    ADD CONSTRAINT "rep_comm_rates_pkey" PRIMARY KEY ("rep_name");



ALTER TABLE ONLY "public"."rep_objectives_dept"
    ADD CONSTRAINT "rep_objectives_dept_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rep_objectives_dept"
    ADD CONSTRAINT "rep_objectives_dept_rep_name_module_year_month_department_key" UNIQUE ("rep_name", "module", "year", "month", "department");



ALTER TABLE ONLY "public"."rep_objectives"
    ADD CONSTRAINT "rep_objectives_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rep_objectives"
    ADD CONSTRAINT "rep_objectives_rep_name_module_year_month_key" UNIQUE ("rep_name", "module", "year", "month");



ALTER TABLE ONLY "public"."reps"
    ADD CONSTRAINT "reps_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."reps"
    ADD CONSTRAINT "reps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_zoho_id_key" UNIQUE ("zoho_id");



ALTER TABLE ONLY "public"."sync_state"
    ADD CONSTRAINT "sync_state_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."webhook_log"
    ADD CONSTRAINT "webhook_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."zoho_accounts"
    ADD CONSTRAINT "zoho_accounts_pkey" PRIMARY KEY ("zoho_account_id");



ALTER TABLE ONLY "public"."zoho_books_customers"
    ADD CONSTRAINT "zoho_books_customers_pkey" PRIMARY KEY ("books_customer_id");



ALTER TABLE ONLY "public"."zoho_books_users"
    ADD CONSTRAINT "zoho_books_users_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."zoho_leads"
    ADD CONSTRAINT "zoho_leads_pkey" PRIMARY KEY ("zoho_record_id");



ALTER TABLE ONLY "public"."zoho_oauth_token"
    ADD CONSTRAINT "zoho_oauth_token_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."zoho_tasks"
    ADD CONSTRAINT "zoho_tasks_pkey" PRIMARY KEY ("zoho_task_id");



CREATE INDEX "ad_spend_daily_date_idx" ON "public"."ad_spend_daily" USING "btree" ("spend_date", "platform");



CREATE INDEX "idx_fiscal_quarters_year" ON "public"."fiscal_quarters" USING "btree" ("year");



CREATE INDEX "idx_objectives_year" ON "public"."objectives" USING "btree" ("year");



CREATE INDEX "idx_sales_date" ON "public"."sales" USING "btree" ("sale_date");



CREATE INDEX "idx_sales_department" ON "public"."sales" USING "btree" ("department");



CREATE INDEX "idx_sales_rep" ON "public"."sales" USING "btree" ("rep_id");



CREATE INDEX "idx_sales_week" ON "public"."sales" USING "btree" ("week_start");



CREATE INDEX "idx_sales_year_month" ON "public"."sales" USING "btree" ("year", "month");



CREATE INDEX "idx_webhook_log_received" ON "public"."webhook_log" USING "btree" ("received_at" DESC);



CREATE INDEX "invoices_books_customer_idx" ON "public"."invoices" USING "btree" ("books_customer_id") WHERE ("books_customer_id" IS NOT NULL);



CREATE INDEX "invoices_created_by_idx" ON "public"."invoices" USING "btree" ("created_by_name") WHERE ("created_by_name" IS NOT NULL);



CREATE INDEX "invoices_crm_account_cover_idx" ON "public"."invoices" USING "btree" ("crm_account_id") INCLUDE ("invoice_date", "amount");



CREATE INDEX "invoices_crm_account_idx" ON "public"."invoices" USING "btree" ("crm_account_id") WHERE ("crm_account_id" IS NOT NULL);



CREATE INDEX "invoices_dept_unmapped_idx" ON "public"."invoices" USING "btree" ("zoho_department_label") WHERE ("department" IS NULL);



CREATE INDEX "invoices_invoice_date_idx" ON "public"."invoices" USING "btree" ("invoice_date");



CREATE INDEX "invoices_office_idx" ON "public"."invoices" USING "btree" ("office");



CREATE INDEX "invoices_rep_name_idx" ON "public"."invoices" USING "btree" ("rep_name");



CREATE INDEX "invoices_status_idx" ON "public"."invoices" USING "btree" ("status");



CREATE INDEX "leads_lead_date_idx" ON "public"."leads" USING "btree" ("lead_date");



CREATE INDEX "leads_rep_name_idx" ON "public"."leads" USING "btree" ("rep_name");



CREATE INDEX "leads_source_idx" ON "public"."leads" USING "btree" ("source");



CREATE INDEX "leads_zoho_cont_idx" ON "public"."leads" USING "btree" ("zoho_contact_id");



CREATE INDEX "leads_zoho_lead_idx" ON "public"."leads" USING "btree" ("zoho_lead_id");



CREATE INDEX "paye_entries_rep_year_idx" ON "public"."paye_entries" USING "btree" ("rep_name", "year", "sort_order");



CREATE INDEX "rep_objectives_rep_name_year_idx" ON "public"."rep_objectives" USING "btree" ("rep_name", "year");



CREATE INDEX "sales_created_by_idx" ON "public"."sales" USING "btree" ("created_by_name") WHERE ("created_by_name" IS NOT NULL);



CREATE INDEX "sales_creator_pending_idx" ON "public"."sales" USING "btree" ("creator_link_status") WHERE ("creator_link_status" = 'pending'::"text");



CREATE INDEX "sales_dept_unmapped_idx" ON "public"."sales" USING "btree" ("zoho_department_label") WHERE ("department" IS NULL);



CREATE INDEX "sales_sale_date_idx" ON "public"."sales" USING "btree" ("sale_date");



CREATE INDEX "sales_year_month_idx" ON "public"."sales" USING "btree" ("year", "month");



CREATE INDEX "zoho_accounts_created_idx" ON "public"."zoho_accounts" USING "btree" ("created_time" DESC);



CREATE INDEX "zoho_accounts_domaine_idx" ON "public"."zoho_accounts" USING "btree" ("domaine_activite");



CREATE INDEX "zoho_accounts_modified_idx" ON "public"."zoho_accounts" USING "btree" ("modified_time");



CREATE INDEX "zoho_accounts_name_trgm_idx" ON "public"."zoho_accounts" USING "gin" ("account_name" "public"."gin_trgm_ops");



CREATE INDEX "zoho_accounts_origine_idx" ON "public"."zoho_accounts" USING "btree" ("origine_du_client");



CREATE INDEX "zoho_accounts_parent_idx" ON "public"."zoho_accounts" USING "btree" ("parent_account_id") WHERE ("parent_account_id" IS NOT NULL);



CREATE INDEX "zoho_accounts_phone_trgm_idx" ON "public"."zoho_accounts" USING "gin" ("phone" "public"."gin_trgm_ops");



CREATE INDEX "zoho_accounts_rating_idx" ON "public"."zoho_accounts" USING "btree" ("rating");



CREATE INDEX "zoho_accounts_rep_idx" ON "public"."zoho_accounts" USING "btree" ("rep_name");



CREATE INDEX "zoho_books_customers_account_idx" ON "public"."zoho_books_customers" USING "btree" ("crm_account_id") WHERE ("crm_account_id" IS NOT NULL);



CREATE INDEX "zoho_books_customers_status_idx" ON "public"."zoho_books_customers" USING "btree" ("link_status") WHERE ("link_status" = ANY (ARRAY['pending'::"text", 'error'::"text"]));



CREATE INDEX "zoho_books_users_email_idx" ON "public"."zoho_books_users" USING "btree" ("lower"("email"));



CREATE INDEX "zoho_leads_account_idx" ON "public"."zoho_leads" USING "btree" ("account_id") WHERE ("account_id" IS NOT NULL);



CREATE INDEX "zoho_leads_contact_email_idx" ON "public"."zoho_leads" USING "btree" ("lower"("btrim"("email"))) WHERE ("stage" = 'contact'::"text");



CREATE INDEX "zoho_leads_conv_contact_idx" ON "public"."zoho_leads" USING "btree" ("converted_contact_id") WHERE ("converted_contact_id" IS NOT NULL);



CREATE INDEX "zoho_leads_created_idx" ON "public"."zoho_leads" USING "btree" ("created_time" DESC);



CREATE INDEX "zoho_leads_email_idx" ON "public"."zoho_leads" USING "btree" ("lower"("email"));



CREATE INDEX "zoho_leads_modified_idx" ON "public"."zoho_leads" USING "btree" ("modified_time" DESC);



CREATE INDEX "zoho_leads_rep_idx" ON "public"."zoho_leads" USING "btree" ("rep_name");



CREATE INDEX "zoho_leads_service_idx" ON "public"."zoho_leads" USING "gin" ("service_interest");



CREATE INDEX "zoho_leads_source_idx" ON "public"."zoho_leads" USING "btree" ("lead_source");



CREATE INDEX "zoho_leads_stage_idx" ON "public"."zoho_leads" USING "btree" ("stage");



CREATE UNIQUE INDEX "zoho_service_labels_key_idx" ON "public"."zoho_service_labels" USING "btree" ("key");



CREATE INDEX "zoho_tasks_closed_idx" ON "public"."zoho_tasks" USING "btree" ("closed_time") WHERE ("closed_time" IS NOT NULL);



CREATE INDEX "zoho_tasks_closed_time_idx" ON "public"."zoho_tasks" USING "btree" ("closed_time");



CREATE INDEX "zoho_tasks_created_idx" ON "public"."zoho_tasks" USING "btree" ("created_time");



CREATE INDEX "zoho_tasks_created_time_idx" ON "public"."zoho_tasks" USING "btree" ("created_time");



CREATE INDEX "zoho_tasks_due_date_idx" ON "public"."zoho_tasks" USING "btree" ("due_date");



CREATE INDEX "zoho_tasks_modified_time_idx" ON "public"."zoho_tasks" USING "btree" ("modified_time");



CREATE INDEX "zoho_tasks_rep_created_idx" ON "public"."zoho_tasks" USING "btree" ("rep_name", "created_time");



CREATE INDEX "zoho_tasks_rep_name_idx" ON "public"."zoho_tasks" USING "btree" ("rep_name");



CREATE INDEX "zoho_tasks_status_idx" ON "public"."zoho_tasks" USING "btree" ("status");



CREATE OR REPLACE TRIGGER "allowed_users_sync_metadata" AFTER INSERT OR UPDATE ON "public"."allowed_users" FOR EACH ROW EXECUTE FUNCTION "public"."sync_allowed_users_to_auth"();



CREATE OR REPLACE TRIGGER "invoices_fill_crm_account_trg" BEFORE INSERT OR UPDATE OF "books_customer_id" ON "public"."invoices" FOR EACH ROW WHEN (("new"."books_customer_id" IS NOT NULL)) EXECUTE FUNCTION "public"."invoices_fill_crm_account"();



CREATE OR REPLACE TRIGGER "preserve_sale_date_trigger" BEFORE UPDATE ON "public"."sales" FOR EACH ROW EXECUTE FUNCTION "public"."preserve_first_sale_date"();



CREATE OR REPLACE TRIGGER "trg_objectives_updated_at" BEFORE UPDATE ON "public"."objectives" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trg_reps_updated_at" BEFORE UPDATE ON "public"."reps" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trg_sales_updated_at" BEFORE UPDATE ON "public"."sales" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "trg_sales_week_boundaries" BEFORE INSERT OR UPDATE OF "sale_date" ON "public"."sales" FOR EACH ROW EXECUTE FUNCTION "public"."compute_week_boundaries"();



CREATE OR REPLACE TRIGGER "zoho_accounts_normalise_service" BEFORE INSERT OR UPDATE OF "service_interest" ON "public"."zoho_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."zoho_normalise_service_interest"();



CREATE OR REPLACE TRIGGER "zoho_books_customers_propagate_trg" AFTER INSERT OR UPDATE OF "crm_account_id", "crm_contact_id" ON "public"."zoho_books_customers" FOR EACH ROW EXECUTE FUNCTION "public"."zoho_books_customers_propagate"();



CREATE OR REPLACE TRIGGER "zoho_leads_inherit_attribution_trg" BEFORE INSERT OR UPDATE ON "public"."zoho_leads" FOR EACH ROW EXECUTE FUNCTION "public"."zoho_leads_inherit_attribution"();



CREATE OR REPLACE TRIGGER "zoho_leads_normalise_service" BEFORE INSERT OR UPDATE OF "service_interest" ON "public"."zoho_leads" FOR EACH ROW EXECUTE FUNCTION "public"."zoho_normalise_service_interest"();



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_rep_id_fkey" FOREIGN KEY ("rep_id") REFERENCES "public"."reps"("id");



CREATE POLICY "Anon write objectives" ON "public"."objectives" TO "authenticated", "anon" USING (true);



CREATE POLICY "Anon write reps" ON "public"."reps" TO "authenticated", "anon" USING (true);



CREATE POLICY "Public read" ON "public"."department_mappings" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Public read" ON "public"."fiscal_quarters" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Public read" ON "public"."objectives" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Public read" ON "public"."reps" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Public read" ON "public"."sales" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Public read" ON "public"."webhook_log" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."ad_campaigns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ad_campaigns_select_admin" ON "public"."ad_campaigns" FOR SELECT TO "authenticated" USING ("public"."app_is_admin"());



ALTER TABLE "public"."ad_spend_daily" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ad_spend_daily_select_admin" ON "public"."ad_spend_daily" FOR SELECT TO "authenticated" USING ("public"."app_is_admin"());



CREATE POLICY "admins can delete users" ON "public"."allowed_users" FOR DELETE TO "authenticated" USING (((("auth"."jwt"() -> 'user_metadata'::"text") ->> 'role'::"text") = 'admin'::"text"));



CREATE POLICY "admins can insert users" ON "public"."allowed_users" FOR INSERT TO "authenticated" WITH CHECK (((("auth"."jwt"() -> 'user_metadata'::"text") ->> 'role'::"text") = 'admin'::"text"));



CREATE POLICY "admins can read all users" ON "public"."allowed_users" FOR SELECT TO "authenticated" USING (((("auth"."jwt"() -> 'user_metadata'::"text") ->> 'role'::"text") = 'admin'::"text"));



CREATE POLICY "admins can update users" ON "public"."allowed_users" FOR UPDATE TO "authenticated" USING (((("auth"."jwt"() -> 'user_metadata'::"text") ->> 'role'::"text") = 'admin'::"text")) WITH CHECK (((("auth"."jwt"() -> 'user_metadata'::"text") ->> 'role'::"text") = 'admin'::"text"));



CREATE POLICY "admins_can_delete_rates" ON "public"."rep_comm_rates" FOR DELETE TO "authenticated" USING (((("auth"."jwt"() -> 'user_metadata'::"text") ->> 'role'::"text") = 'admin'::"text"));



CREATE POLICY "admins_can_insert_rates" ON "public"."rep_comm_rates" FOR INSERT TO "authenticated" WITH CHECK (((("auth"."jwt"() -> 'user_metadata'::"text") ->> 'role'::"text") = 'admin'::"text"));



CREATE POLICY "admins_can_update_rates" ON "public"."rep_comm_rates" FOR UPDATE TO "authenticated" USING (((("auth"."jwt"() -> 'user_metadata'::"text") ->> 'role'::"text") = 'admin'::"text")) WITH CHECK (((("auth"."jwt"() -> 'user_metadata'::"text") ->> 'role'::"text") = 'admin'::"text"));



CREATE POLICY "allow_all_authenticated" ON "public"."rep_objectives_dept" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."allowed_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "authenticated_can_read_rates" ON "public"."rep_comm_rates" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."department_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."excluded_clients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "excluded_clients_all_authenticated" ON "public"."excluded_clients" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."excluded_reps" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "excluded_reps_select_authenticated" ON "public"."excluded_reps" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."fiscal_quarters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoices_select_authenticated" ON "public"."invoices" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."leads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leads_all_authenticated" ON "public"."leads" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "leads_select_authenticated" ON "public"."leads" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."objectives" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."objectives_factures" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "objectives_factures_all_authenticated" ON "public"."objectives_factures" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."paye_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "paye_entries_all_authenticated" ON "public"."paye_entries" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."paye_meta" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "paye_meta_all_authenticated" ON "public"."paye_meta" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."rep_comm_rates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rep_objectives" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rep_objectives_all_authenticated" ON "public"."rep_objectives" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."rep_objectives_dept" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service role full access" ON "public"."allowed_users" TO "service_role" USING (true);



CREATE POLICY "service_role_full_access_rates" ON "public"."rep_comm_rates" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."sync_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users can read own row" ON "public"."allowed_users" FOR SELECT TO "authenticated" USING (("lower"("email") = "lower"(("auth"."jwt"() ->> 'email'::"text"))));



CREATE POLICY "users_can_read_own_row" ON "public"."allowed_users" FOR SELECT TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text")));



ALTER TABLE "public"."webhook_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."zoho_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "zoho_accounts_select_authenticated" ON "public"."zoho_accounts" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."zoho_books_customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "zoho_books_customers_select_authenticated" ON "public"."zoho_books_customers" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."zoho_books_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "zoho_books_users_select_authenticated" ON "public"."zoho_books_users" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."zoho_leads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "zoho_leads_select_authenticated" ON "public"."zoho_leads" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."zoho_oauth_token" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."zoho_tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "zoho_tasks_select_authenticated" ON "public"."zoho_tasks" FOR SELECT TO "authenticated" USING (true);



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."ad_channel_source_map"() TO "anon";
GRANT ALL ON FUNCTION "public"."ad_channel_source_map"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ad_channel_source_map"() TO "service_role";



GRANT ALL ON FUNCTION "public"."ad_channels"() TO "anon";
GRANT ALL ON FUNCTION "public"."ad_channels"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ad_channels"() TO "service_role";



GRANT ALL ON FUNCTION "public"."ad_period"("p_year" integer, "p_month" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."ad_period"("p_year" integer, "p_month" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."ad_period"("p_year" integer, "p_month" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."ad_source_first_used"() TO "anon";
GRANT ALL ON FUNCTION "public"."ad_source_first_used"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ad_source_first_used"() TO "service_role";



GRANT ALL ON FUNCTION "public"."ad_window_ends_on"("p_period_end" "date", "p_months" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."ad_window_ends_on"("p_period_end" "date", "p_months" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."ad_window_ends_on"("p_period_end" "date", "p_months" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."app_is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."app_is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."compute_week_boundaries"() TO "anon";
GRANT ALL ON FUNCTION "public"."compute_week_boundaries"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."compute_week_boundaries"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enqueue_books_customers"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_books_customers"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_account_contacts"("p_account_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_account_contacts"("p_account_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_account_contacts"("p_account_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_account_invoice_totals"("p_account_ids" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_account_invoice_totals"("p_account_ids" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_account_invoice_totals"("p_account_ids" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_account_invoices"("p_account_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_account_invoices"("p_account_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_account_invoices"("p_account_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_account_revenue_by_department"("p_account_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_account_revenue_by_department"("p_account_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_account_revenue_by_department"("p_account_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_ad_campaigns"("p_year" integer, "p_month" integer, "p_platform" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_ad_campaigns"("p_year" integer, "p_month" integer, "p_platform" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ad_campaigns"("p_year" integer, "p_month" integer, "p_platform" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_ad_monthly"("p_year" integer, "p_window_months" integer, "p_exclude_ratings" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_ad_monthly"("p_year" integer, "p_window_months" integer, "p_exclude_ratings" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ad_monthly"("p_year" integer, "p_window_months" integer, "p_exclude_ratings" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_ad_performance"("p_year" integer, "p_month" integer, "p_window_months" integer, "p_exclude_ratings" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_ad_performance"("p_year" integer, "p_month" integer, "p_window_months" integer, "p_exclude_ratings" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ad_performance"("p_year" integer, "p_month" integer, "p_window_months" integer, "p_exclude_ratings" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_ad_spend_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_ad_spend_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ad_spend_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_available_weeks"("p_year" integer, "p_office" "public"."office_enum", "p_status" "public"."sale_status_enum") TO "anon";
GRANT ALL ON FUNCTION "public"."get_available_weeks"("p_year" integer, "p_office" "public"."office_enum", "p_status" "public"."sale_status_enum") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_available_weeks"("p_year" integer, "p_office" "public"."office_enum", "p_status" "public"."sale_status_enum") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_creator_detail"("p_creator" "text", "p_year" integer, "p_month" integer, "p_office" "text", "p_module" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_creator_detail"("p_creator" "text", "p_year" integer, "p_month" integer, "p_office" "text", "p_module" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_creator_detail"("p_creator" "text", "p_year" integer, "p_month" integer, "p_office" "text", "p_module" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_creator_summary"("p_year" integer, "p_month" integer, "p_office" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_creator_summary"("p_year" integer, "p_month" integer, "p_office" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_creator_summary"("p_year" integer, "p_month" integer, "p_office" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_dashboard_kpis"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_dashboard_kpis"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_dashboard_kpis"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_distinct_rep_names"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_distinct_rep_names"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_distinct_rep_names"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_inv_available_weeks"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_inv_available_weeks"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_inv_available_weeks"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_inv_dashboard_kpis"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_inv_dashboard_kpis"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_inv_dashboard_kpis"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_inv_quarterly_yoy"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_inv_quarterly_yoy"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_inv_quarterly_yoy"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_inv_quarterly_yoy_totals"("p_year" integer, "p_office" "text", "p_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_inv_quarterly_yoy_totals"("p_year" integer, "p_office" "text", "p_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_inv_quarterly_yoy_totals"("p_year" integer, "p_office" "text", "p_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_inv_rep_leaderboard"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_inv_rep_leaderboard"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_inv_rep_leaderboard"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_inv_sommaire"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_inv_sommaire"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_inv_sommaire"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_inv_sommaire_grand_total"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_inv_sommaire_grand_total"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_inv_sommaire_grand_total"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_inv_top_clients"("p_year" integer, "p_office" "text", "p_status" "text", "p_limit" integer, "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_inv_top_clients"("p_year" integer, "p_office" "text", "p_status" "text", "p_limit" integer, "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_inv_top_clients"("p_year" integer, "p_office" "text", "p_status" "text", "p_limit" integer, "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_inv_weekly_detail"("p_week_start" "date", "p_office" "text", "p_status" "text", "p_rep" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_inv_weekly_detail"("p_week_start" "date", "p_office" "text", "p_status" "text", "p_rep" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_inv_weekly_detail"("p_week_start" "date", "p_office" "text", "p_status" "text", "p_rep" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_invoice_linkage_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_invoice_linkage_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_invoice_linkage_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_invoice_unassigned_summary"("p_year" integer, "p_office" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_invoice_unassigned_summary"("p_year" integer, "p_office" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_invoice_unassigned_summary"("p_year" integer, "p_office" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_lead_invoice_totals"("p_account_ids" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_lead_invoice_totals"("p_account_ids" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_lead_invoice_totals"("p_account_ids" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_lead_invoices"("p_account_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_lead_invoices"("p_account_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_lead_invoices"("p_account_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_leads_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_leads_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_leads_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_leads_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_leads_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_leads_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_leads_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_leads_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_leads_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_leads_detail"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_leads_detail"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_leads_detail"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_leads_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_leads_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_leads_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_leads_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_leads_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_leads_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_permissions"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_permissions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_permissions"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_quarterly_yoy"("p_year" integer, "p_office" "text", "p_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_quarterly_yoy"("p_year" integer, "p_office" "text", "p_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_quarterly_yoy"("p_year" integer, "p_office" "text", "p_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_quarterly_yoy_totals"("p_year" integer, "p_office" "text", "p_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_quarterly_yoy_totals"("p_year" integer, "p_office" "text", "p_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_quarterly_yoy_totals"("p_year" integer, "p_office" "text", "p_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_quote_creator_link_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_quote_creator_link_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_quote_creator_link_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_rep_dept_actuals_devis"("p_rep" "text", "p_year" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_rep_dept_actuals_devis"("p_rep" "text", "p_year" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_rep_dept_actuals_devis"("p_rep" "text", "p_year" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_rep_dept_actuals_factures"("p_rep" "text", "p_year" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_rep_dept_actuals_factures"("p_rep" "text", "p_year" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_rep_dept_actuals_factures"("p_rep" "text", "p_year" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_rep_leaderboard"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_rep_leaderboard"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_rep_leaderboard"("p_year" integer, "p_office" "text", "p_status" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_sales_team"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_sales_team"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_sales_team"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_sommaire"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_sommaire"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_sommaire"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_sommaire_grand_total"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_sommaire_grand_total"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_sommaire_grand_total"("p_year" integer, "p_office" "text", "p_status" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tasks_available_weeks"("p_year" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_tasks_available_weeks"("p_year" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tasks_available_weeks"("p_year" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tasks_by_rep"("p_year" integer, "p_month" integer, "p_week_start" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_tasks_by_rep"("p_year" integer, "p_month" integer, "p_week_start" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tasks_by_rep"("p_year" integer, "p_month" integer, "p_week_start" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tasks_by_status"("p_rep" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_tasks_by_status"("p_rep" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tasks_by_status"("p_rep" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tasks_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_week_start" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_tasks_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_week_start" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tasks_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_week_start" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tasks_weekly"("p_year" integer, "p_rep" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_tasks_weekly"("p_year" integer, "p_rep" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tasks_weekly"("p_year" integer, "p_rep" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tasks_wow"("p_rep" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_tasks_wow"("p_rep" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tasks_wow"("p_rep" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_top_clients"("p_year" integer, "p_office" "text", "p_status" "text", "p_limit" integer, "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_top_clients"("p_year" integer, "p_office" "text", "p_status" "text", "p_limit" integer, "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_top_clients"("p_year" integer, "p_office" "text", "p_status" "text", "p_limit" integer, "p_month" integer, "p_dept" "text", "p_rep" "text", "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_unassigned_invoices"("p_year" integer, "p_office" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_unassigned_invoices"("p_year" integer, "p_office" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_unassigned_invoices"("p_year" integer, "p_office" "text", "p_month" integer, "p_dept" "text", "p_rep" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_unmapped_department_summary"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_unmapped_department_summary"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_unmapped_department_summary"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_weekly_detail"("p_week_start" "date", "p_office" "text", "p_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_weekly_detail"("p_week_start" "date", "p_office" "text", "p_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_weekly_detail"("p_week_start" "date", "p_office" "text", "p_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_weekly_mandates"("p_week_start" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_weekly_mandates"("p_week_start" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_weekly_mandates"("p_week_start" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_weekly_trend"("p_year" integer, "p_office" "public"."office_enum", "p_status" "public"."sale_status_enum", "p_weeks" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_weekly_trend"("p_year" integer, "p_office" "public"."office_enum", "p_status" "public"."sale_status_enum", "p_weeks" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_weekly_trend"("p_year" integer, "p_office" "public"."office_enum", "p_status" "public"."sale_status_enum", "p_weeks" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_account_filter_options"("p_year" integer, "p_exclude_ratings" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_account_filter_options"("p_year" integer, "p_exclude_ratings" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_account_filter_options"("p_year" integer, "p_exclude_ratings" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_account_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_account_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_account_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_domaine"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_domaine"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_domaine"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_accounts_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_accounts_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_accounts_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_accounts_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_window_months" integer, "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_lead_filter_options"("p_year" integer, "p_stage" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_lead_filter_options"("p_year" integer, "p_stage" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_lead_filter_options"("p_year" integer, "p_stage" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_lead_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_lead_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_lead_kpis"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_leads_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_leads_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_leads_by_rep"("p_year" integer, "p_month" integer, "p_source" "text", "p_service" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_leads_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_leads_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_leads_by_service"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_leads_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_leads_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_leads_by_source"("p_year" integer, "p_month" integer, "p_rep" "text", "p_service" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_zoho_leads_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_zoho_leads_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_zoho_leads_monthly_summary"("p_year" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."invoice_is_internal"("p_client_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."invoice_is_internal"("p_client_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."invoice_is_internal"("p_client_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."invoices_fill_crm_account"() TO "anon";
GRANT ALL ON FUNCTION "public"."invoices_fill_crm_account"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."invoices_fill_crm_account"() TO "service_role";



GRANT ALL ON FUNCTION "public"."preserve_first_sale_date"() TO "anon";
GRANT ALL ON FUNCTION "public"."preserve_first_sale_date"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."preserve_first_sale_date"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_zoho_service_labels"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_zoho_service_labels"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_zoho_service_labels"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_zoho_service_labels"() TO "service_role";



GRANT ALL ON FUNCTION "public"."search_clients"("p_query" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_clients"("p_query" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_clients"("p_query" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_allowed_users_to_auth"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_allowed_users_to_auth"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_allowed_users_to_auth"() TO "service_role";



GRANT ALL ON FUNCTION "public"."tasks_visible_reps"() TO "anon";
GRANT ALL ON FUNCTION "public"."tasks_visible_reps"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tasks_visible_reps"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_account_departments"("p_account_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_account_departments"("p_account_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_account_departments"("p_account_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_account_is_bulk_import"("p_source" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_account_is_bulk_import"("p_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_account_is_bulk_import"("p_source" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_account_services"("p_account_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_account_services"("p_account_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_account_services"("p_account_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_account_source"("p_account_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_account_source"("p_account_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_account_source"("p_account_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_account_window_end"("p_created" timestamp with time zone, "p_months" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_account_window_end"("p_created" timestamp with time zone, "p_months" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_account_window_end"("p_created" timestamp with time zone, "p_months" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_accounts_scoped"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_accounts_scoped"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_accounts_scoped"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text", "p_domaine" "text", "p_region" "text", "p_exclude_ratings" "text"[], "p_reps" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_books_customers_propagate"() TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_books_customers_propagate"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_books_customers_propagate"() TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_internal_ratings"() TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_internal_ratings"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_internal_ratings"() TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_lead_local_date"("p_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_lead_local_date"("p_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_lead_local_date"("p_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_leads_inherit_attribution"() TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_leads_inherit_attribution"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_leads_inherit_attribution"() TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_leads_scoped"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_leads_scoped"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_leads_scoped"("p_year" integer, "p_month" integer, "p_rep" "text", "p_source" "text", "p_service" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_local_date"("p_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_local_date"("p_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_local_date"("p_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_normalise_service_interest"() TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_normalise_service_interest"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_normalise_service_interest"() TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_service_canonical"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_service_canonical"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_service_canonical"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_service_canonical_array"("p_values" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_service_canonical_array"("p_values" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_service_canonical_array"("p_values" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."zoho_service_key"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."zoho_service_key"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."zoho_service_key"("p_value" "text") TO "service_role";



GRANT ALL ON TABLE "public"."ad_campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."ad_campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."ad_spend_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."ad_spend_daily" TO "service_role";



GRANT ALL ON TABLE "public"."allowed_users" TO "authenticated";
GRANT ALL ON TABLE "public"."allowed_users" TO "service_role";



GRANT ALL ON TABLE "public"."department_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."department_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."excluded_clients" TO "authenticated";
GRANT ALL ON TABLE "public"."excluded_clients" TO "service_role";



GRANT ALL ON SEQUENCE "public"."excluded_clients_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."excluded_clients_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."excluded_clients_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."excluded_reps" TO "authenticated";
GRANT ALL ON TABLE "public"."excluded_reps" TO "service_role";



GRANT ALL ON SEQUENCE "public"."excluded_reps_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."excluded_reps_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."excluded_reps_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."fiscal_quarters" TO "authenticated";
GRANT ALL ON TABLE "public"."fiscal_quarters" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."leads" TO "authenticated";
GRANT ALL ON TABLE "public"."leads" TO "service_role";



GRANT ALL ON TABLE "public"."objectives" TO "authenticated";
GRANT ALL ON TABLE "public"."objectives" TO "service_role";



GRANT ALL ON TABLE "public"."objectives_factures" TO "authenticated";
GRANT ALL ON TABLE "public"."objectives_factures" TO "service_role";



GRANT ALL ON SEQUENCE "public"."objectives_factures_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."objectives_factures_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."objectives_factures_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."paye_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."paye_entries" TO "service_role";



GRANT ALL ON TABLE "public"."paye_meta" TO "authenticated";
GRANT ALL ON TABLE "public"."paye_meta" TO "service_role";



GRANT ALL ON TABLE "public"."rep_comm_rates" TO "authenticated";
GRANT ALL ON TABLE "public"."rep_comm_rates" TO "service_role";



GRANT ALL ON TABLE "public"."rep_objectives" TO "authenticated";
GRANT ALL ON TABLE "public"."rep_objectives" TO "service_role";



GRANT ALL ON TABLE "public"."rep_objectives_dept" TO "authenticated";
GRANT ALL ON TABLE "public"."rep_objectives_dept" TO "service_role";



GRANT ALL ON SEQUENCE "public"."rep_objectives_dept_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."rep_objectives_dept_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."rep_objectives_dept_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."rep_objectives_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."rep_objectives_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."rep_objectives_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."reps" TO "authenticated";
GRANT ALL ON TABLE "public"."reps" TO "service_role";



GRANT ALL ON TABLE "public"."sales" TO "authenticated";
GRANT ALL ON TABLE "public"."sales" TO "service_role";



GRANT ALL ON TABLE "public"."sync_state" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_state" TO "service_role";



GRANT ALL ON TABLE "public"."v_inv_weekly_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."v_inv_weekly_summary" TO "service_role";



GRANT ALL ON TABLE "public"."v_monthly_dept_totals" TO "authenticated";
GRANT ALL ON TABLE "public"."v_monthly_dept_totals" TO "service_role";



GRANT ALL ON TABLE "public"."v_monthly_grand_totals" TO "authenticated";
GRANT ALL ON TABLE "public"."v_monthly_grand_totals" TO "service_role";



GRANT ALL ON TABLE "public"."v_monthly_rep_totals" TO "authenticated";
GRANT ALL ON TABLE "public"."v_monthly_rep_totals" TO "service_role";



GRANT ALL ON TABLE "public"."v_quarterly_rep_averages" TO "authenticated";
GRANT ALL ON TABLE "public"."v_quarterly_rep_averages" TO "service_role";



GRANT ALL ON TABLE "public"."v_quarterly_yoy" TO "authenticated";
GRANT ALL ON TABLE "public"."v_quarterly_yoy" TO "service_role";



GRANT ALL ON TABLE "public"."v_sommaire" TO "authenticated";
GRANT ALL ON TABLE "public"."v_sommaire" TO "service_role";



GRANT ALL ON TABLE "public"."v_sommaire_grand_total" TO "authenticated";
GRANT ALL ON TABLE "public"."v_sommaire_grand_total" TO "service_role";



GRANT ALL ON TABLE "public"."v_weekly_dept_totals" TO "authenticated";
GRANT ALL ON TABLE "public"."v_weekly_dept_totals" TO "service_role";



GRANT ALL ON TABLE "public"."v_weekly_grand_totals" TO "authenticated";
GRANT ALL ON TABLE "public"."v_weekly_grand_totals" TO "service_role";



GRANT ALL ON TABLE "public"."v_weekly_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."v_weekly_summary" TO "service_role";



GRANT ALL ON TABLE "public"."webhook_log" TO "authenticated";
GRANT ALL ON TABLE "public"."webhook_log" TO "service_role";



GRANT ALL ON TABLE "public"."zoho_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."zoho_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."zoho_accounts_enriched" TO "authenticated";
GRANT ALL ON TABLE "public"."zoho_accounts_enriched" TO "service_role";



GRANT ALL ON TABLE "public"."zoho_books_customers" TO "authenticated";
GRANT ALL ON TABLE "public"."zoho_books_customers" TO "service_role";



GRANT ALL ON TABLE "public"."zoho_books_users" TO "authenticated";
GRANT ALL ON TABLE "public"."zoho_books_users" TO "service_role";



GRANT ALL ON TABLE "public"."zoho_leads" TO "authenticated";
GRANT ALL ON TABLE "public"."zoho_leads" TO "service_role";



GRANT ALL ON TABLE "public"."zoho_leads_unique" TO "authenticated";
GRANT ALL ON TABLE "public"."zoho_leads_unique" TO "service_role";



GRANT ALL ON TABLE "public"."zoho_oauth_token" TO "service_role";



GRANT ALL ON TABLE "public"."zoho_service_labels" TO "authenticated";
GRANT ALL ON TABLE "public"."zoho_service_labels" TO "service_role";



GRANT ALL ON TABLE "public"."zoho_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."zoho_tasks" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







