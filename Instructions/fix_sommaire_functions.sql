-- ============================================================
-- FIX: get_sommaire_grand_total & get_sommaire
-- Issue: "column reference month is ambiguous" — the RETURNS TABLE
-- output names clash with CTE column names in PL/pgSQL.
-- Fix: Alias all CTE columns to avoid collisions.
-- ============================================================
-- Run this in the Supabase SQL Editor (one paste, one click).
-- ============================================================


-- ── Drop existing functions ──────────────────────────────────
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT oid::regprocedure::text AS sig
        FROM   pg_proc
        WHERE  proname IN ('get_sommaire_grand_total', 'get_sommaire')
          AND  pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
    END LOOP;
END;
$$;


-- ── 1. Grand total (all departments combined) ────────────────
CREATE FUNCTION get_sommaire_grand_total(
  p_year    INTEGER,
  p_office  TEXT    DEFAULT NULL,
  p_status  TEXT    DEFAULT NULL
)
RETURNS TABLE (
  month         INTEGER,
  objectif      NUMERIC,
  actual_amount NUMERIC,
  pct_atteint   NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o.month AS o_month, SUM(o.target_amount) AS o_total
    FROM   objectives o
    WHERE  o.year = p_year
    GROUP  BY o.month
  ),
  sales_agg AS (
    SELECT s.month AS s_month, COALESCE(SUM(s.amount), 0) AS s_total
    FROM   sales s
    WHERE  s.year = p_year
      AND  (p_office IS NULL OR s.office::TEXT = p_office)
      AND  (p_status IS NULL OR s.status::TEXT = p_status)
    GROUP  BY s.month
  ),
  all_months AS (
    SELECT o_month AS m FROM obj
    UNION
    SELECT s_month AS m FROM sales_agg
  )
  SELECT
    am.m::INTEGER,
    COALESCE(o.o_total, 0),
    COALESCE(sa.s_total, 0),
    CASE
      WHEN COALESCE(o.o_total, 0) > 0
      THEN ROUND((COALESCE(sa.s_total, 0) / o.o_total) * 100, 2)
      ELSE 0::NUMERIC
    END
  FROM       all_months am
  LEFT JOIN  obj        o  ON o.o_month  = am.m
  LEFT JOIN  sales_agg  sa ON sa.s_month = am.m
  ORDER BY   am.m;
END;
$$ LANGUAGE plpgsql;


-- ── 2. Per-department breakdown ──────────────────────────────
CREATE FUNCTION get_sommaire(
  p_year    INTEGER,
  p_office  TEXT    DEFAULT NULL,
  p_status  TEXT    DEFAULT NULL
)
RETURNS TABLE (
  month         INTEGER,
  department    department_enum,
  objectif      NUMERIC,
  actual_amount NUMERIC,
  pct_atteint   NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o.month AS o_month, o.department AS o_dept, o.target_amount AS o_total
    FROM   objectives o
    WHERE  o.year = p_year
  ),
  sales_agg AS (
    SELECT s.month AS s_month, s.department AS s_dept, COALESCE(SUM(s.amount), 0) AS s_total
    FROM   sales s
    WHERE  s.year = p_year
      AND  (p_office IS NULL OR s.office::TEXT = p_office)
      AND  (p_status IS NULL OR s.status::TEXT = p_status)
    GROUP  BY s.month, s.department
  ),
  all_combos AS (
    SELECT o_month AS m, o_dept AS d FROM obj
    UNION
    SELECT s_month AS m, s_dept AS d FROM sales_agg
  )
  SELECT
    ac.m::INTEGER,
    ac.d,
    COALESCE(o.o_total, 0),
    COALESCE(sa.s_total, 0),
    CASE
      WHEN COALESCE(o.o_total, 0) > 0
      THEN ROUND((COALESCE(sa.s_total, 0) / o.o_total) * 100, 2)
      ELSE 0::NUMERIC
    END
  FROM       all_combos ac
  LEFT JOIN  obj        o  ON o.o_month = ac.m AND o.o_dept  = ac.d
  LEFT JOIN  sales_agg  sa ON sa.s_month = ac.m AND sa.s_dept = ac.d
  ORDER BY   ac.m, ac.d;
END;
$$ LANGUAGE plpgsql;


-- ── Reload PostgREST schema cache ────────────────────────────
NOTIFY pgrst, 'reload schema';
