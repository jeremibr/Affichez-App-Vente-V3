-- One page, one definition of "a facture".
--
-- The Factures KPI card and the Sommaire table directly beneath it counted
-- different things. The card excludes credit notes:
--
--   get_inv_dashboard_kpis:  COUNT(*) FILTER (WHERE NOT is_avoir)
--
-- while both Sommaire functions counted every row, avoirs included:
--
--   get_inv_sommaire:        COUNT(*)
--
-- So "Nb Factures" on the card and the deal_count column under it disagree by
-- exactly the number of credit notes in the period, and nothing on screen
-- explains why. A credit note is money leaving; it is not a facture that was
-- issued, which is what the column is counting.
--
-- The card is the one that is right, and get_inv_rep_leaderboard and
-- get_inv_top_clients already agree with it -- these two were the odd ones out.
--
-- Amounts are untouched and stay NET of credit notes, which is deliberate and
-- already documented: avoirs are stored negative (zoho-invoice-sync), so summing
-- them is what makes the revenue figure honest. Count excludes them, amount
-- includes them, and that asymmetry is the correct one.
--
-- Bodies reproduced from supabase/schema.sql (verified identical to live) with
-- the FILTER clause as the only change.


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
        AND p_rep IS NOT NULL AND ro.rep_name=p_rep AND ro.module='factures' AND ro.year=p_year
      UNION ALL
      SELECT of2.month AS o_month, of2.target_amount AS o_target FROM objectives_factures of2
      WHERE p_office IS NULL
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

GRANT EXECUTE ON FUNCTION get_inv_sommaire(p_year integer, p_office text, p_status text, p_rep text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION get_inv_sommaire_grand_total(p_year integer, p_office text, p_status text, p_rep text, text[]) TO authenticated;
