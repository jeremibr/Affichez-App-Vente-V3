-- Indexes for the two joins and one scan that dominate the dashboards.


-- ── 1. The account → invoices rollup ────────────────────────────────────────
--
-- Three Comptes RPCs join every scoped account to its invoices and sum the
-- amounts inside the attribution window. The existing index carries only
-- crm_account_id, so the plan was:
--
--   Index Only Scan using invoices_crm_account_idx  (rows=17758)
--     Heap Fetches: 17230          <-- 97% of them
--
-- "Index Only Scan" in name only: invoice_date and amount are not in the index,
-- so it went to the heap for almost every row. INCLUDE puts both in the leaf
-- pages and the scan stays in the index.
--
-- Note this index is NOT partial. The old one is `WHERE crm_account_id IS NOT
-- NULL`, which is right for looking a single account up, but these queries walk
-- the whole index, and a partial index cannot be used for an index-only scan
-- when the planner also wants the rows it excludes. Both are kept: the partial
-- one is smaller and still wins for the single-account lookups behind the
-- Factures panel.

CREATE INDEX IF NOT EXISTS invoices_crm_account_cover_idx
  ON public.invoices (crm_account_id)
  INCLUDE (invoice_date, amount);


-- ── 2. zoho_tasks, which had no index on its dates at all ───────────────────
--
-- get_tasks_weekly took 1366 ms, essentially all of it here:
--
--   Seq Scan on zoho_tasks (actual time=1215.651..1324.487 rows=7352)
--     Filter: (EXTRACT(isoyear FROM created_time))::integer = 2026
--     Rows Removed by Filter: 54612
--
-- 62k rows read to return 38. The EXTRACT is dealt with in the next migration;
-- these are the indexes that rewrite then has something to use.
--
-- closed_time is partial because two thirds of tasks are still open, and every
-- query that touches it already says `closed_time IS NOT NULL`.

CREATE INDEX IF NOT EXISTS zoho_tasks_created_idx
  ON public.zoho_tasks (created_time);

CREATE INDEX IF NOT EXISTS zoho_tasks_closed_idx
  ON public.zoho_tasks (closed_time)
  WHERE closed_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS zoho_tasks_rep_created_idx
  ON public.zoho_tasks (rep_name, created_time);


-- ── 3. sales and invoices by year ───────────────────────────────────────────
--
-- The Devis and Factures dashboards are already fast (19-46 ms), but they get
-- there by seq-scanning small tables. These keep them fast as the tables grow,
-- and they cost almost nothing on 8k and 18k rows.
--
-- sales.year is a plain integer column, so this one is an ordinary btree.

CREATE INDEX IF NOT EXISTS sales_year_month_idx
  ON public.sales (year, month);

CREATE INDEX IF NOT EXISTS sales_sale_date_idx
  ON public.sales (sale_date);
