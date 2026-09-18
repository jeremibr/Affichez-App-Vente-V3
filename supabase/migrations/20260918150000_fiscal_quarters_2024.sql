-- Give 2025 a year to be compared against.
--
-- fiscal_quarters started at 2025-01-01. The quarterly YoY functions inner-join
-- sales to it and read the comparison year as `fq.year = p_year - 1`, so asking
-- for 2025 looked for 2024 quarters that did not exist:
--
--   get_quarterly_yoy_totals(2025) -> previous_total = 0 for Q1, Q2, Q3 and Q4
--
-- while `sales` holds 1,868 rows dated 2024. QuarterBlock.tsx renders
-- `totalCurrent - totalPrevious`, so every quarter of 2025 showed the whole
-- current figure as a green TrendingUp gain against a year that was simply never
-- queried. Verified against production 2026-09-18.
--
-- The calendar is calendar quarters, and num_weeks is a nominal 13 rather than a
-- measured length — 2025 Q1 is 90 days, Q3 is 92, both recorded as 13. 2024
-- follows the same shape; its Q1 is 91 days (leap year) and is likewise 13,
-- which keeps the weekly-rate denominator consistent with every other quarter.
--
-- Written as an anti-join rather than ON CONFLICT so it does not depend on the
-- name or existence of a unique constraint, and so re-running it is a no-op.

INSERT INTO fiscal_quarters (year, quarter, start_date, end_date, num_weeks)
SELECT v.year, v.quarter, v.start_date, v.end_date, v.num_weeks
  FROM (VALUES
    (2024, 1, DATE '2024-01-01', DATE '2024-03-31', 13),
    (2024, 2, DATE '2024-04-01', DATE '2024-06-30', 13),
    (2024, 3, DATE '2024-07-01', DATE '2024-09-30', 13),
    (2024, 4, DATE '2024-10-01', DATE '2024-12-31', 13)
  ) AS v(year, quarter, start_date, end_date, num_weeks)
 WHERE NOT EXISTS (
   SELECT 1 FROM fiscal_quarters f
    WHERE f.year = v.year AND f.quarter = v.quarter
 );

-- What this does NOT fix, on purpose.
--
-- The defect underneath is that a missing calendar year returns 0 rather than
-- "unknown", and 0 reads as a fact. Adding 2024 removes today's wrong number but
-- leaves that trap armed for the next year nobody adds rows for.
--
-- Fixing it properly means returning NULL for previous_total when p_year - 1 has
-- no fiscal_quarters rows, and rendering "—" instead of computing a delta. That
-- is deliberately not attempted here, because only two of the four functions
-- involved are in this repo: get_quarterly_yoy_totals and
-- get_inv_quarterly_yoy_totals live in supabase_quarterly_totals.sql, while the
-- per-rep get_quarterly_yoy and get_inv_quarterly_yoy exist only in the database.
-- Changing the two visible ones would make the team total print "—" while the rep
-- rows beneath it still printed 0 — a worse screen than today's.
--
-- Prerequisite for that follow-up: pull those two functions into the repo first.
-- See STATS-INTEGRITY.md.
