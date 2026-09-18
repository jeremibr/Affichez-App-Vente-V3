-- Tâches CRM: count on Montréal's calendar, and compare like with like.
--
-- Two defects, both found auditing the Tasks page on 2026-09-18.
--
-- ─── 1. The module counted in UTC ───────────────────────────────────────────
--
-- Every date predicate resolved in the session time zone, which for PostgREST is
-- UTC. A task created 31 January at 20:00 in Montréal is 1 February 01:00 UTC, so
-- it landed in February. Roughly the last four to five hours of every local day
-- were attributed to the next day, week, month and year.
--
-- This is not house style, it is an inconsistency: the leads and accounts side
-- already counts on Montréal's calendar through zoho_local_date /
-- zoho_lead_local_date, and America/Toronto appears in nine other objects. Tâches
-- used none of them, so "Janvier" meant one thing on one page and something else
-- on another.
--
-- 20260915150000 spotted this and deliberately left it alone -- "changing it would
-- move tasks created after 19:00 EST into the next day, so it is left alone here
-- rather than smuggled into a performance change". Correct call. This is that
-- change, made on purpose.
--
-- EXPECT NUMBERS TO MOVE. Tasks created in the evening shift back one day, and
-- with them any month or year boundary they crossed. That is the fix, not a
-- side effect.
--
-- Sargability is preserved, and in two functions improved. 20260915150000's rule
-- is that a predicate must be a half-open RANGE on the bare column, never a
-- function of it, or no index can serve it. get_tasks_kpis and get_tasks_by_rep
-- still filtered with EXTRACT(YEAR FROM created_time) -- that migration only
-- reached the three week-based functions. They now use ranges too, so this is a
-- correctness fix that also removes two sequential scans.
--
-- The boundaries are built as local wall-clock timestamps and converted with
-- AT TIME ZONE, which is DST-aware. Adding an interval to a timestamptz would be
-- resolved in the session zone and drift by an hour across a DST change.
--
-- ─── 2. Week-over-week compared a partial week to a whole one ───────────────
--
-- get_tasks_wow counted "this week" from Monday to now, and "last week" as a
-- complete Monday-to-Monday. TasksDashboard renders the raw difference, so on a
-- Monday morning every rep showed a large negative: three days of work against
-- somebody's full previous week. Wrong most of the week, not just at the edges.
--
-- Last week is now measured over the SAME elapsed slice -- Monday to the same
-- weekday and time -- so the comparison means something on a Tuesday. The column
-- is relabelled in the UI to say so.
--
-- Not touched here: completion_rate still divides tasks closed in the period by
-- tasks created in it, which are different cohorts and can exceed 100%. That is
-- its own change.


-- ── get_tasks_kpis ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."get_tasks_kpis"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_week_start" "date" DEFAULT NULL::"date") RETURNS TABLE("total_created" bigint, "total_completed" bigint, "completion_rate" numeric, "total_touched" bigint, "total_open" bigint, "total_overdue" bigint, "active_reps" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  WITH b AS (
    SELECT
      (CASE WHEN p_week_start IS NOT NULL THEN p_week_start::timestamp
            ELSE make_date(p_year, COALESCE(p_month, 1), 1)::timestamp END)
        AT TIME ZONE 'America/Toronto' AS lo,
      (CASE WHEN p_week_start IS NOT NULL THEN (p_week_start + 7)::timestamp
            WHEN p_month IS NULL THEN make_date(p_year + 1, 1, 1)::timestamp
            ELSE (make_date(p_year, p_month, 1) + INTERVAL '1 month')::timestamp END)
        AT TIME ZONE 'America/Toronto' AS hi,
      -- "Overdue" must flip at local midnight, not at 20:00 when UTC rolls over.
      (now() AT TIME ZONE 'America/Toronto')::date AS today
  )
  SELECT
    COUNT(*) FILTER (WHERE in_created)   AS total_created,
    COUNT(*) FILTER (WHERE in_completed) AS total_completed,
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_completed) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS completion_rate,
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
  ) t
$$;


-- ── get_tasks_by_rep ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."get_tasks_by_rep"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_week_start" "date" DEFAULT NULL::"date") RETURNS TABLE("rep_name" "text", "nb_created" bigint, "nb_completed" bigint, "nb_touched" bigint, "completion_rate" numeric, "avg_days_to_close" numeric, "nb_open" bigint, "nb_overdue" bigint)
    LANGUAGE "sql" STABLE
    AS $$
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
  SELECT rep_name,
    COUNT(*) FILTER (WHERE in_created)   AS nb_created,
    COUNT(*) FILTER (WHERE in_completed) AS nb_completed,
    COUNT(*) FILTER (WHERE in_touched)   AS nb_touched,
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_completed) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS completion_rate,
    ROUND(AVG(EXTRACT(EPOCH FROM (closed_time - created_time)) / 86400.0)
          FILTER (WHERE in_completed), 1) AS avg_days_to_close,
    COUNT(*) FILTER (WHERE closed_time IS NULL) AS nb_open,
    COUNT(*) FILTER (WHERE closed_time IS NULL AND due_date IS NOT NULL AND due_date < today) AS nb_overdue
  FROM (
    SELECT t.rep_name, t.created_time, t.closed_time, t.due_date, b.today,
      (t.created_time  >= b.lo AND t.created_time  < b.hi) AS in_created,
      (t.closed_time IS NOT NULL
         AND t.closed_time >= b.lo AND t.closed_time < b.hi) AS in_completed,
      (t.modified_time >= b.lo AND t.modified_time < b.hi) AS in_touched
    FROM zoho_tasks t, b
    WHERE t.rep_name IN (SELECT tasks_visible_reps())
  ) t
  GROUP BY rep_name
  HAVING COUNT(*) FILTER (WHERE in_created) > 0
      OR COUNT(*) FILTER (WHERE in_touched) > 0
      OR COUNT(*) FILTER (WHERE closed_time IS NULL) > 0
  ORDER BY nb_completed DESC, nb_created DESC
$$;


-- ── get_tasks_weekly ────────────────────────────────────────────────────────
-- ISO-year bounds unchanged in meaning; they are now resolved in Montréal rather
-- than UTC, and the weeks are bucketed on the local calendar to match.

CREATE OR REPLACE FUNCTION "public"."get_tasks_weekly"("p_year" integer, "p_rep" "text" DEFAULT NULL::"text") RETURNS TABLE("week_start" "date", "nb_created" bigint, "nb_completed" bigint)
    LANGUAGE "sql" STABLE
    AS $$
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
    GROUP BY 1
  ),
  d AS (
    SELECT date_trunc('week', t.closed_time AT TIME ZONE 'America/Toronto')::date AS ws, COUNT(*) AS nb
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
$$;


-- ── get_tasks_available_weeks ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."get_tasks_available_weeks"("p_year" integer) RETURNS TABLE("week_start" "date", "week_end" "date", "nb_created" bigint, "nb_completed" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  WITH b AS (
    SELECT date_trunc('week', make_date(p_year,     1, 4))::timestamp
             AT TIME ZONE 'America/Toronto' AS lo,
           date_trunc('week', make_date(p_year + 1, 1, 4))::timestamp
             AT TIME ZONE 'America/Toronto' AS hi
  ),
  visible AS (SELECT tasks_visible_reps() AS rep_name),
  ev AS (
    SELECT date_trunc('week', t.created_time AT TIME ZONE 'America/Toronto')::date AS wk, 'c'::text AS kind
    FROM zoho_tasks t, b
    WHERE t.rep_name IN (SELECT rep_name FROM visible)
      AND t.created_time >= b.lo AND t.created_time < b.hi
    UNION ALL
    SELECT date_trunc('week', t.closed_time AT TIME ZONE 'America/Toronto')::date, 'd'
    FROM zoho_tasks t, b
    WHERE t.rep_name IN (SELECT rep_name FROM visible)
      AND t.closed_time IS NOT NULL
      AND t.closed_time >= b.lo AND t.closed_time < b.hi
  )
  SELECT wk AS week_start, (wk + 6) AS week_end,
    COUNT(*) FILTER (WHERE kind = 'c') AS nb_created,
    COUNT(*) FILTER (WHERE kind = 'd') AS nb_completed
  FROM ev GROUP BY wk ORDER BY wk DESC
$$;


-- ── get_tasks_wow ───────────────────────────────────────────────────────────
-- Montréal's week, and last week measured over the same elapsed slice.

CREATE OR REPLACE FUNCTION "public"."get_tasks_wow"("p_rep" "text" DEFAULT NULL::"text") RETURNS TABLE("rep_name" "text", "created_this_week" bigint, "created_last_week" bigint, "completed_this_week" bigint, "completed_last_week" bigint)
    LANGUAGE "sql" STABLE
    AS $$
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
    AND (t.created_time >= w.last_monday
         OR (t.closed_time IS NOT NULL AND t.closed_time >= w.last_monday))
  GROUP BY t.rep_name, w.this_monday, w.last_monday, w.last_cutoff
  ORDER BY completed_this_week DESC, created_this_week DESC
$$;
