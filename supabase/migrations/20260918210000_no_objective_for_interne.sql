-- No objective for "Interne" either.
--
-- Same rule as 20260918130000 did for the office filter, and as 20260914130000
-- did for a single rep: when the rows narrow to a scope the objectives cannot
-- express, print nothing rather than somebody else's number.
--
-- "Interne" is everybody NOT on the sales team -- internal billing entities and
-- former staff. objectives and objectives_factures are keyed (year, month,
-- department) for the whole company, and rep_objectives holds one number per rep
-- per month. Neither describes that group, so scoring it against the team target
-- understates it against a number that was never meant for it.
--
-- The guard is `p_reps IS NULL`, and it means exactly "not Interne" rather than
-- "any group", because of how the filter is built (see useRepFilter):
--
--     Tous les reps  -> p_reps NULL, p_rep NULL   team + internal, no filter
--     Interne        -> p_reps = [names]          the only case p_reps is set
--     a single rep   -> p_rep  = name             p_reps stays NULL
--
-- There is deliberately no "Équipe entière" option, so p_reps is non-null only
-- for Interne. One guard, and the objective survives for every other selection --
-- which is the distinction that was asked for.
--
-- get_sommaire already behaved this way since 20260914130000. The other five
-- did not, so picking Interne scored it against the full team or department
-- target in five places on two dashboards. This brings them into line.
--
-- Bodies are pg_get_functiondef output from the live database -- not
-- supabase/schema.sql, which is several migrations stale by now -- with the
-- guard as the only change. Verified by normalised diff.


CREATE OR REPLACE FUNCTION public.get_dashboard_kpis(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
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
      SELECT target_amount AS o_target FROM objectives
      WHERE p_office IS NULL
        AND p_reps IS NULL
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
$function$;

CREATE OR REPLACE FUNCTION public.get_inv_dashboard_kpis(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(ytd_total numeric, ytd_count bigint, avg_deal_size numeric, annual_target numeric, pct_of_target numeric, paid_total numeric, partial_total numeric, avoir_total numeric)
 LANGUAGE sql
AS $function$
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
        AND p_reps IS NULL
        AND p_rep IS NOT NULL AND rep_name=p_rep AND module='factures' AND year=p_year
        AND (p_month IS NULL OR month=p_month)
      UNION ALL
      SELECT target_amount AS o_target FROM objectives_factures
      WHERE p_office IS NULL
        AND p_reps IS NULL
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
$function$;

CREATE OR REPLACE FUNCTION public.get_inv_sommaire(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
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

CREATE OR REPLACE FUNCTION public.get_inv_sommaire_grand_total(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
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

CREATE OR REPLACE FUNCTION public.get_sommaire_grand_total(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
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
