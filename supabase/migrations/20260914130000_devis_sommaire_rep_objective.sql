-- get_sommaire: no department objective once a rep filter is on.
--
-- 20260914120000 gave get_sommaire a rep filter so the "Performance — X" table
-- stopped showing the whole team while the KPI cards above it showed one rep.
-- That left a second contradiction on the same screen: the actuals narrowed to
-- the rep, the Objectif column did not.
--
-- For Dominic Letendre + MULTI-ANNONCEURS the screen read "Objectif annuel
-- 0,00 $" on the card and "Objectif 3 643 628,54 $" in the table under it, and
-- scored him at 14,83 % of a target belonging to five other people.
--
-- objectives holds targets per department for the whole company; rep_objectives
-- holds one number per rep per month with no department in it. There is
-- therefore no such thing as this rep's target for this department, and the
-- honest answer is to print nothing rather than someone else's number.
--
-- get_sommaire_grand_total already behaves this way: give it a rep and it reads
-- rep_objectives, which for a rep with no devis targets is zero. This is the
-- same rule, one level down.
--
-- With no rep filter the function is unchanged.

CREATE OR REPLACE FUNCTION public.get_sommaire(p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_rep text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[])
 RETURNS TABLE(month integer, department department_enum, objectif numeric, actual_amount numeric, pct_atteint numeric, deal_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o.month AS o_month, o.department AS o_dept, o.target_amount AS o_total
    FROM objectives o
    WHERE o.year = p_year
      AND p_rep IS NULL AND p_reps IS NULL
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
