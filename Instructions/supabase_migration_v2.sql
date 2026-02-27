-- ============================================================
-- RAPPORT DES DEVIS SIGNÉS — SUPABASE FULL SCHEMA v2
-- Run this in Supabase SQL Editor as a single migration
-- ============================================================

-- ============================================================
-- 1. ENUMS
-- ============================================================

CREATE TYPE department_enum AS ENUM (
  'MULTI-ANNONCEURS',
  'PROMOTIONNEL',
  'DIST. PUBLICITAIRE SOLO',
  'NUMERIQUE',
  'APPLICATION',
  'SERVICES IA'
);

CREATE TYPE office_enum AS ENUM ('QC', 'MTL');

-- ============================================================
-- 2. CORE TABLES
-- ============================================================

-- Sales reps
CREATE TABLE reps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  office office_enum NOT NULL DEFAULT 'QC',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Department mapping: Zoho label → internal department
-- Handles aliases like "AGENCE PUB" → NUMERIQUE, "MÉDIA MULTI-ANNONCEURS" → MULTI-ANNONCEURS
CREATE TABLE department_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zoho_label TEXT NOT NULL UNIQUE,
  internal_department department_enum NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Monthly objectives per department per year
CREATE TABLE objectives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  department department_enum NOT NULL,
  target_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, month, department)
);

-- Fiscal quarter definitions (custom 13-week periods)
CREATE TABLE fiscal_quarters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year INTEGER NOT NULL,
  quarter INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  num_weeks INTEGER NOT NULL DEFAULT 13,
  UNIQUE (year, quarter)
);

-- Sales (signed quotes) — synced from Zoho Books via webhook
CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zoho_id TEXT UNIQUE NOT NULL,                      -- Zoho estimate ID for dedup (UNIQUE already creates index)
  sale_date DATE NOT NULL,
  client_name TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,                     -- pre-tax amount
  quote_number TEXT,                                  -- e.g. SOUMQC-025742 or SOUMMTL-002213
  rep_id UUID NOT NULL REFERENCES reps(id),
  zoho_department_label TEXT NOT NULL,                -- raw label from Zoho (e.g. "AGENCE PUB")
  department department_enum NOT NULL,                -- resolved via department_mappings
  week_start DATE NOT NULL,                           -- auto-computed by trigger from sale_date
  week_end DATE NOT NULL,                             -- auto-computed by trigger from sale_date
  month INTEGER GENERATED ALWAYS AS (EXTRACT(MONTH FROM sale_date)::INTEGER) STORED,
  year INTEGER GENERATED ALWAYS AS (EXTRACT(YEAR FROM sale_date)::INTEGER) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhook delivery log — tracks every incoming Zoho webhook for debugging
CREATE TABLE webhook_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  zoho_id TEXT,
  action TEXT NOT NULL,                               -- 'upserted', 'deleted', 'ignored', 'error'
  status_code INTEGER NOT NULL DEFAULT 200,
  payload JSONB,                                      -- raw Zoho payload for debugging
  error_message TEXT
);

-- ============================================================
-- 3. INDEXES
-- ============================================================
-- Note: zoho_id UNIQUE constraint already creates an implicit index, no separate index needed

CREATE INDEX idx_sales_date ON sales (sale_date);
CREATE INDEX idx_sales_year_month ON sales (year, month);
CREATE INDEX idx_sales_rep ON sales (rep_id);
CREATE INDEX idx_sales_department ON sales (department);
CREATE INDEX idx_sales_week ON sales (week_start);
CREATE INDEX idx_objectives_year ON objectives (year);
CREATE INDEX idx_fiscal_quarters_year ON fiscal_quarters (year);
CREATE INDEX idx_webhook_log_received ON webhook_log (received_at DESC);

-- ============================================================
-- 4. AUTO-UPDATE TIMESTAMPS
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reps_updated_at
  BEFORE UPDATE ON reps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_objectives_updated_at
  BEFORE UPDATE ON objectives
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_sales_updated_at
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 5. AUTO-COMPUTE WEEK BOUNDARIES FROM sale_date
-- ============================================================
-- The Edge Function does NOT send week_start/week_end.
-- This trigger is the single source of truth for week boundaries.
-- Fires on INSERT (always) and UPDATE (only when sale_date changes).

CREATE OR REPLACE FUNCTION compute_week_boundaries()
RETURNS TRIGGER AS $$
BEGIN
  -- ISO week: Monday (1) to Sunday (7)
  NEW.week_start := (NEW.sale_date - ((EXTRACT(ISODOW FROM NEW.sale_date)::INTEGER - 1) || ' days')::INTERVAL)::DATE;
  NEW.week_end := (NEW.week_start + INTERVAL '6 days')::DATE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sales_week_boundaries
  BEFORE INSERT OR UPDATE OF sale_date ON sales
  FOR EACH ROW EXECUTE FUNCTION compute_week_boundaries();

-- ============================================================
-- 6. VIEWS — Replace all Google Sheet formulas
-- ============================================================

-- VIEW: Weekly summary per rep per department (replaces Zone A of weekly sheets)
CREATE OR REPLACE VIEW v_weekly_summary AS
SELECT
  s.week_start,
  s.week_end,
  r.name AS rep_name,
  r.office,
  s.department,
  COALESCE(SUM(s.amount), 0) AS total_amount,
  COUNT(*) AS num_sales
FROM sales s
JOIN reps r ON r.id = s.rep_id
GROUP BY s.week_start, s.week_end, r.name, r.office, s.department
ORDER BY s.week_start DESC, r.name, s.department;

-- VIEW: Weekly totals per department (replaces Totaux row in weekly sheets)
CREATE OR REPLACE VIEW v_weekly_dept_totals AS
SELECT
  week_start,
  week_end,
  department,
  COALESCE(SUM(amount), 0) AS total_amount,
  COUNT(*) AS num_sales
FROM sales
GROUP BY week_start, week_end, department
ORDER BY week_start DESC, department;

-- VIEW: Weekly grand total
CREATE OR REPLACE VIEW v_weekly_grand_totals AS
SELECT
  week_start,
  week_end,
  COALESCE(SUM(amount), 0) AS total_amount,
  COUNT(*) AS num_sales
FROM sales
GROUP BY week_start, week_end
ORDER BY week_start DESC;

-- VIEW: Monthly totals per department (replaces SOMMAIRE Section B)
CREATE OR REPLACE VIEW v_monthly_dept_totals AS
SELECT
  year,
  month,
  department,
  COALESCE(SUM(amount), 0) AS total_amount
FROM sales
GROUP BY year, month, department
ORDER BY year, month, department;

-- VIEW: Monthly grand totals (replaces SOMMAIRE Section A)
CREATE OR REPLACE VIEW v_monthly_grand_totals AS
SELECT
  year,
  month,
  COALESCE(SUM(amount), 0) AS total_amount
FROM sales
GROUP BY year, month
ORDER BY year, month;

-- VIEW: Monthly totals per rep (for rep-level dashboard drill-down)
CREATE OR REPLACE VIEW v_monthly_rep_totals AS
SELECT
  s.year,
  s.month,
  r.name AS rep_name,
  r.office,
  s.department,
  COALESCE(SUM(s.amount), 0) AS total_amount,
  COUNT(*) AS num_sales
FROM sales s
JOIN reps r ON r.id = s.rep_id
GROUP BY s.year, s.month, r.name, r.office, s.department
ORDER BY s.year, s.month, r.name, s.department;

-- VIEW: SOMMAIRE with objectives and % atteint (full dashboard view)
CREATE OR REPLACE VIEW v_sommaire AS
SELECT
  o.year,
  o.month,
  o.department,
  o.target_amount AS objectif,
  COALESCE(m.total_amount, 0) AS actual_amount,
  CASE
    WHEN o.target_amount > 0 THEN ROUND((COALESCE(m.total_amount, 0) / o.target_amount) * 100, 2)
    ELSE 0
  END AS pct_atteint
FROM objectives o
LEFT JOIN v_monthly_dept_totals m
  ON m.year = o.year AND m.month = o.month AND m.department = o.department
ORDER BY o.year, o.month, o.department;

-- VIEW: Sommaire grand total (all departments combined)
CREATE OR REPLACE VIEW v_sommaire_grand_total AS
SELECT
  year,
  month,
  SUM(objectif) AS objectif,
  SUM(actual_amount) AS actual_amount,
  CASE
    WHEN SUM(objectif) > 0 THEN ROUND((SUM(actual_amount) / SUM(objectif)) * 100, 2)
    ELSE 0
  END AS pct_atteint
FROM v_sommaire
GROUP BY year, month
ORDER BY year, month;

-- VIEW: Quarterly averages per rep (replaces Moyennes sheet)
-- FIX: COALESCE on SUM to handle reps with $0 in a quarter (NULL / 13 = NULL bug)
CREATE OR REPLACE VIEW v_quarterly_rep_averages AS
SELECT
  fq.year,
  fq.quarter,
  r.name AS rep_name,
  COALESCE(SUM(s.amount), 0) AS quarter_total,
  fq.num_weeks,
  ROUND(COALESCE(SUM(s.amount), 0) / fq.num_weeks, 2) AS weekly_average
FROM fiscal_quarters fq
CROSS JOIN reps r
LEFT JOIN sales s
  ON s.rep_id = r.id
  AND s.sale_date BETWEEN fq.start_date AND fq.end_date
WHERE r.is_active = true
GROUP BY fq.year, fq.quarter, fq.num_weeks, r.name
ORDER BY fq.year, fq.quarter, r.name;

-- VIEW: YoY quarterly comparison (current vs previous year)
-- FIX: COALESCE on both sides to prevent NULL subtraction
CREATE OR REPLACE VIEW v_quarterly_yoy AS
SELECT
  curr.year AS current_year,
  curr.quarter,
  curr.rep_name,
  COALESCE(curr.weekly_average, 0) AS current_avg,
  COALESCE(prev.weekly_average, 0) AS previous_avg,
  ROUND(COALESCE(curr.weekly_average, 0) - COALESCE(prev.weekly_average, 0), 2) AS resultat
FROM v_quarterly_rep_averages curr
LEFT JOIN v_quarterly_rep_averages prev
  ON prev.rep_name = curr.rep_name
  AND prev.year = curr.year - 1
  AND prev.quarter = curr.quarter
ORDER BY curr.year DESC, curr.quarter, curr.rep_name;

-- ============================================================
-- 7. RPC FUNCTIONS (for the frontend to call)
-- ============================================================

-- Get weekly detail (raw sales for a specific week — replaces Zone B)
CREATE OR REPLACE FUNCTION get_weekly_detail(p_week_start DATE)
RETURNS TABLE (
  sale_date DATE,
  client_name TEXT,
  amount NUMERIC,
  quote_number TEXT,
  rep_name TEXT,
  department department_enum,
  zoho_department_label TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.sale_date,
    s.client_name,
    s.amount,
    s.quote_number,
    r.name,
    s.department,
    s.zoho_department_label
  FROM sales s
  JOIN reps r ON r.id = s.rep_id
  WHERE s.week_start = p_week_start
  ORDER BY s.sale_date, r.name;
END;
$$ LANGUAGE plpgsql;

-- Get all distinct weeks for navigation
CREATE OR REPLACE FUNCTION get_available_weeks(p_year INTEGER DEFAULT NULL)
RETURNS TABLE (
  week_start DATE,
  week_end DATE,
  total_amount NUMERIC,
  num_sales BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.week_start,
    s.week_end,
    COALESCE(SUM(s.amount), 0),
    COUNT(*)
  FROM sales s
  WHERE (p_year IS NULL OR s.year = p_year)
  GROUP BY s.week_start, s.week_end
  ORDER BY s.week_start DESC;
END;
$$ LANGUAGE plpgsql;

-- Get sommaire for a specific year (dashboard)
CREATE OR REPLACE FUNCTION get_sommaire(p_year INTEGER)
RETURNS TABLE (
  month INTEGER,
  department department_enum,
  objectif NUMERIC,
  actual_amount NUMERIC,
  pct_atteint NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT v.month, v.department, v.objectif, v.actual_amount, v.pct_atteint
  FROM v_sommaire v
  WHERE v.year = p_year
  ORDER BY v.month, v.department;
END;
$$ LANGUAGE plpgsql;

-- Get sommaire grand total for a specific year
CREATE OR REPLACE FUNCTION get_sommaire_grand_total(p_year INTEGER)
RETURNS TABLE (
  month INTEGER,
  objectif NUMERIC,
  actual_amount NUMERIC,
  pct_atteint NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT v.month, v.objectif, v.actual_amount, v.pct_atteint
  FROM v_sommaire_grand_total v
  WHERE v.year = p_year
  ORDER BY v.month;
END;
$$ LANGUAGE plpgsql;

-- Get quarterly YoY comparison for a specific year
CREATE OR REPLACE FUNCTION get_quarterly_yoy(p_year INTEGER)
RETURNS TABLE (
  quarter INTEGER,
  rep_name TEXT,
  current_avg NUMERIC,
  previous_avg NUMERIC,
  resultat NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT v.quarter, v.rep_name, v.current_avg, v.previous_avg, v.resultat
  FROM v_quarterly_yoy v
  WHERE v.current_year = p_year
  ORDER BY v.quarter, v.rep_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 8. ROW LEVEL SECURITY (RLS)
-- ============================================================
-- service_role key (used by Edge Function) bypasses RLS entirely.
-- Authenticated users can only READ. No write policies = no writes from frontend.

ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE objectives ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_quarters ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read" ON reps FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON sales FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON objectives FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON department_mappings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON fiscal_quarters FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON webhook_log FOR SELECT TO authenticated USING (true);

-- ============================================================
-- 9. SEED DATA
-- ============================================================

-- Sales reps (names must match Zoho Books salesperson names EXACTLY)
INSERT INTO reps (name, office) VALUES
  ('Dominic Letendre', 'QC'),
  ('Kim Foster Cunningham', 'QC'),
  ('Paul Ayoub', 'MTL'),
  ('Simon Fortin Massé', 'QC'),
  ('Sylvain Desrosiers', 'QC'),
  ('Richard Courville', 'MTL'),
  ('Guillaume Montambeault', 'QC'),
  ('Morgane Owczarzak', 'QC');

-- Department mappings (Zoho custom field value → internal enum)
INSERT INTO department_mappings (zoho_label, internal_department) VALUES
  ('MÉDIA MULTI-ANNONCEURS', 'MULTI-ANNONCEURS'),
  ('MULTI-ANNONCEURS', 'MULTI-ANNONCEURS'),
  ('PROMOTIONNEL', 'PROMOTIONNEL'),
  ('DIST. PUBLICITAIRE SOLO', 'DIST. PUBLICITAIRE SOLO'),
  ('AGENCE PUB', 'NUMERIQUE'),
  ('NUMÉRIQUE', 'NUMERIQUE'),
  ('APPLICATION', 'APPLICATION'),
  ('SERVICES IA', 'SERVICES IA');

-- 2026 Fiscal quarters (13 weeks each, starting late Dec 2025)
INSERT INTO fiscal_quarters (year, quarter, start_date, end_date, num_weeks) VALUES
  (2026, 1, '2025-12-29', '2026-03-29', 13),
  (2026, 2, '2026-03-30', '2026-06-28', 13),
  (2026, 3, '2026-06-29', '2026-09-27', 13),
  (2026, 4, '2026-09-28', '2026-12-27', 13);

-- 2025 Fiscal quarters (for YoY comparison)
INSERT INTO fiscal_quarters (year, quarter, start_date, end_date, num_weeks) VALUES
  (2025, 1, '2024-12-30', '2025-03-30', 13),
  (2025, 2, '2025-03-31', '2025-06-29', 13),
  (2025, 3, '2025-06-30', '2025-09-28', 13),
  (2025, 4, '2025-09-29', '2025-12-28', 13);

-- 2026 Monthly objectives (from the SOMMAIRE sheet)
INSERT INTO objectives (year, month, department, target_amount) VALUES
  -- January
  (2026, 1, 'MULTI-ANNONCEURS', 134369.30),
  (2026, 1, 'PROMOTIONNEL', 83384.58),
  (2026, 1, 'DIST. PUBLICITAIRE SOLO', 53163.02),
  (2026, 1, 'NUMERIQUE', 94965.47),
  (2026, 1, 'APPLICATION', 16500.00),
  (2026, 1, 'SERVICES IA', 16000.00),
  -- February
  (2026, 2, 'MULTI-ANNONCEURS', 230212.89),
  (2026, 2, 'PROMOTIONNEL', 154189.40),
  (2026, 2, 'DIST. PUBLICITAIRE SOLO', 69243.81),
  (2026, 2, 'NUMERIQUE', 68260.12),
  (2026, 2, 'APPLICATION', 16500.00),
  (2026, 2, 'SERVICES IA', 19000.00),
  -- March
  (2026, 3, 'MULTI-ANNONCEURS', 448328.06),
  (2026, 3, 'PROMOTIONNEL', 177844.87),
  (2026, 3, 'DIST. PUBLICITAIRE SOLO', 61545.76),
  (2026, 3, 'NUMERIQUE', 103549.66),
  (2026, 3, 'APPLICATION', 16500.00),
  (2026, 3, 'SERVICES IA', 21000.00),
  -- April
  (2026, 4, 'MULTI-ANNONCEURS', 537806.49),
  (2026, 4, 'PROMOTIONNEL', 157335.44),
  (2026, 4, 'DIST. PUBLICITAIRE SOLO', 100555.83),
  (2026, 4, 'NUMERIQUE', 142335.63),
  (2026, 4, 'APPLICATION', 16500.00),
  (2026, 4, 'SERVICES IA', 22000.00),
  -- May
  (2026, 5, 'MULTI-ANNONCEURS', 463842.40),
  (2026, 5, 'PROMOTIONNEL', 239363.24),
  (2026, 5, 'DIST. PUBLICITAIRE SOLO', 100011.95),
  (2026, 5, 'NUMERIQUE', 73257.01),
  (2026, 5, 'APPLICATION', 16500.00),
  (2026, 5, 'SERVICES IA', 25000.00),
  -- June
  (2026, 6, 'MULTI-ANNONCEURS', 334466.00),
  (2026, 6, 'PROMOTIONNEL', 139559.14),
  (2026, 6, 'DIST. PUBLICITAIRE SOLO', 88355.30),
  (2026, 6, 'NUMERIQUE', 90946.59),
  (2026, 6, 'APPLICATION', 16500.00),
  (2026, 6, 'SERVICES IA', 25000.00),
  -- July
  (2026, 7, 'MULTI-ANNONCEURS', 276499.12),
  (2026, 7, 'PROMOTIONNEL', 145682.00),
  (2026, 7, 'DIST. PUBLICITAIRE SOLO', 57340.69),
  (2026, 7, 'NUMERIQUE', 57012.96),
  (2026, 7, 'APPLICATION', 16500.00),
  (2026, 7, 'SERVICES IA', 27000.00),
  -- August
  (2026, 8, 'MULTI-ANNONCEURS', 573728.41),
  (2026, 8, 'PROMOTIONNEL', 160281.89),
  (2026, 8, 'DIST. PUBLICITAIRE SOLO', 140065.20),
  (2026, 8, 'NUMERIQUE', 88535.54),
  (2026, 8, 'APPLICATION', 16500.00),
  (2026, 8, 'SERVICES IA', 27000.00),
  -- September
  (2026, 9, 'MULTI-ANNONCEURS', 324897.64),
  (2026, 9, 'PROMOTIONNEL', 208578.11),
  (2026, 9, 'DIST. PUBLICITAIRE SOLO', 137152.19),
  (2026, 9, 'NUMERIQUE', 112496.34),
  (2026, 9, 'APPLICATION', 16500.00),
  (2026, 9, 'SERVICES IA', 29000.00),
  -- October
  (2026, 10, 'MULTI-ANNONCEURS', 131903.51),
  (2026, 10, 'PROMOTIONNEL', 227544.20),
  (2026, 10, 'DIST. PUBLICITAIRE SOLO', 119206.72),
  (2026, 10, 'NUMERIQUE', 110208.95),
  (2026, 10, 'APPLICATION', 16500.00),
  (2026, 10, 'SERVICES IA', 29000.00),
  -- November
  (2026, 11, 'MULTI-ANNONCEURS', 128194.70),
  (2026, 11, 'PROMOTIONNEL', 201898.24),
  (2026, 11, 'DIST. PUBLICITAIRE SOLO', 169700.43),
  (2026, 11, 'NUMERIQUE', 74484.94),
  (2026, 11, 'APPLICATION', 16500.00),
  (2026, 11, 'SERVICES IA', 30000.00),
  -- December
  (2026, 12, 'MULTI-ANNONCEURS', 59380.02),
  (2026, 12, 'PROMOTIONNEL', 76198.11),
  (2026, 12, 'DIST. PUBLICITAIRE SOLO', 130125.95),
  (2026, 12, 'NUMERIQUE', 73642.26),
  (2026, 12, 'APPLICATION', 16500.00),
  (2026, 12, 'SERVICES IA', 30000.00);

-- ============================================================
-- DONE. Database is ready for Zoho Books webhook integration.
-- ============================================================
--
-- TABLES (6):    reps, sales, objectives, department_mappings, fiscal_quarters, webhook_log
-- VIEWS (9):     v_weekly_summary, v_weekly_dept_totals, v_weekly_grand_totals,
--                v_monthly_dept_totals, v_monthly_grand_totals, v_monthly_rep_totals,
--                v_sommaire, v_sommaire_grand_total, v_quarterly_rep_averages, v_quarterly_yoy
-- RPC (5):       get_weekly_detail(), get_available_weeks(), get_sommaire(),
--                get_sommaire_grand_total(), get_quarterly_yoy()
-- RLS:           SELECT for authenticated, all writes via service_role only
-- TRIGGERS:      auto updated_at, auto week_start/week_end from sale_date
-- SEED:          8 reps, 8 dept mappings, 8 fiscal quarters, 72 monthly objectives
-- ============================================================
