-- A rep-LIST filter for the five Devis dashboard functions.
--
-- The last set still on the old model. Same change, same reasons as
-- 20260908130000 (invoices) and 20260908140000 (Comptes): the rep dropdown now
-- offers "Interne" as a group, and p_rep can only hold one name.
--
-- Dashboard.tsx also carried the bug those two had -- 'Tous' and 'Vente Interne'
-- both resolved to p_rep = NULL, so the two sent an identical query and
-- switching between them changed nothing on screen.
--
-- p_rep keeps its job: one rep, and on the two functions that read objectives it
-- also selects that rep's own target. p_reps filters rows only and leaves the
-- team objective in place, because a group has no single target.
--
-- The excluded_reps guard stands down when p_reps is given. Without that,
-- picking "Interne" would return everything except the one name that is most
-- obviously internal: 'Vente interne' is the sole row in excluded_reps.
--
-- Two of the five had NO rep filter at all, which is a reporting bug of its own:
--
--   get_sommaire          the per-department table. Pick a rep and the KPI cards
--                         showed that rep while the table under them still
--                         showed the whole team.
--   get_rep_leaderboard   now narrows with the filter, as the Factures
--                         leaderboard already does.
--
-- Every parameter is appended with a DEFAULT, so all existing callers keep
-- behaving exactly as they do today.


-- ── get_dashboard_kpis ──────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_dashboard_kpis(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text);

CREATE OR REPLACE FUNCTION public.get_dashboard_kpis(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(ytd_total numeric, ytd_count bigint, avg_deal_size numeric, annual_target numeric, pct_of_target numeric, invoiced_total numeric, accepted_total numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
      WHERE p_rep IS NOT NULL AND rep_name = p_rep AND module = 'devis' AND year = p_year
        AND (p_month IS NULL OR month = p_month)
      UNION ALL
      SELECT target_amount AS o_target FROM objectives
      WHERE p_rep IS NULL AND year = p_year
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

GRANT EXECUTE ON FUNCTION get_dashboard_kpis(integer, text, text, integer, text, text, text[]) TO anon, authenticated, service_role;


-- ── get_rep_leaderboard ─────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_rep_leaderboard(p_year integer, p_office text, p_status text, p_month integer, p_dept text);

CREATE OR REPLACE FUNCTION public.get_rep_leaderboard(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(rep_name text, office text, total_amount numeric, deal_count bigint, avg_deal numeric, rank bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;

GRANT EXECUTE ON FUNCTION get_rep_leaderboard(integer, text, text, integer, text, text, text[]) TO anon, authenticated, service_role;


-- ── get_sommaire ────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_sommaire(p_year integer, p_office text, p_status text);

CREATE OR REPLACE FUNCTION public.get_sommaire(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(month integer, department department_enum, objectif numeric, actual_amount numeric, pct_atteint numeric, deal_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  WITH obj AS (
    -- A single rep has no per-department target, so the department objectives
    -- stay as they are and only the actuals narrow. Showing a rep's sales
    -- against the department's target is the honest reading of "he did X of the
    -- Y this department has to bill"; inventing a per-rep split would not be.
    SELECT o.month AS o_month, o.department AS o_dept, o.target_amount AS o_total
    FROM objectives o WHERE o.year = p_year
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
$function$;

GRANT EXECUTE ON FUNCTION get_sommaire(integer, text, text, text, text[]) TO anon, authenticated, service_role;


-- ── get_sommaire_grand_total ────────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_sommaire_grand_total(p_year integer, p_office text, p_status text, p_rep text);

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
      WHERE p_rep IS NOT NULL AND ro.rep_name = p_rep AND ro.module = 'devis' AND ro.year = p_year
      UNION ALL
      SELECT od.month AS o_month, od.target_amount AS o_target FROM objectives od
      WHERE p_rep IS NULL AND od.year = p_year
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
$function$;

GRANT EXECUTE ON FUNCTION get_sommaire_grand_total(integer, text, text, text, text[]) TO anon, authenticated, service_role;


-- ── get_top_clients ─────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_top_clients(p_year integer, p_office text, p_status text, p_limit integer, p_month integer, p_dept text, p_rep text);

CREATE OR REPLACE FUNCTION public.get_top_clients(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(client_name text, total_amount numeric, deal_count bigint, office text)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;

GRANT EXECUTE ON FUNCTION get_top_clients(integer, text, text, integer, integer, text, text, text[]) TO anon, authenticated, service_role;
