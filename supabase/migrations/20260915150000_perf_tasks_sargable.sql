-- Tâches CRM: stop reading 62,000 rows to return 38.
--
-- Three of these functions filtered on a *function of* the date column, which
-- no btree index on that column can serve:
--
--   Seq Scan on zoho_tasks (actual time=1215.651..1324.487 rows=7352)
--     Filter: (EXTRACT(isoyear FROM created_time))::integer = 2026
--     Rows Removed by Filter: 54612
--
-- Each is rewritten as a half-open range on the bare column, which the indexes
-- added in 20260915140000 can serve.
--
-- THE RANGE IS EXACTLY THE ISO YEAR, not the calendar year. ISO year Y is the
-- set of whole weeks starting with the Monday of the week containing 4 January
-- Y — which is what date_trunc('week', make_date(Y,1,4)) computes — and ending
-- the day before the same Monday of Y+1. So the rows are identical to what
-- EXTRACT(ISOYEAR ...) selected, including the late-December days that belong
-- to next year's week one.
--
-- These boundaries are cast with ::timestamptz, resolved in the session time
-- zone, because EXTRACT and date_trunc on a timestamptz resolve there too.
-- That preserves today's behaviour exactly. Worth knowing: for this module
-- that zone is UTC, not America/Toronto — unlike the leads and accounts side,
-- Tâches has always counted on the database's calendar. Changing it would move
-- tasks created after 19:00 EST into the next day, so it is left alone here
-- rather than smuggled into a performance change.


-- ── get_tasks_weekly — was 1366 ms ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_tasks_weekly(p_year integer, p_rep text DEFAULT NULL::text)
 RETURNS TABLE(week_start date, nb_created bigint, nb_completed bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;


-- ── get_tasks_available_weeks — was 416 ms ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_tasks_available_weeks(p_year integer)
 RETURNS TABLE(week_start date, week_end date, nb_created bigint, nb_completed bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;


-- ── get_tasks_wow — was 523 ms ──────────────────────────────────────────────
--
-- This one had no date filter at all: it scanned every task ever, then threw
-- away all but the last two weeks in a HAVING clause. The same condition is now
-- also in the WHERE, so the index does the discarding instead. The HAVING stays
-- — it is what drops a rep whose only activity is older than last Monday, and
-- moving it would change which rows the aggregate sees.

CREATE OR REPLACE FUNCTION public.get_tasks_wow(p_rep text DEFAULT NULL::text)
 RETURNS TABLE(rep_name text, created_this_week bigint, created_last_week bigint, completed_this_week bigint, completed_last_week bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
