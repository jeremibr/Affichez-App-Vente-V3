-- Close the remaining tables to anonymous readers.
--
-- 20260903040000 did this for `invoices` and noted the rest of the schema needed
-- auditing. It did. Verified 2026-09-18 with nothing but VITE_SUPABASE_ANON_KEY,
-- which ships inside the built JS bundle and is public to anyone with the site
-- URL — no login, no session:
--
--   sales                8 085 rows   client names, amounts, reps, offices
--   webhook_log        103 170 rows   sync history and error messages
--   rep_objectives         105 rows   per-rep revenue targets
--   objectives              72 rows   company revenue targets by department
--   objectives_factures     72 rows   same, invoicing side
--   fiscal_quarters          8 rows
--   excluded_clients         2 rows
--   excluded_reps            1 row
--   sync_state               7 rows
--
-- Already protected and left alone: invoices, allowed_users, zoho_tasks,
-- zoho_leads, zoho_accounts, rep_objectives_dept.
--
-- ─── The trap in this migration ──────────────────────────────────────────────
--
-- Every dashboard RPC is SECURITY INVOKER, so it reads these tables AS THE
-- CALLER and is subject to their policies. Two of them are read through
-- `NOT IN (SELECT ...)` in 22 places each:
--
--   AND client_name NOT IN (SELECT client_name FROM excluded_clients)
--   AND rep_name    NOT IN (SELECT rep_name    FROM excluded_reps)
--
-- Enabling RLS on those two WITHOUT a SELECT policy for `authenticated` does not
-- raise an error. The subquery simply returns zero rows, `NOT IN ()` is true for
-- everything, and every excluded client and the internal sales rep silently
-- reappear in every total on every page. A security fix would have become a
-- reporting defect, which is exactly the failure mode STATS-INTEGRITY.md is
-- about. Same reasoning for objectives, rep_objectives and fiscal_quarters: an
-- RPC that cannot see them returns 0 targets and 0 % rather than failing.
--
-- So every table an RPC reads gets an explicit SELECT policy for authenticated.
--
-- ─── Policy per table ────────────────────────────────────────────────────────
--
-- FOR ALL    where the app writes as a logged-in user (Réglages CRUD), matching
--            the leads_all_authenticated pattern in supabase_leads.sql.
-- FOR SELECT where the app only reads and the writer is a sync edge function
--            using the service-role key, which bypasses RLS entirely.
--
-- Writes from the syncs are unaffected throughout: service_role bypasses RLS.
--
-- Note carried over from 20260903040000: `GRANT EXECUTE ... TO authenticated` on
-- the RPCs is decorative, because Postgres grants EXECUTE to PUBLIC by default
-- and nothing revokes it. Anon can still CALL every RPC after this migration —
-- it will just get zeros back, because table RLS is the only real boundary.


-- ── sales — read by the app (MonthlyDetail) and by the devis RPCs ───────────
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sales_select_authenticated" ON sales;
CREATE POLICY "sales_select_authenticated"
  ON sales FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE sales IS
  'Zoho Books estimates that reached accepted/invoiced, both organisations. '
  'Holds WON quotes only — see STATS-INTEGRITY.md before computing any ratio. '
  'RLS: readable by authenticated users only; written solely by zoho-sync under '
  'the service-role key.';


-- ── Exclusion lists — read via NOT IN by 22 RPCs each ───────────────────────
-- excluded_clients is maintained from Réglages, so it needs write access too.
ALTER TABLE excluded_clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "excluded_clients_all_authenticated" ON excluded_clients;
CREATE POLICY "excluded_clients_all_authenticated"
  ON excluded_clients FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- excluded_reps is not edited from the UI; it holds the single row
-- 'Vente interne'. Read-only is enough, and the RPCs must be able to see it.
ALTER TABLE excluded_reps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "excluded_reps_select_authenticated" ON excluded_reps;
CREATE POLICY "excluded_reps_select_authenticated"
  ON excluded_reps FOR SELECT TO authenticated USING (true);


-- ── Objectives — read by the KPI/sommaire RPCs ──────────────────────────────
-- `objectives` (devis) is not written from the app today; read-only.
ALTER TABLE objectives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "objectives_select_authenticated" ON objectives;
CREATE POLICY "objectives_select_authenticated"
  ON objectives FOR SELECT TO authenticated USING (true);

-- objectives_factures is inserted and deleted from ObjectifsEquipe / Réglages.
ALTER TABLE objectives_factures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "objectives_factures_all_authenticated" ON objectives_factures;
CREATE POLICY "objectives_factures_all_authenticated"
  ON objectives_factures FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- rep_objectives is upserted from PortailParametres / PortailObjectifs, and read
-- by every RPC that resolves a single rep's target.
ALTER TABLE rep_objectives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rep_objectives_all_authenticated" ON rep_objectives;
CREATE POLICY "rep_objectives_all_authenticated"
  ON rep_objectives FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ── fiscal_quarters — read by Réglages and by the quarterly YoY RPCs ────────
-- Displayed only; the calendar is not edited from the UI.
ALTER TABLE fiscal_quarters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fiscal_quarters_select_authenticated" ON fiscal_quarters;
CREATE POLICY "fiscal_quarters_select_authenticated"
  ON fiscal_quarters FOR SELECT TO authenticated USING (true);


-- ── webhook_log — written by the syncs, read by the Réglages log panel ──────
ALTER TABLE webhook_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "webhook_log_select_authenticated" ON webhook_log;
CREATE POLICY "webhook_log_select_authenticated"
  ON webhook_log FOR SELECT TO authenticated USING (true);


-- ── sync_state — sync bookkeeping, nothing in the app reads it ──────────────
-- No policy on purpose: only the edge functions touch it, and they hold the
-- service-role key. If a future page needs it, add a SELECT policy rather than
-- disabling RLS.
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
