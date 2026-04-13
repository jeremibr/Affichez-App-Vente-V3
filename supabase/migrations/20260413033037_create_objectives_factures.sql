-- Separate objectives table for Factures module
CREATE TABLE IF NOT EXISTS objectives_factures (
  id            serial PRIMARY KEY,
  year          int NOT NULL,
  month         int NOT NULL CHECK (month BETWEEN 1 AND 12),
  department    text NOT NULL,
  target_amount numeric(12,2) NOT NULL DEFAULT 0,
  UNIQUE(year, month, department)
);
