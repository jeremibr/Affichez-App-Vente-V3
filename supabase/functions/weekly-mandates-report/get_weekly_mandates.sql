-- Per-client signed mandates for a given week, used by the weekly-mandates-report
-- edge function. QC + MTL are combined (no office filter). "Signed" = won =
-- accepted OR invoiced (declined excluded), matching the weekly sales total.
--
-- Returns each client once with the distinct departments touched that week, the
-- number of quotes, the client's total (for sorting / top mandate — NOT shown per
-- client in the team email), and whether it is the client's first-ever mandate.
--
-- Applied to the database via migration `add_get_weekly_mandates`.

CREATE OR REPLACE FUNCTION public.get_weekly_mandates(p_week_start date)
 RETURNS TABLE(client_name text, departments text[], nb_quotes bigint, total_amount numeric, is_new boolean)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_weekly_mandates(date) TO anon, authenticated, service_role;
