-- Multi-select filters: the dashboards can filter on several values at once.
--
-- Every category filter with more than two values (representative, department,
-- invoice status, source, service, domain, region) becomes a list. Each RPC
-- gains an array parameter beside the scalar one it already had:
--
--     p_dept    -> p_depts       p_source  -> p_sources    p_domaine -> p_domaines
--     p_status  -> p_statuses    p_service -> p_services   p_region  -> p_regions
--     p_rep     -> p_reps (already there on most; added where it was missing)
--
-- The scalar parameters are kept and behave exactly as before, so a caller that
-- has not been updated - the previous frontend build, the weekly report
-- functions - gets the same rows. An array is one more AND: NULL means "no
-- filter", and the two forms can be combined.
--
-- Objectives follow the selection (numerator and denominator narrowed on the
-- same dimension):
--
--   * several departments  -> the company objective of those departments;
--   * several reps         -> p_target_reps, the sum of those reps' own
--                             objectives. The caller passes it only when every
--                             selected rep is on the sales team; a selection
--                             that includes "Interne" has no objective, exactly
--                             as "Interne" alone has none today.
--
-- A breakdown still leaves its own dimension unfiltered (get_zoho_accounts_by_
-- source ignores the source selection, and so on), in both forms.
--
-- Parameters are appended, never reordered, so positional callers keep working.
-- Adding a parameter changes a function's identity, hence DROP + CREATE rather
-- than CREATE OR REPLACE: leaving the old signature in place would give
-- PostgREST two candidates for the same call. SQL function bodies are text, not
-- dependencies, so dropping a helper its callers still name is allowed.
--
-- Bodies are pg_get_functiondef output from the live database with the new
-- predicates as the only change; each was checked against the previous
-- definition on a copy of production (scalar calls unchanged, a one-value list
-- equal to the scalar, a two-value list equal to the sum of its two singles).
--
-- zoho_accounts_scoped and zoho_leads_scoped stay SECURITY INVOKER with no SET
-- clause, so the planner still inlines them (CLAUDE.md, performance rule 1).

-- ─── Devis ─────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_dashboard_kpis(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text, p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_dashboard_kpis(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_depts text[] DEFAULT NULL::text[], p_target_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(ytd_total numeric, ytd_count bigint, avg_deal_size numeric, annual_target numeric, pct_of_target numeric, invoiced_total numeric, accepted_total numeric)
 LANGUAGE sql
 STABLE
AS $function$
  WITH filtered_sales AS (
    SELECT amount, status FROM sales
    WHERE EXTRACT(year FROM sale_date::date) = p_year
      AND status::text IN ('accepted','invoiced')
      AND (p_office IS NULL OR office::text = p_office)
      AND (p_status IS NULL OR status::text = p_status)
      AND (p_month  IS NULL OR EXTRACT(month FROM sale_date::date) = p_month)
      AND (p_dept   IS NULL OR department::text = p_dept)
      AND (p_depts  IS NULL OR department::text = ANY(p_depts))
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
        AND p_reps IS NULL
        AND p_rep IS NOT NULL AND rep_name = p_rep AND module = 'devis' AND year = p_year
        AND (p_month IS NULL OR month = p_month)
      UNION ALL
      -- Several reps, all on the sales team: the sum of their own objectives.
      SELECT target_amount AS o_target FROM rep_objectives
      WHERE p_office IS NULL
        AND p_target_reps IS NOT NULL AND rep_name = ANY(p_target_reps) AND module = 'devis' AND year = p_year
        AND (p_month IS NULL OR month = p_month)
      UNION ALL
      SELECT target_amount AS o_target FROM objectives
      WHERE p_office IS NULL
        AND p_reps IS NULL
        AND p_rep IS NULL AND year = p_year
        AND (p_month IS NULL OR month = p_month)
        AND (p_dept IS NULL OR department::text = p_dept)
        AND (p_depts IS NULL OR department::text = ANY(p_depts))
    ) combined
  )
  SELECT agg.ytd_total, agg.ytd_count, agg.avg_deal_size, obj.annual_target,
    CASE WHEN obj.annual_target=0 THEN 0
         ELSE ROUND((agg.ytd_total/obj.annual_target*100)::numeric,1) END,
    agg.invoiced_total, agg.accepted_total
  FROM agg, obj;
$function$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_kpis(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text, p_reps text[], p_depts text[], p_target_reps text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_sommaire_grand_total(p_year integer, p_office text, p_status text, p_rep text, p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_sommaire_grand_total(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_target_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(month integer, objectif numeric, actual_amount numeric, pct_atteint numeric, deal_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o_month, SUM(o_target) AS o_total
    FROM (
      SELECT ro.month AS o_month, ro.target_amount AS o_target FROM rep_objectives ro
      WHERE p_office IS NULL
        AND p_reps IS NULL
        AND p_rep IS NOT NULL AND ro.rep_name = p_rep AND ro.module = 'devis' AND ro.year = p_year
      UNION ALL
      -- Several reps, all on the sales team: the sum of their own objectives.
      SELECT ro.month AS o_month, ro.target_amount AS o_target FROM rep_objectives ro
      WHERE p_office IS NULL
        AND p_target_reps IS NOT NULL AND ro.rep_name = ANY(p_target_reps) AND ro.module = 'devis' AND ro.year = p_year
      UNION ALL
      SELECT od.month AS o_month, od.target_amount AS o_target FROM objectives od
      WHERE p_office IS NULL
        AND p_reps IS NULL
        AND p_rep IS NULL AND od.year = p_year
    ) combined GROUP BY o_month
  ),
  sales_agg AS (
    SELECT s.month AS s_month,
      COALESCE(SUM(s.amount), 0) AS s_total, COUNT(*)::bigint AS s_count
    FROM sales s
    WHERE s.year = p_year
      AND s.status::text IN ('accepted','invoiced')
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_sommaire_grand_total(p_year integer, p_office text, p_status text, p_rep text, p_reps text[], p_target_reps text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_top_clients(p_year integer, p_office text, p_status text, p_limit integer, p_month integer, p_dept text, p_rep text, p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_top_clients(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_depts text[] DEFAULT NULL::text[])
 RETURNS TABLE(client_name text, total_amount numeric, deal_count bigint, office text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT s.client_name, SUM(s.amount)::numeric, COUNT(*), COALESCE(MAX(s.office::text), p_office)
  FROM sales s
  WHERE EXTRACT(year FROM sale_date::date) = p_year
    AND s.status::text IN ('accepted','invoiced')
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND (p_month  IS NULL OR EXTRACT(month FROM sale_date::date) = p_month)
    AND (p_dept   IS NULL OR s.department::text = p_dept)
    AND (p_depts  IS NULL OR s.department::text = ANY(p_depts))
    AND (p_rep    IS NULL OR s.rep_name = p_rep)
    AND (p_reps   IS NULL OR s.rep_name = ANY(p_reps))
    AND s.client_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (s.rep_name IS NULL OR p_reps IS NOT NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  GROUP BY s.client_name ORDER BY 2 DESC LIMIT p_limit;
$function$;

GRANT EXECUTE ON FUNCTION public.get_top_clients(p_year integer, p_office text, p_status text, p_limit integer, p_month integer, p_dept text, p_rep text, p_reps text[], p_depts text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_rep_leaderboard(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text, p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_rep_leaderboard(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_depts text[] DEFAULT NULL::text[])
 RETURNS TABLE(rep_name text, office text, total_amount numeric, deal_count bigint, avg_deal numeric, rank bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH base AS (
    SELECT s.rep_name, MAX(s.office::text) AS office,
      SUM(s.amount)::numeric AS total_amount, COUNT(*) AS deal_count, AVG(s.amount)::numeric AS avg_deal
    FROM sales s
    WHERE EXTRACT(year FROM s.sale_date::date) = p_year
      AND s.status::text IN ('accepted','invoiced')
      AND (p_office IS NULL OR s.office::text = p_office)
      AND (p_status IS NULL OR s.status::text = p_status)
      AND (p_month  IS NULL OR EXTRACT(month FROM s.sale_date::date) = p_month)
      AND (p_dept   IS NULL OR s.department::text = p_dept)
      AND (p_depts  IS NULL OR s.department::text = ANY(p_depts))
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_rep_leaderboard(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text, p_reps text[], p_depts text[]) TO authenticated, service_role;

-- ─── Factures ──────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_inv_dashboard_kpis(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text, p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_inv_dashboard_kpis(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_statuses text[] DEFAULT NULL::text[], p_depts text[] DEFAULT NULL::text[], p_target_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(ytd_total numeric, ytd_count bigint, avg_deal_size numeric, annual_target numeric, pct_of_target numeric, paid_total numeric, partial_total numeric, avoir_total numeric)
 LANGUAGE sql
AS $function$
  WITH filtered AS (
    SELECT amount, status, is_avoir FROM invoices
    WHERE EXTRACT(year FROM invoice_date)::int = p_year
      AND (CASE WHEN p_status IS NULL THEN status::text NOT IN ('void')
                ELSE status::text = p_status END)
      AND (p_statuses IS NULL OR status::text = ANY(p_statuses))
      AND (p_office IS NULL OR office::text = p_office)
      AND (p_month  IS NULL OR EXTRACT(month FROM invoice_date)::int = p_month)
      AND (p_dept   IS NULL OR department::text = p_dept)
      AND (p_depts  IS NULL OR department::text = ANY(p_depts))
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
        AND p_reps IS NULL
        AND p_rep IS NOT NULL AND rep_name=p_rep AND module='factures' AND year=p_year
        AND (p_month IS NULL OR month=p_month)
      UNION ALL
      -- Several reps, all on the sales team: the sum of their own objectives.
      SELECT target_amount AS o_target FROM rep_objectives
      WHERE p_office IS NULL
        AND p_target_reps IS NOT NULL AND rep_name = ANY(p_target_reps) AND module='factures' AND year=p_year
        AND (p_month IS NULL OR month=p_month)
      UNION ALL
      SELECT target_amount AS o_target FROM objectives_factures
      WHERE p_office IS NULL
        AND p_reps IS NULL
        AND p_rep IS NULL AND year=p_year
        AND (p_month IS NULL OR month=p_month)
        AND (p_dept IS NULL OR department::text=p_dept)
        AND (p_depts IS NULL OR department::text = ANY(p_depts))
    ) combined
  )
  SELECT agg.ytd_total, agg.ytd_count, agg.avg_deal_size, obj.annual_target,
    CASE WHEN obj.annual_target=0 THEN 0
         ELSE ROUND((agg.ytd_total/obj.annual_target*100)::numeric,1) END,
    agg.paid_total, agg.partial_total, agg.avoir_total
  FROM agg, obj;
$function$;

GRANT EXECUTE ON FUNCTION public.get_inv_dashboard_kpis(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text, p_reps text[], p_statuses text[], p_depts text[], p_target_reps text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_inv_top_clients(p_year integer, p_office text, p_status text, p_limit integer, p_month integer, p_dept text, p_rep text, p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_inv_top_clients(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_statuses text[] DEFAULT NULL::text[], p_depts text[] DEFAULT NULL::text[])
 RETURNS TABLE(client_name text, total_amount numeric, deal_count bigint, office text)
 LANGUAGE sql
AS $function$
  SELECT i.client_name,
    SUM(i.amount)::numeric                          AS total_amount,
    COUNT(*) FILTER (WHERE NOT i.is_avoir)::bigint  AS deal_count,
    COALESCE(MAX(i.office::text), p_office)
  FROM invoices i
  WHERE EXTRACT(year FROM i.invoice_date)::int = p_year
    AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
              ELSE i.status::text = p_status END)
    AND (p_statuses IS NULL OR i.status::text = ANY(p_statuses))
    AND (p_office IS NULL OR i.office::text = p_office)
    AND (p_month  IS NULL OR EXTRACT(month FROM i.invoice_date)::int = p_month)
    AND (p_dept   IS NULL OR i.department::text = p_dept)
    AND (p_depts  IS NULL OR i.department::text = ANY(p_depts))
    AND (p_rep    IS NULL OR i.rep_name = p_rep)
      AND (p_reps IS NULL OR i.rep_name = ANY(p_reps))
    AND i.client_name IS NOT NULL
    AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (i.rep_name IS NULL OR p_reps IS NOT NULL OR i.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  GROUP BY i.client_name HAVING SUM(i.amount) > 0
  ORDER BY 2 DESC LIMIT p_limit;
$function$;

GRANT EXECUTE ON FUNCTION public.get_inv_top_clients(p_year integer, p_office text, p_status text, p_limit integer, p_month integer, p_dept text, p_rep text, p_reps text[], p_statuses text[], p_depts text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_inv_rep_leaderboard(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text, p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_inv_rep_leaderboard(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_statuses text[] DEFAULT NULL::text[], p_depts text[] DEFAULT NULL::text[])
 RETURNS TABLE(rep_name text, office text, total_amount numeric, deal_count bigint, avg_deal numeric, rank bigint)
 LANGUAGE sql
AS $function$
  WITH base AS (
    SELECT i.rep_name, MAX(i.office::text) AS office,
      SUM(i.amount)::numeric                               AS total_amount,
      COUNT(*) FILTER (WHERE NOT i.is_avoir)::bigint       AS deal_count,
      AVG(i.amount) FILTER (WHERE NOT i.is_avoir)::numeric AS avg_deal
    FROM invoices i
    WHERE EXTRACT(year FROM i.invoice_date)::int = p_year
      AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
                ELSE i.status::text = p_status END)
      AND (p_statuses IS NULL OR i.status::text = ANY(p_statuses))
      AND (p_office IS NULL OR i.office::text = p_office)
      AND (p_month  IS NULL OR EXTRACT(month FROM i.invoice_date)::int = p_month)
      AND (p_dept   IS NULL OR i.department::text = p_dept)
      AND (p_depts  IS NULL OR i.department::text = ANY(p_depts))
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_inv_rep_leaderboard(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text, p_reps text[], p_statuses text[], p_depts text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_inv_sommaire(p_year integer, p_office text, p_status text, p_rep text, p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_inv_sommaire(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_statuses text[] DEFAULT NULL::text[])
 RETURNS TABLE(month integer, department text, objectif numeric, actual_amount numeric, pct_atteint numeric, deal_count bigint)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o.month AS o_month, o.department AS o_dept, o.target_amount AS o_total
    FROM objectives_factures o
    WHERE o.year = p_year
      AND p_office IS NULL
      AND p_reps IS NULL
  ),
  inv_agg AS (
    SELECT EXTRACT(month FROM i.invoice_date)::int AS i_month,
      i.department AS i_dept,
      COALESCE(SUM(i.amount),0)::numeric AS i_total,
      COUNT(*) FILTER (WHERE NOT i.is_avoir)::bigint AS i_count
    FROM invoices i
    WHERE EXTRACT(year FROM i.invoice_date)::int = p_year
      AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
                ELSE i.status::text = p_status END)
      AND (p_statuses IS NULL OR i.status::text = ANY(p_statuses))
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_inv_sommaire(p_year integer, p_office text, p_status text, p_rep text, p_reps text[], p_statuses text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_inv_sommaire_grand_total(p_year integer, p_office text, p_status text, p_rep text, p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_inv_sommaire_grand_total(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_statuses text[] DEFAULT NULL::text[], p_target_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(month integer, objectif numeric, actual_amount numeric, pct_atteint numeric, deal_count bigint)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o_month, SUM(o_target)::numeric AS o_total
    FROM (
      SELECT ro.month AS o_month, ro.target_amount AS o_target FROM rep_objectives ro
      WHERE p_office IS NULL
        AND p_reps IS NULL
        AND p_rep IS NOT NULL AND ro.rep_name=p_rep AND ro.module='factures' AND ro.year=p_year
      UNION ALL
      -- Several reps, all on the sales team: the sum of their own objectives.
      SELECT ro.month AS o_month, ro.target_amount AS o_target FROM rep_objectives ro
      WHERE p_office IS NULL
        AND p_target_reps IS NOT NULL AND ro.rep_name = ANY(p_target_reps) AND ro.module='factures' AND ro.year=p_year
      UNION ALL
      SELECT of2.month AS o_month, of2.target_amount AS o_target FROM objectives_factures of2
      WHERE p_office IS NULL
        AND p_reps IS NULL
        AND p_rep IS NULL AND of2.year=p_year
    ) combined GROUP BY o_month
  ),
  inv_agg AS (
    SELECT EXTRACT(month FROM i.invoice_date)::int AS i_month,
      COALESCE(SUM(i.amount),0)::numeric AS i_total,
      COUNT(*) FILTER (WHERE NOT i.is_avoir)::bigint AS i_count
    FROM invoices i
    WHERE EXTRACT(year FROM i.invoice_date)::int = p_year
      AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
                ELSE i.status::text = p_status END)
      AND (p_statuses IS NULL OR i.status::text = ANY(p_statuses))
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_inv_sommaire_grand_total(p_year integer, p_office text, p_status text, p_rep text, p_reps text[], p_statuses text[], p_target_reps text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_invoice_unassigned_summary(p_year integer, p_office text, p_month integer, p_dept text, p_rep text, p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_invoice_unassigned_summary(p_year integer DEFAULT NULL::integer, p_office text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_depts text[] DEFAULT NULL::text[])
 RETURNS TABLE(unassigned_count bigint, unassigned_amount numeric, internal_count bigint, internal_amount numeric, assigned_amount numeric, total_count bigint, total_amount numeric, unassigned_share numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT i.amount, i.crm_account_id, invoice_is_internal(i.client_name) AS internal
      FROM invoices i
     WHERE (p_year   IS NULL OR EXTRACT(YEAR  FROM i.invoice_date)::INT = p_year)
       AND (p_month  IS NULL OR EXTRACT(MONTH FROM i.invoice_date)::INT = p_month)
       AND (p_office IS NULL OR i.office     = p_office)
       AND (p_dept   IS NULL OR i.department = p_dept)
       AND (p_depts  IS NULL OR i.department = ANY(p_depts))
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_invoice_unassigned_summary(p_year integer, p_office text, p_month integer, p_dept text, p_rep text, p_reps text[], p_depts text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_unassigned_invoices(p_year integer, p_office text, p_month integer, p_dept text, p_rep text, p_limit integer);

CREATE OR REPLACE FUNCTION public.get_unassigned_invoices(p_year integer DEFAULT NULL::integer, p_office text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_limit integer DEFAULT 500, p_depts text[] DEFAULT NULL::text[], p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(zoho_id text, invoice_number text, client_name text, amount numeric, invoice_date date, status text, is_avoir boolean, department text, office text, rep_name text, reason text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
    AND (p_depts  IS NULL OR i.department = ANY(p_depts))
    AND (p_rep    IS NULL OR i.rep_name   = p_rep)
    AND (p_reps   IS NULL OR i.rep_name   = ANY(p_reps))
  ORDER BY abs(i.amount) DESC, i.invoice_date DESC
  LIMIT p_limit;
$function$;

GRANT EXECUTE ON FUNCTION public.get_unassigned_invoices(p_year integer, p_office text, p_month integer, p_dept text, p_rep text, p_limit integer, p_depts text[], p_reps text[]) TO authenticated, service_role;

-- ─── Comptes ───────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.zoho_accounts_scoped(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_exclude_ratings text[], p_reps text[]);

CREATE OR REPLACE FUNCTION public.zoho_accounts_scoped(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[])
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
    AND (p_sources IS NULL OR a.origine_du_client = ANY(p_sources))
    AND (p_domaine IS NULL OR a.domaine_activite  = p_domaine)
    AND (p_domaines IS NULL OR a.domaine_activite = ANY(p_domaines))
    AND (p_region  IS NULL OR a.region_administrative = p_region)
    AND (p_regions IS NULL OR a.region_administrative = ANY(p_regions))
    -- Case- and space-insensitive, like the leads side: Zoho's service picklist
    -- holds the same service under several spellings and an exact @> match
    -- silently drops all but one.
    AND (p_service IS NULL OR EXISTS (
          SELECT 1 FROM unnest(a.service_interest) AS v
           WHERE public.zoho_service_key(v) = public.zoho_service_key(p_service)
        ))
    -- Any of the selected services, folded the same way.
    AND (p_services IS NULL OR EXISTS (
          SELECT 1 FROM unnest(a.service_interest) AS v
           WHERE public.zoho_service_key(v) IN (
                   SELECT public.zoho_service_key(w) FROM unnest(p_services) AS w)
        ))
    -- NULL means "no exclusions" so a caller can ask for the unfiltered book;
    -- omitting the argument gets the dashboard's default instead. An account with
    -- no rating at all (977 of them) is never excluded by this.
    AND (p_exclude_ratings IS NULL
         OR a.rating IS NULL
         OR NOT (a.rating = ANY(p_exclude_ratings)));
$function$;

GRANT EXECUTE ON FUNCTION public.zoho_accounts_scoped(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_account_kpis(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_account_kpis(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[])
 RETURNS TABLE(accounts_created bigint, accounts_invoiced bigint, invoiced_rate numeric, revenue_attributed numeric, revenue_lifetime numeric, revenue_per_account numeric, avg_days_to_first_invoice numeric, ventes_royer numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, p_services, p_domaines, p_regions)
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

GRANT EXECUTE ON FUNCTION public.get_zoho_account_kpis(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_rep(p_year integer, p_month integer, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_rep(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, NULL, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, p_services, p_domaines, p_regions)
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

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_rep(p_year integer, p_month integer, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_source(p_year integer, p_month integer, p_rep text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_source(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, NULL, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      NULL, p_services, p_domaines, p_regions)
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

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_source(p_year integer, p_month integer, p_rep text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_services text[], p_domaines text[], p_regions text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_service(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, NULL, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, NULL, p_domaines, p_regions)
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

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_domaines text[], p_regions text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_domaine(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_domaine(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, p_service, NULL, p_region, p_exclude_ratings, p_reps,
      p_sources, p_services, NULL, p_regions)
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

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_domaine(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_regions text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_monthly_summary(p_year integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_monthly_summary(p_year integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[])
 RETURNS TABLE(month integer, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, NULL, p_rep, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, p_services, p_domaines, p_regions)
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

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_monthly_summary(p_year integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]) TO authenticated, service_role;

-- ─── Tâches ────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_tasks_kpis(p_year integer, p_month integer, p_rep text, p_week_start date);

CREATE OR REPLACE FUNCTION public.get_tasks_kpis(p_year integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_week_start date DEFAULT NULL::date, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(total_created bigint, total_completed bigint, completion_rate numeric, cohort_rate numeric, total_touched bigint, total_open bigint, total_overdue bigint, active_reps bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH b AS (
    SELECT
      (CASE WHEN p_week_start IS NOT NULL THEN p_week_start::timestamp
            ELSE make_date(p_year, COALESCE(p_month, 1), 1)::timestamp END)
        AT TIME ZONE 'America/Toronto' AS lo,
      (CASE WHEN p_week_start IS NOT NULL THEN (p_week_start + 7)::timestamp
            WHEN p_month IS NULL THEN make_date(p_year + 1, 1, 1)::timestamp
            ELSE (make_date(p_year, p_month, 1) + INTERVAL '1 month')::timestamp END)
        AT TIME ZONE 'America/Toronto' AS hi,
      (now() AT TIME ZONE 'America/Toronto')::date AS today
  )
  SELECT
    COUNT(*) FILTER (WHERE in_created)   AS total_created,
    COUNT(*) FILTER (WHERE in_completed) AS total_completed,
    -- Throughput: closed in period / created in period. Different cohorts, so
    -- >100% is meaningful (backlog cleared) rather than an error.
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_completed) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS completion_rate,
    -- One cohort: of what was created in the period, how much is now finished.
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_created AND closed_time IS NOT NULL) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS cohort_rate,
    COUNT(*) FILTER (WHERE in_touched)   AS total_touched,
    COUNT(*) FILTER (WHERE closed_time IS NULL) AS total_open,
    COUNT(*) FILTER (WHERE closed_time IS NULL AND due_date IS NOT NULL AND due_date < today) AS total_overdue,
    COUNT(DISTINCT rep_name) FILTER (WHERE in_created OR in_touched) AS active_reps
  FROM (
    SELECT t.rep_name, t.closed_time, t.due_date, b.today,
      (t.created_time  >= b.lo AND t.created_time  < b.hi) AS in_created,
      (t.closed_time IS NOT NULL
         AND t.closed_time >= b.lo AND t.closed_time < b.hi) AS in_completed,
      (t.modified_time >= b.lo AND t.modified_time < b.hi) AS in_touched
    FROM zoho_tasks t, b
    WHERE t.rep_name IN (SELECT tasks_visible_reps()) AND (p_rep IS NULL OR t.rep_name = p_rep)
      AND (p_reps IS NULL OR t.rep_name = ANY(p_reps))
  ) t
$function$;

GRANT EXECUTE ON FUNCTION public.get_tasks_kpis(p_year integer, p_month integer, p_rep text, p_week_start date, p_reps text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_tasks_by_status(p_rep text);

CREATE OR REPLACE FUNCTION public.get_tasks_by_status(p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(status text, nb bigint)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT COALESCE(status, 'Non défini') AS status, COUNT(*) AS nb
  FROM zoho_tasks
  WHERE closed_time IS NULL AND rep_name IN (SELECT tasks_visible_reps())
    AND (p_rep IS NULL OR rep_name = p_rep)
    AND (p_reps IS NULL OR rep_name = ANY(p_reps))
  GROUP BY COALESCE(status, 'Non défini')
  ORDER BY nb DESC
$function$;

GRANT EXECUTE ON FUNCTION public.get_tasks_by_status(p_rep text, p_reps text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_tasks_weekly(p_year integer, p_rep text);

CREATE OR REPLACE FUNCTION public.get_tasks_weekly(p_year integer, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(week_start date, nb_created bigint, nb_completed bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH b AS (
    SELECT date_trunc('week', make_date(p_year,     1, 4))::timestamp
             AT TIME ZONE 'America/Toronto' AS lo,
           date_trunc('week', make_date(p_year + 1, 1, 4))::timestamp
             AT TIME ZONE 'America/Toronto' AS hi
  ),
  visible AS (SELECT tasks_visible_reps() AS rep_name),
  c AS (
    SELECT date_trunc('week', t.created_time AT TIME ZONE 'America/Toronto')::date AS ws, COUNT(*) AS nb
    FROM zoho_tasks t, b
    WHERE t.rep_name IN (SELECT rep_name FROM visible)
      AND t.created_time >= b.lo AND t.created_time < b.hi
      AND (p_rep IS NULL OR t.rep_name = p_rep)
      AND (p_reps IS NULL OR t.rep_name = ANY(p_reps))
    GROUP BY 1
  ),
  d AS (
    SELECT date_trunc('week', t.closed_time AT TIME ZONE 'America/Toronto')::date AS ws, COUNT(*) AS nb
    FROM zoho_tasks t, b
    WHERE t.rep_name IN (SELECT rep_name FROM visible)
      AND t.closed_time IS NOT NULL
      AND t.closed_time >= b.lo AND t.closed_time < b.hi
      AND (p_rep IS NULL OR t.rep_name = p_rep)
      AND (p_reps IS NULL OR t.rep_name = ANY(p_reps))
    GROUP BY 1
  )
  SELECT COALESCE(c.ws, d.ws) AS week_start,
         COALESCE(c.nb, 0)    AS nb_created,
         COALESCE(d.nb, 0)    AS nb_completed
  FROM c FULL OUTER JOIN d ON c.ws = d.ws
  ORDER BY week_start
$function$;

GRANT EXECUTE ON FUNCTION public.get_tasks_weekly(p_year integer, p_rep text, p_reps text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_tasks_wow(p_rep text);

CREATE OR REPLACE FUNCTION public.get_tasks_wow(p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(rep_name text, created_this_week bigint, created_last_week bigint, completed_this_week bigint, completed_last_week bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH w AS (
    SELECT
      this_monday_local AT TIME ZONE 'America/Toronto' AS this_monday,
      last_monday_local AT TIME ZONE 'America/Toronto' AS last_monday,
      -- Same weekday and time last week, so a Tuesday is compared with a Tuesday
      -- instead of with somebody's whole previous week.
      (last_monday_local + elapsed) AT TIME ZONE 'America/Toronto' AS last_cutoff
    FROM (
      SELECT date_trunc('week', local_now) AS this_monday_local,
             date_trunc('week', local_now) - INTERVAL '7 days' AS last_monday_local,
             local_now - date_trunc('week', local_now) AS elapsed
      FROM (SELECT now() AT TIME ZONE 'America/Toronto' AS local_now) n
    ) m
  )
  SELECT t.rep_name,
    COUNT(*) FILTER (WHERE t.created_time >= w.this_monday) AS created_this_week,
    COUNT(*) FILTER (WHERE t.created_time >= w.last_monday AND t.created_time < w.last_cutoff) AS created_last_week,
    COUNT(*) FILTER (WHERE t.closed_time IS NOT NULL AND t.closed_time >= w.this_monday) AS completed_this_week,
    COUNT(*) FILTER (WHERE t.closed_time IS NOT NULL AND t.closed_time >= w.last_monday AND t.closed_time < w.last_cutoff) AS completed_last_week
  FROM zoho_tasks t
  CROSS JOIN w
  WHERE t.rep_name IN (SELECT tasks_visible_reps())
    AND (p_rep IS NULL OR t.rep_name = p_rep)
    AND (p_reps IS NULL OR t.rep_name = ANY(p_reps))
    AND (t.created_time >= w.last_monday
         OR (t.closed_time IS NOT NULL AND t.closed_time >= w.last_monday))
  GROUP BY t.rep_name, w.this_monday, w.last_monday, w.last_cutoff
  ORDER BY completed_this_week DESC, created_this_week DESC
$function$;

GRANT EXECUTE ON FUNCTION public.get_tasks_wow(p_rep text, p_reps text[]) TO authenticated, service_role;

-- ─── Leads ─────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.zoho_leads_scoped(p_year integer, p_month integer, p_rep text, p_source text, p_service text);

CREATE OR REPLACE FUNCTION public.zoho_leads_scoped(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[])
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
     AND (p_reps    IS NULL OR z.rep_name    = ANY(p_reps))
     AND (p_source  IS NULL OR z.lead_source = p_source)
     AND (p_sources IS NULL OR z.lead_source = ANY(p_sources))
     -- Case-insensitive: Zoho's multi-select holds both "Distribution publicitaire"
     -- and "Distribution Publicitaire" (2,043 vs 166 leads). An exact @> match
     -- would silently drop one spelling.
     AND (p_service IS NULL OR EXISTS (
           SELECT 1 FROM unnest(z.service_interest) AS v
            WHERE public.zoho_service_key(v) = public.zoho_service_key(p_service)
         ))
     -- Any of the selected services, folded the same way.
     AND (p_services IS NULL OR EXISTS (
           SELECT 1 FROM unnest(z.service_interest) AS v
            WHERE public.zoho_service_key(v) IN (
                    SELECT public.zoho_service_key(w) FROM unnest(p_services) AS w)
         ));
$function$;

GRANT EXECUTE ON FUNCTION public.zoho_leads_scoped(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_reps text[], p_sources text[], p_services text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_lead_kpis(p_year integer, p_month integer, p_rep text, p_source text, p_service text);

CREATE OR REPLACE FUNCTION public.get_zoho_lead_kpis(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[])
 RETURNS TABLE(leads_received bigint, leads_converted bigint, leads_invoiced bigint, conversion_rate numeric, invoiced_rate numeric, revenue_attributed numeric, revenue_lifetime numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_leads_scoped(p_year, p_month, p_rep, p_source, p_service, p_reps, p_sources, p_services)
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_lead_kpis(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_reps text[], p_sources text[], p_services text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_leads_monthly_summary(p_year integer, p_rep text, p_source text, p_service text);

CREATE OR REPLACE FUNCTION public.get_zoho_leads_monthly_summary(p_year integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[])
 RETURNS TABLE(month bigint, nb_leads bigint, nb_converted bigint, nb_invoiced bigint, total_amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_leads_scoped(p_year, NULL, p_rep, p_source, p_service, p_reps, p_sources, p_services)
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_leads_monthly_summary(p_year integer, p_rep text, p_source text, p_service text, p_reps text[], p_sources text[], p_services text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_leads_by_rep(p_year integer, p_month integer, p_source text, p_service text);

CREATE OR REPLACE FUNCTION public.get_zoho_leads_by_rep(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_leads bigint, nb_converted bigint, nb_invoiced bigint, total_amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_leads_scoped(p_year, p_month, NULL, p_source, p_service, NULL, p_sources, p_services)
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_leads_by_rep(p_year integer, p_month integer, p_source text, p_service text, p_sources text[], p_services text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_leads_by_source(p_year integer, p_month integer, p_rep text, p_service text);

CREATE OR REPLACE FUNCTION public.get_zoho_leads_by_source(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_leads bigint, nb_converted bigint, nb_invoiced bigint, total_amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_leads_scoped(p_year, p_month, p_rep, NULL, p_service, p_reps, NULL, p_services)
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_leads_by_source(p_year integer, p_month integer, p_rep text, p_service text, p_reps text[], p_services text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_leads_by_service(p_year integer, p_month integer, p_rep text, p_source text);

CREATE OR REPLACE FUNCTION public.get_zoho_leads_by_service(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_leads bigint, nb_converted bigint, nb_invoiced bigint, total_amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_leads_scoped(p_year, p_month, p_rep, p_source, NULL, p_reps, p_sources, NULL)
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_leads_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_reps text[], p_sources text[]) TO authenticated, service_role;

