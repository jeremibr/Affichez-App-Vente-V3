-- True per-quarter team totals (current & previous year), independent of which reps
-- are active in the current year.
--
-- Fixes the "Total équipe" last-year column on the quarterly pages, which previously
-- only summed the reps shown this year — so reps who left or had a dry quarter
-- (e.g. Charles Côté, Simon Fortin Massé in Q2/Q3) were dropped from last year,
-- making the YoY comparison look better than reality.
--
-- The metric matches get_quarterly_yoy / get_inv_quarterly_yoy: a weekly revenue
-- rate = SUM(amount) / weeks_completed (additive across reps).
--
-- Applied to the database via migration `add_quarterly_yoy_totals_functions`.

CREATE OR REPLACE FUNCTION public.get_quarterly_yoy_totals(
  p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS TABLE(quarter integer, current_total numeric, previous_total numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.get_inv_quarterly_yoy_totals(
  p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS TABLE(quarter integer, current_total numeric, previous_total numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_quarterly_yoy_totals(integer, text, text)     TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_inv_quarterly_yoy_totals(integer, text, text) TO anon, authenticated, service_role;
