-- Add a rep-LIST filter to the invoice dashboard functions.
--
-- The Factures rep dropdown was broken: "Tous" and "Vente Interne" both resolved
-- to p_rep = NULL, so they sent an identical query and switching between them
-- changed nothing on screen. Reported 2026-09-08.
--
-- Fixing it properly means the filter has to express a GROUP of reps, not just
-- one name — "Équipe entière" (the reps in the view dropdown) and "Interne"
-- (everybody else). p_rep can only hold one name, so p_reps is added beside it.
--
-- p_rep is left exactly as it was, and that is deliberate: it also chooses which
-- OBJECTIVE applies. p_rep set → that rep's own target from rep_objectives;
-- p_rep NULL → the team target from objectives_factures. A group has no single
-- rep target, so a group passes p_rep = NULL and gets the team objective, which
-- is the only defensible answer.
--
-- So the two parameters do different jobs:
--   p_rep   one rep — filters rows AND selects that rep's objective
--   p_reps  a list  — filters rows only, objective stays the team's
--
-- Every function below is reproduced from its live definition with exactly two
-- edits: the parameter appended, and the row filter added next to the existing
-- p_rep one. Nothing else in them changed. The parameter is appended last and
-- defaults to NULL, so every existing caller behaves identically.
--
-- One more edit beyond the two mechanical ones: the excluded_reps guard now
-- stands down when p_reps is given. excluded_reps holds "Vente interne", which
-- these functions drop from every total by default — correct for "everyone", and
-- wrong the moment somebody explicitly asks for the Interne group, which would
-- otherwise come back empty. An explicitly named rep is always honoured.

DROP FUNCTION IF EXISTS get_inv_dashboard_kpis(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text);

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
      WHERE p_rep IS NOT NULL AND rep_name=p_rep AND module='factures' AND year=p_year
        AND (p_month IS NULL OR month=p_month)
      UNION ALL
      SELECT target_amount AS o_target FROM objectives_factures
      WHERE p_rep IS NULL AND year=p_year
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

GRANT EXECUTE ON FUNCTION get_inv_dashboard_kpis(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text, text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_inv_rep_leaderboard(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text);

CREATE OR REPLACE FUNCTION public.get_inv_rep_leaderboard(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
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
$function$;

GRANT EXECUTE ON FUNCTION get_inv_rep_leaderboard(p_year integer, p_office text, p_status text, p_month integer, p_dept text, p_rep text, text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_inv_sommaire(p_year integer, p_office text, p_status text, p_rep text);

CREATE OR REPLACE FUNCTION public.get_inv_sommaire(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(month integer, department text, objectif numeric, actual_amount numeric, pct_atteint numeric, deal_count bigint)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o.month AS o_month, o.department AS o_dept, o.target_amount AS o_total
    FROM objectives_factures o WHERE o.year = p_year
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
$function$;

GRANT EXECUTE ON FUNCTION get_inv_sommaire(p_year integer, p_office text, p_status text, p_rep text, text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_inv_sommaire_grand_total(p_year integer, p_office text, p_status text, p_rep text);

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
      WHERE p_rep IS NOT NULL AND ro.rep_name=p_rep AND ro.module='factures' AND ro.year=p_year
      UNION ALL
      SELECT of2.month AS o_month, of2.target_amount AS o_target FROM objectives_factures of2
      WHERE p_rep IS NULL AND of2.year=p_year
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
$function$;

GRANT EXECUTE ON FUNCTION get_inv_sommaire_grand_total(p_year integer, p_office text, p_status text, p_rep text, text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_inv_top_clients(p_year integer, p_office text, p_status text, p_limit integer, p_month integer, p_dept text, p_rep text);

CREATE OR REPLACE FUNCTION public.get_inv_top_clients(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
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
$function$;

GRANT EXECUTE ON FUNCTION get_inv_top_clients(p_year integer, p_office text, p_status text, p_limit integer, p_month integer, p_dept text, p_rep text, text[]) TO authenticated;

DROP FUNCTION IF EXISTS get_invoice_unassigned_summary(p_year integer, p_office text, p_month integer, p_dept text, p_rep text);

CREATE OR REPLACE FUNCTION public.get_invoice_unassigned_summary(p_year integer DEFAULT NULL::integer, p_office text DEFAULT NULL::text, p_month integer DEFAULT NULL::integer, p_dept text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
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

GRANT EXECUTE ON FUNCTION get_invoice_unassigned_summary(p_year integer, p_office text, p_month integer, p_dept text, p_rep text, text[]) TO authenticated;
