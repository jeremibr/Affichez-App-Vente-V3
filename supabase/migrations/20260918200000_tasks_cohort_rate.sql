-- Tâches: two honest rates instead of one misleading one.
--
-- completion_rate divides tasks CLOSED in the period by tasks CREATED in it.
-- Those are different cohorts: a task opened in January and closed in March counts
-- in January's denominator and March's numerator. The ratio is two unrelated flows,
-- and it can exceed 100% whenever a team clears backlog.
--
-- It was known to exceed 100%, because TasksDashboard clamps it:
--
--     Math.min(Math.round(kpis?.completion_rate ?? 0), 100)
--
-- Capping the display hides the symptom and keeps the wrong number. Both readings
-- are legitimate; they answer different questions, so the fix is to return both
-- and label each.
--
--   completion_rate  (unchanged)  closed in period / created in period.
--                                 Throughput. >100% means backlog was cleared,
--                                 which is real information, not an error.
--   cohort_rate      (new)        of the tasks CREATED in the period, the share
--                                 that is now closed. Cannot exceed 100%. Answers
--                                 "are we finishing what we start".
--
-- cohort_rate is deliberately "closed whenever", not "closed in the same period":
-- a January task closed in March still counts as finished. Bounding it to the
-- period would recreate the same cohort confusion one level down. The consequence
-- is that the figure for a recent month climbs for a while after the month ends,
-- which is correct and worth knowing when reading it.
--
-- The return type gains a column, so these are dropped and recreated rather than
-- CREATE OR REPLACE'd -- Postgres refuses to change a function's return type in
-- place. Bodies are otherwise exactly 20260918190000's, which is live.


DROP FUNCTION IF EXISTS "public"."get_tasks_kpis"(integer, integer, "text", "date");

CREATE OR REPLACE FUNCTION "public"."get_tasks_kpis"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_rep" "text" DEFAULT NULL::"text", "p_week_start" "date" DEFAULT NULL::"date") RETURNS TABLE("total_created" bigint, "total_completed" bigint, "completion_rate" numeric, "cohort_rate" numeric, "total_touched" bigint, "total_open" bigint, "total_overdue" bigint, "active_reps" bigint)
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
  SELECT
    COUNT(*) FILTER (WHERE in_created)   AS total_created,
    COUNT(*) FILTER (WHERE in_completed) AS total_completed,
    -- Throughput: closed in period / created in period. Different cohorts, so
    -- >100% is meaningful (backlog cleared) rather than an error.
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_completed) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS completion_rate,
    -- One cohort: of what was created in the period, how much is now finished.
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_created AND closed_time IS NOT NULL) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS cohort_rate,
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


DROP FUNCTION IF EXISTS "public"."get_tasks_by_rep"(integer, integer, "date");

CREATE OR REPLACE FUNCTION "public"."get_tasks_by_rep"("p_year" integer, "p_month" integer DEFAULT NULL::integer, "p_week_start" "date" DEFAULT NULL::"date") RETURNS TABLE("rep_name" "text", "nb_created" bigint, "nb_completed" bigint, "nb_created_closed" bigint, "nb_touched" bigint, "completion_rate" numeric, "cohort_rate" numeric, "avg_days_to_close" numeric, "nb_open" bigint, "nb_overdue" bigint)
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
    -- cohort_rate's numerator, returned raw so the UI can recompute the rate when
    -- it merges the internal reps into one row. A rate cannot be re-averaged.
    COUNT(*) FILTER (WHERE in_created AND closed_time IS NOT NULL) AS nb_created_closed,
    COUNT(*) FILTER (WHERE in_touched)   AS nb_touched,
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_completed) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS completion_rate,
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_created AND closed_time IS NOT NULL) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS cohort_rate,
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
