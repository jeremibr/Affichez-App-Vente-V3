-- A year with no fiscal calendar is unknown, not zero.
--
-- 20260918150000 added the 2024 quarters and fixed the symptom: the 2025 page had
-- been showing four green gains against $0 while `sales` held 1,868 rows dated
-- 2024. It left the cause alone, which is this:
--
--   SELECT ... COALESCE(py.avg_deal, 0)
--
-- That collapses two different facts into the same number. "This rep sold nothing
-- in Q2 last year" and "we never defined last year's calendar, so nothing was
-- queried" both print 0, and 0 reads as measured. That is exactly why the gap
-- survived from 2025-01-01 until today without anyone noticing.
--
-- So: when p_year - 1 has no rows in fiscal_quarters, the comparison columns
-- return NULL and the UI prints "—". When the year IS defined, a quarter with no
-- sales still returns 0, because that zero is a real measurement.
--
-- The same guard applies to the current year, for the same reason: ask for a year
-- with no calendar and the totals functions used to answer 0 rather than admit
-- they had nothing to join to.
--
-- All four functions are changed together, on purpose. Two of them
-- (get_quarterly_yoy, get_inv_quarterly_yoy) were database-only until
-- 20260918150000's snapshot; changing only the two that were already in the repo
-- would have printed "—" on the Total équipe row above rep rows still printing 0,
-- which is a worse screen than today's. Their bodies below are reproduced from
-- supabase/schema.sql with only the guard added.
--
-- Testable today: 2024 has quarters and 2023 does not, so
-- get_quarterly_yoy_totals(2024) must return previous_total = NULL, while
-- get_quarterly_yoy_totals(2025) and (2026) keep the values they return now.


-- ── Devis, per rep ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."get_quarterly_yoy"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text") RETURNS TABLE("quarter" integer, "rep_name" "text", "office" "text", "current_avg" numeric, "previous_avg" numeric, "resultat" numeric, "deal_count" bigint)
    LANGUAGE "sql" STABLE
    AS $$
WITH prev_defined AS (
  SELECT EXISTS (SELECT 1 FROM fiscal_quarters WHERE year = p_year - 1) AS ok
),
fq_weeks AS (
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
  cy.avg_deal,
  CASE WHEN (SELECT ok FROM prev_defined) THEN COALESCE(py.avg_deal,0) ELSE NULL END,
  CASE WHEN (SELECT ok FROM prev_defined) THEN cy.avg_deal - COALESCE(py.avg_deal,0) ELSE NULL END,
  cy.deal_count
FROM current_year cy
LEFT JOIN previous_year py ON cy.quarter=py.quarter AND cy.rep_name=py.rep_name
ORDER BY cy.quarter, cy.rep_name;
$$;


-- ── Factures, per rep ───────────────────────────────────────────────────────

-- Note: no STABLE here, matching the live definition. get_quarterly_yoy above
-- IS stable and this one is not — an inconsistency that predates this change and
-- is left alone rather than quietly corrected inside a bug fix.
CREATE OR REPLACE FUNCTION "public"."get_inv_quarterly_yoy"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text") RETURNS TABLE("quarter" integer, "rep_name" "text", "office" "text", "current_avg" numeric, "previous_avg" numeric, "resultat" numeric, "deal_count" bigint)
    LANGUAGE "sql"
    AS $$
WITH prev_defined AS (
  SELECT EXISTS (SELECT 1 FROM fiscal_quarters WHERE year = p_year - 1) AS ok
),
fq_weeks AS (
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
  cy.avg_deal,
  CASE WHEN (SELECT ok FROM prev_defined) THEN COALESCE(py.avg_deal,0) ELSE NULL END,
  CASE WHEN (SELECT ok FROM prev_defined) THEN cy.avg_deal - COALESCE(py.avg_deal,0) ELSE NULL END,
  cy.deal_count
FROM current_year cy
LEFT JOIN previous_year py ON cy.quarter=py.quarter AND cy.rep_name=py.rep_name
ORDER BY cy.quarter, cy.rep_name;
$$;


-- ── Devis, team totals ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_quarterly_yoy_totals(
  p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS TABLE(quarter integer, current_total numeric, previous_total numeric)
 LANGUAGE sql
 STABLE
AS $function$
WITH defined AS (
  SELECT EXISTS (SELECT 1 FROM fiscal_quarters WHERE year = p_year)     AS cur_ok,
         EXISTS (SELECT 1 FROM fiscal_quarters WHERE year = p_year - 1) AS prev_ok
),
fq_weeks AS (
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
       CASE WHEN (SELECT cur_ok  FROM defined) THEN COALESCE(cur.total, 0)::numeric  ELSE NULL END,
       CASE WHEN (SELECT prev_ok FROM defined) THEN COALESCE(prev.total, 0)::numeric ELSE NULL END
FROM (SELECT DISTINCT quarter FROM fq_weeks) q
LEFT JOIN cur  ON cur.quarter  = q.quarter
LEFT JOIN prev ON prev.quarter = q.quarter
ORDER BY q.quarter;
$function$;


-- ── Factures, team totals ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_inv_quarterly_yoy_totals(
  p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS TABLE(quarter integer, current_total numeric, previous_total numeric)
 LANGUAGE sql
 STABLE
AS $function$
WITH defined AS (
  SELECT EXISTS (SELECT 1 FROM fiscal_quarters WHERE year = p_year)     AS cur_ok,
         EXISTS (SELECT 1 FROM fiscal_quarters WHERE year = p_year - 1) AS prev_ok
),
fq_weeks AS (
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
       CASE WHEN (SELECT cur_ok  FROM defined) THEN COALESCE(cur.total, 0)::numeric  ELSE NULL END,
       CASE WHEN (SELECT prev_ok FROM defined) THEN COALESCE(prev.total, 0)::numeric ELSE NULL END
FROM (SELECT DISTINCT quarter FROM fq_weeks) q
LEFT JOIN cur  ON cur.quarter  = q.quarter
LEFT JOIN prev ON prev.quarter = q.quarter
ORDER BY q.quarter;
$function$;

GRANT EXECUTE ON FUNCTION public.get_quarterly_yoy_totals(integer, text, text)     TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_inv_quarterly_yoy_totals(integer, text, text) TO anon, authenticated, service_role;
