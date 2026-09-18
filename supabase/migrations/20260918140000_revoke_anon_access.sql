-- Take the public schema away from the `anon` role.
--
-- 20260903040000 closed `invoices` with RLS and noted the rest of the schema
-- needed auditing. It did, and RLS turned out to be the wrong instrument for the
-- job. Audited 2026-09-18 against production.
--
-- ─── What was actually wrong ─────────────────────────────────────────────────
--
-- `anon` — the role behind VITE_SUPABASE_ANON_KEY, which ships inside the built
-- JS bundle and is public to anyone with the site URL — held
--
--     DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- on all 38 objects in `public`. Not SELECT. Everything. That is Supabase's
-- default blanket grant, and RLS was the only thing standing in front of it.
--
-- Seven tables had no RLS at all, so for those the grant was live and unguarded
-- to any unauthenticated caller:
--
--     paye_entries          payroll
--     rep_objectives        per-rep revenue targets
--     objectives_factures   invoicing targets
--     excluded_clients, excluded_reps, paye_meta, sync_state
--
-- The rest had RLS enabled but a permissive policy that let `anon` read anyway —
-- verified by fetching 8,085 rows from `sales`, 103,170 from `webhook_log` and
-- 105 from `rep_objectives` with nothing but the anon key.
--
-- And RLS could never have finished the job regardless:
--
--   * 8 of the 13 views run with OWNER rights (no security_invoker), so base
--     table RLS does not apply to them at all. `invoices` correctly returned
--     zero rows to anon while `v_inv_weekly_summary` handed over 4,270 rows of
--     the same data — the 2026-09-03 fix has been bypassed since the day it
--     shipped.
--   * `zoho_service_labels` is a MATERIALIZED view. Materialized views do not
--     support RLS in any form. Only a revoke reaches them.
--
-- ─── Why a revoke rather than more policies ──────────────────────────────────
--
-- A privilege check happens before any policy is consulted, so removing the
-- grant closes tables, views and materialized views in one statement and does
-- not depend on getting ~20 policies right across objects whose definitions are
-- not even in this repo.
--
-- Nothing in the app reads a table before login — verified across Login.tsx and
-- AuthContext.tsx — and a signed-in user authenticates as `authenticated`, a
-- different role that keeps every grant it has today. The sync edge functions
-- all hold the service-role key, which is unaffected.
--
-- Precedent in this same database: `zoho_oauth_token` is the only object absent
-- from anon's grant list, because 20260825181500 revoked it explicitly. That is
-- this mechanism, already working here.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- ALL TABLES covers tables and views but not materialized views; this one is
-- read by four RPCs and was returning rows to anon.
REVOKE ALL ON public.zoho_service_labels FROM anon;

-- Without this, the next table anybody creates arrives with the same blanket
-- grant and quietly re-opens the door.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;


-- ─── Defence in depth: RLS on the seven tables that had none ─────────────────
--
-- The revoke above is what closes the hole. These policies are the second layer,
-- so that a future re-grant (a dashboard click, a restored backup, someone
-- running Supabase's default GRANT again) does not silently reopen it.
--
-- Policies match what the app actually does, checked call site by call site:
-- FOR ALL where a signed-in user writes from Réglages or Portail, FOR SELECT
-- where the app only reads and the writer is a sync edge function.
--
-- One trap worth naming, because it fails silently rather than loudly: the
-- dashboard RPCs are SECURITY INVOKER and read excluded_clients / excluded_reps
-- through `NOT IN (SELECT ...)` in 22 places each. Enabling RLS on those two
-- without a SELECT policy for `authenticated` raises no error — the subquery
-- returns zero rows, `NOT IN ()` is true for everything, and every excluded
-- client plus the internal sales rep reappears in every total on every page.
-- Hence the explicit SELECT policies below.

-- Réglages inserts and deletes these.
ALTER TABLE excluded_clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "excluded_clients_all_authenticated" ON excluded_clients;
CREATE POLICY "excluded_clients_all_authenticated"
  ON excluded_clients FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Not edited from the UI; holds the single row 'Vente interne'. The RPCs must
-- still be able to see it — see the trap above.
ALTER TABLE excluded_reps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "excluded_reps_select_authenticated" ON excluded_reps;
CREATE POLICY "excluded_reps_select_authenticated"
  ON excluded_reps FOR SELECT TO authenticated USING (true);

-- ObjectifsEquipe / Réglages insert and delete these.
ALTER TABLE objectives_factures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "objectives_factures_all_authenticated" ON objectives_factures;
CREATE POLICY "objectives_factures_all_authenticated"
  ON objectives_factures FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- PortailParametres / PortailObjectifs upsert these; every RPC that resolves a
-- single rep's target reads them.
ALTER TABLE rep_objectives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rep_objectives_all_authenticated" ON rep_objectives;
CREATE POLICY "rep_objectives_all_authenticated"
  ON rep_objectives FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- PortailPaye does full CRUD on both. rep_comm_rates beside them was already
-- protected, which is how these two stood out.
ALTER TABLE paye_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "paye_entries_all_authenticated" ON paye_entries;
CREATE POLICY "paye_entries_all_authenticated"
  ON paye_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE paye_meta ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "paye_meta_all_authenticated" ON paye_meta;
CREATE POLICY "paye_meta_all_authenticated"
  ON paye_meta FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Sync bookkeeping. No policy on purpose: only the edge functions touch it and
-- they hold the service-role key. If a page ever needs it, add a SELECT policy
-- rather than disabling RLS.
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;


COMMENT ON TABLE sales IS
  'Zoho Books estimates that reached accepted/invoiced, both organisations. '
  'Holds WON quotes only — see STATS-INTEGRITY.md before computing any ratio. '
  'Written solely by zoho-sync under the service-role key.';

-- Left for a follow-up, deliberately: Postgres grants EXECUTE on functions to
-- PUBLIC by default and nothing here revokes it, so anon can still CALL every
-- RPC. After this migration those calls fail on the underlying table privilege
-- instead of returning data, which is the correct outcome but a noisier one
-- than refusing the call outright.
