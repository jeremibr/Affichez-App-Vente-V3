-- ============================================================
-- TÂCHES CRM MODULE — Supabase SQL
-- Zoho CRM Tasks → Supabase, owner-facing rep-activity dashboard
-- Run this in the Supabase SQL Editor (in order)
-- ============================================================
--
-- Completion is derived from closed_time (Zoho stamps Closed_Time whenever a
-- task moves to a "closed" status), so the metrics stay correct even if the
-- org customises the Status picklist labels.
--   flow metrics  (created / completed / touched) → bound to the selected period
--   stock metrics (open / overdue)                → current state, "as of today"
--
-- Only the reps added to the app (allowed_users, minus "Vente Interne" staff) are
-- shown — see tasks_visible_reps() — matching useRepList()/INTERNAL_REP_NAMES.


-- ─── 1. TABLE ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS zoho_tasks (
  zoho_task_id   TEXT PRIMARY KEY,
  subject        TEXT,
  rep_name       TEXT,
  rep_email      TEXT,
  status         TEXT,
  priority       TEXT,
  due_date       DATE,
  created_time   TIMESTAMPTZ,
  modified_time  TIMESTAMPTZ,
  closed_time    TIMESTAMPTZ,          -- NULL while the task is still open
  related_module TEXT,
  related_name   TEXT,
  zoho_crm_url   TEXT,
  office         TEXT,                  -- reserved; not populated in v1
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS zoho_tasks_rep_name_idx      ON zoho_tasks(rep_name);
CREATE INDEX IF NOT EXISTS zoho_tasks_created_time_idx  ON zoho_tasks(created_time);
CREATE INDEX IF NOT EXISTS zoho_tasks_closed_time_idx   ON zoho_tasks(closed_time);
CREATE INDEX IF NOT EXISTS zoho_tasks_modified_time_idx ON zoho_tasks(modified_time);
CREATE INDEX IF NOT EXISTS zoho_tasks_status_idx        ON zoho_tasks(status);
CREATE INDEX IF NOT EXISTS zoho_tasks_due_date_idx      ON zoho_tasks(due_date);

ALTER TABLE zoho_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "zoho_tasks_select_authenticated" ON zoho_tasks;
CREATE POLICY "zoho_tasks_select_authenticated"
  ON zoho_tasks FOR SELECT
  TO authenticated
  USING (true);


-- ─── 2. REP VISIBILITY ────────────────────────────────────────────────────────
-- Returns the reps added to the app (allowed_users), excluding internal
-- "Vente Interne" staff. Drops the ~34 former/non-app reps in the CRM history.
-- The internal list mirrors INTERNAL_REP_NAMES in frontend/src/lib/constants.ts.
--
-- Returned as a SET (evaluated once per query, then hash-joined) — NOT a per-row
-- predicate — so the dashboard RPCs stay fast on the full task history.
-- SECURITY DEFINER: reads allowed_users as the owner, bypassing the caller's RLS
-- (authenticated users can only see their own allowed_users row).
CREATE OR REPLACE FUNCTION tasks_visible_reps()
RETURNS SETOF TEXT
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT au.rep_name FROM allowed_users au
  WHERE au.rep_name IS NOT NULL
    AND normalize(au.rep_name, NFC) <> ALL (ARRAY[
      normalize('Simon Fortin Massé', NFC),
      normalize('Magasin Affichez', NFC),
      normalize('Charles Côté', NFC),
      normalize('Pier-Alexandre Lévesque', NFC),
      normalize('Vente interne', NFC)
    ]);
$$;


-- ─── 3. DASHBOARD RPCs ─────────────────────────────────────────────────────────

-- 3a. Team KPI strip. Optional p_week_start scopes flow metrics to one ISO week
--     (Mon .. +7d) instead of year/month; open/overdue stay current-state.
CREATE OR REPLACE FUNCTION get_tasks_kpis(
  p_year INT, p_month INT DEFAULT NULL, p_rep TEXT DEFAULT NULL, p_week_start DATE DEFAULT NULL
)
RETURNS TABLE (
  total_created BIGINT, total_completed BIGINT, completion_rate NUMERIC,
  total_touched BIGINT, total_open BIGINT, total_overdue BIGINT, active_reps BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    COUNT(*) FILTER (WHERE in_created)   AS total_created,
    COUNT(*) FILTER (WHERE in_completed) AS total_completed,
    CASE WHEN COUNT(*) FILTER (WHERE in_created) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE in_completed) * 100.0
                    / COUNT(*) FILTER (WHERE in_created), 0) END AS completion_rate,
    COUNT(*) FILTER (WHERE in_touched)   AS total_touched,
    COUNT(*) FILTER (WHERE closed_time IS NULL) AS total_open,
    COUNT(*) FILTER (WHERE closed_time IS NULL AND due_date IS NOT NULL AND due_date < CURRENT_DATE) AS total_overdue,
    COUNT(DISTINCT rep_name) FILTER (WHERE in_created OR in_touched) AS active_reps
  FROM (
    SELECT rep_name, closed_time, due_date,
      (CASE WHEN p_week_start IS NOT NULL
            THEN created_time >= p_week_start::timestamptz AND created_time < (p_week_start + 7)::timestamptz
            ELSE EXTRACT(YEAR FROM created_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM created_time)::INT = p_month) END) AS in_created,
      (CASE WHEN p_week_start IS NOT NULL
            THEN closed_time IS NOT NULL AND closed_time >= p_week_start::timestamptz AND closed_time < (p_week_start + 7)::timestamptz
            ELSE closed_time IS NOT NULL AND EXTRACT(YEAR FROM closed_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM closed_time)::INT = p_month) END) AS in_completed,
      (CASE WHEN p_week_start IS NOT NULL
            THEN modified_time >= p_week_start::timestamptz AND modified_time < (p_week_start + 7)::timestamptz
            ELSE EXTRACT(YEAR FROM modified_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM modified_time)::INT = p_month) END) AS in_touched
    FROM zoho_tasks
    WHERE rep_name IN (SELECT tasks_visible_reps()) AND (p_rep IS NULL OR rep_name = p_rep)
  ) t
$$;

-- 3b. Rep leaderboard. Same optional p_week_start week-scoping as get_tasks_kpis.
CREATE OR REPLACE FUNCTION get_tasks_by_rep(
  p_year INT, p_month INT DEFAULT NULL, p_week_start DATE DEFAULT NULL
)
RETURNS TABLE (
  rep_name TEXT, nb_created BIGINT, nb_completed BIGINT, nb_touched BIGINT,
  completion_rate NUMERIC, avg_days_to_close NUMERIC, nb_open BIGINT, nb_overdue BIGINT
)
LANGUAGE sql STABLE AS $$
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
    COUNT(*) FILTER (WHERE closed_time IS NULL AND due_date IS NOT NULL AND due_date < CURRENT_DATE) AS nb_overdue
  FROM (
    SELECT rep_name, created_time, closed_time, due_date,
      (CASE WHEN p_week_start IS NOT NULL
            THEN created_time >= p_week_start::timestamptz AND created_time < (p_week_start + 7)::timestamptz
            ELSE EXTRACT(YEAR FROM created_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM created_time)::INT = p_month) END) AS in_created,
      (CASE WHEN p_week_start IS NOT NULL
            THEN closed_time IS NOT NULL AND closed_time >= p_week_start::timestamptz AND closed_time < (p_week_start + 7)::timestamptz
            ELSE closed_time IS NOT NULL AND EXTRACT(YEAR FROM closed_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM closed_time)::INT = p_month) END) AS in_completed,
      (CASE WHEN p_week_start IS NOT NULL
            THEN modified_time >= p_week_start::timestamptz AND modified_time < (p_week_start + 7)::timestamptz
            ELSE EXTRACT(YEAR FROM modified_time)::INT = p_year
                 AND (p_month IS NULL OR EXTRACT(MONTH FROM modified_time)::INT = p_month) END) AS in_touched
    FROM zoho_tasks
    WHERE rep_name IN (SELECT tasks_visible_reps())
  ) t
  GROUP BY rep_name
  HAVING COUNT(*) FILTER (WHERE in_created) > 0
      OR COUNT(*) FILTER (WHERE in_touched) > 0
      OR COUNT(*) FILTER (WHERE closed_time IS NULL) > 0
  ORDER BY nb_completed DESC, nb_created DESC
$$;

-- 3c. Open tasks by status
CREATE OR REPLACE FUNCTION get_tasks_by_status(p_rep TEXT DEFAULT NULL)
RETURNS TABLE (status TEXT, nb BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(status, 'Non défini') AS status, COUNT(*) AS nb
  FROM zoho_tasks
  WHERE closed_time IS NULL AND rep_name IN (SELECT tasks_visible_reps())
    AND (p_rep IS NULL OR rep_name = p_rep)
  GROUP BY COALESCE(status, 'Non défini')
  ORDER BY nb DESC
$$;

-- 3d. Weekly trend (single-pass; returns the Monday date of each active week
--     so the chart can show real date labels).
CREATE OR REPLACE FUNCTION get_tasks_weekly(p_year INT, p_rep TEXT DEFAULT NULL)
RETURNS TABLE (week_start DATE, nb_created BIGINT, nb_completed BIGINT)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT date_trunc('week', created_time)::date AS ws, COUNT(*) AS nb
    FROM zoho_tasks
    WHERE rep_name IN (SELECT tasks_visible_reps())
      AND EXTRACT(ISOYEAR FROM created_time)::INT = p_year
      AND (p_rep IS NULL OR rep_name = p_rep)
    GROUP BY 1
  ),
  d AS (
    SELECT date_trunc('week', closed_time)::date AS ws, COUNT(*) AS nb
    FROM zoho_tasks
    WHERE rep_name IN (SELECT tasks_visible_reps()) AND closed_time IS NOT NULL
      AND EXTRACT(ISOYEAR FROM closed_time)::INT = p_year
      AND (p_rep IS NULL OR rep_name = p_rep)
    GROUP BY 1
  )
  SELECT COALESCE(c.ws, d.ws) AS week_start,
         COALESCE(c.nb, 0)    AS nb_created,
         COALESCE(d.nb, 0)    AS nb_completed
  FROM c FULL OUTER JOIN d ON c.ws = d.ws
  ORDER BY week_start
$$;

-- 3e. Per-rep this-week vs last-week
CREATE OR REPLACE FUNCTION get_tasks_wow(p_rep TEXT DEFAULT NULL)
RETURNS TABLE (
  rep_name TEXT, created_this_week BIGINT, created_last_week BIGINT,
  completed_this_week BIGINT, completed_last_week BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT rep_name,
    COUNT(*) FILTER (WHERE created_time >= b.this_monday) AS created_this_week,
    COUNT(*) FILTER (WHERE created_time >= b.last_monday AND created_time < b.this_monday) AS created_last_week,
    COUNT(*) FILTER (WHERE closed_time IS NOT NULL AND closed_time >= b.this_monday) AS completed_this_week,
    COUNT(*) FILTER (WHERE closed_time IS NOT NULL AND closed_time >= b.last_monday AND closed_time < b.this_monday) AS completed_last_week
  FROM zoho_tasks
  CROSS JOIN (
    SELECT date_trunc('week', CURRENT_DATE) AS this_monday,
           date_trunc('week', CURRENT_DATE) - INTERVAL '7 days' AS last_monday
  ) b
  WHERE rep_name IN (SELECT tasks_visible_reps()) AND (p_rep IS NULL OR rep_name = p_rep)
  GROUP BY rep_name, b.this_monday, b.last_monday
  HAVING COUNT(*) FILTER (WHERE created_time >= b.last_monday
                            OR (closed_time IS NOT NULL AND closed_time >= b.last_monday)) > 0
  ORDER BY completed_this_week DESC, created_this_week DESC
$$;


-- ─── 4. WEEKLY-VIEW RPCs ───────────────────────────────────────────────────────

-- 4a. Weeks (Mon-anchored) that had any task activity this year, newest first.
CREATE OR REPLACE FUNCTION get_tasks_available_weeks(p_year INT)
RETURNS TABLE (week_start DATE, week_end DATE, nb_created BIGINT, nb_completed BIGINT)
LANGUAGE sql STABLE AS $$
  WITH ev AS (
    SELECT date_trunc('week', created_time)::date AS wk, 'c'::text AS kind
    FROM zoho_tasks
    WHERE rep_name IN (SELECT tasks_visible_reps())
      AND EXTRACT(ISOYEAR FROM created_time)::INT = p_year
    UNION ALL
    SELECT date_trunc('week', closed_time)::date, 'd'
    FROM zoho_tasks
    WHERE rep_name IN (SELECT tasks_visible_reps()) AND closed_time IS NOT NULL
      AND EXTRACT(ISOYEAR FROM closed_time)::INT = p_year
  )
  SELECT wk AS week_start, (wk + 6) AS week_end,
    COUNT(*) FILTER (WHERE kind = 'c') AS nb_created,
    COUNT(*) FILTER (WHERE kind = 'd') AS nb_completed
  FROM ev GROUP BY wk ORDER BY wk DESC
$$;

-- (The weekly tab reuses get_tasks_kpis / get_tasks_by_rep with p_week_start,
--  so no separate per-rep weekly RPC is needed.)


-- ─── 5. GRANTS ─────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION tasks_visible_reps()                TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_tasks_kpis(INT, INT, TEXT, DATE) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_tasks_by_rep(INT, INT, DATE)    TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_tasks_by_status(TEXT)           TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_tasks_weekly(INT, TEXT)         TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_tasks_wow(TEXT)                 TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_tasks_available_weeks(INT)      TO anon, authenticated, service_role;


-- ─── 6. SYNC STATE SEED ────────────────────────────────────────────────────────
-- The edge function reads/writes sync_state key 'crm_tasks'. Seed it so the first
-- incremental run has an anchor (7 days back). A full sync ignores this pointer.
INSERT INTO sync_state (key, last_modified_time, updated_at)
VALUES ('crm_tasks', NOW() - INTERVAL '7 days', NOW())
ON CONFLICT (key) DO NOTHING;
