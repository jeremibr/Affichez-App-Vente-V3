-- Payroll: only admins write, and a rep reads only their own lines.
--
-- 20260918140000 closed these two tables to `anon` and enabled RLS, but gave
-- every signed-in user a single `FOR ALL … USING (true) WITH CHECK (true)`
-- policy. That is read *and* write on everyone's pay for any employee who goes
-- around the screen. The UI is the only thing that stops them: PortailPaye
-- refuses to save unless `isAdmin`, which is a check in the browser, not a
-- guarantee.
--
-- This replaces those two policies with explicit per-command ones:
--
--   SELECT   the admins, plus the rep the row belongs to
--   INSERT   admins
--   UPDATE   admins
--   DELETE   admins
--
-- rep_comm_rates already had admin-only writes, but its SELECT was open to
-- every authenticated user, so a rep could read a colleague's commission rate.
-- It gets the same treatment, for the same reason.
--
-- "Admin" is `app_is_admin()`, which reads allowed_users.role — the same source
-- AuthContext uses for the UI and the same check ad_spend_daily and
-- zoho_accounts already use. The alternative in this database, reading
-- `user_metadata.role` out of the JWT, is a second definition that can drift
-- from the table; the policies below deliberately do not use it.
--
-- Every call is wrapped in a scalar sub-select — `(SELECT public.app_is_admin())`
-- — so the planner evaluates it once per statement (an InitPlan) instead of once
-- per row.

-- Which rep the caller is, or NULL for an admin with no rep row of their own.
--
-- SECURITY DEFINER, like app_is_admin(): a policy on payroll must not depend on
-- the caller's own RLS over allowed_users. Keep the SET clause — the rule in
-- CLAUDE.md against it covers SECURITY INVOKER helpers that need inlining.
CREATE OR REPLACE FUNCTION public.app_rep_name()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT au.rep_name
    FROM public.allowed_users au
   WHERE lower(au.email) = lower(auth.jwt() ->> 'email')
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.app_rep_name() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_rep_name() TO authenticated;


-- ─── paye_entries: one row per pay date ──────────────────────────────────────

DROP POLICY IF EXISTS "paye_entries_all_authenticated" ON public.paye_entries;
DROP POLICY IF EXISTS "paye_entries_select_own_or_admin" ON public.paye_entries;
DROP POLICY IF EXISTS "paye_entries_insert_admin"        ON public.paye_entries;
DROP POLICY IF EXISTS "paye_entries_update_admin"        ON public.paye_entries;
DROP POLICY IF EXISTS "paye_entries_delete_admin"        ON public.paye_entries;

CREATE POLICY "paye_entries_select_own_or_admin"
    ON public.paye_entries FOR SELECT TO authenticated
    USING ((SELECT public.app_is_admin()) OR rep_name = (SELECT public.app_rep_name()));

CREATE POLICY "paye_entries_insert_admin"
    ON public.paye_entries FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.app_is_admin()));

CREATE POLICY "paye_entries_update_admin"
    ON public.paye_entries FOR UPDATE TO authenticated
    USING ((SELECT public.app_is_admin()))
    WITH CHECK ((SELECT public.app_is_admin()));

CREATE POLICY "paye_entries_delete_admin"
    ON public.paye_entries FOR DELETE TO authenticated
    USING ((SELECT public.app_is_admin()));


-- ─── paye_meta: the yearly balances beside the table ─────────────────────────

DROP POLICY IF EXISTS "paye_meta_all_authenticated" ON public.paye_meta;
DROP POLICY IF EXISTS "paye_meta_select_own_or_admin" ON public.paye_meta;
DROP POLICY IF EXISTS "paye_meta_insert_admin"        ON public.paye_meta;
DROP POLICY IF EXISTS "paye_meta_update_admin"        ON public.paye_meta;
DROP POLICY IF EXISTS "paye_meta_delete_admin"        ON public.paye_meta;

CREATE POLICY "paye_meta_select_own_or_admin"
    ON public.paye_meta FOR SELECT TO authenticated
    USING ((SELECT public.app_is_admin()) OR rep_name = (SELECT public.app_rep_name()));

CREATE POLICY "paye_meta_insert_admin"
    ON public.paye_meta FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.app_is_admin()));

CREATE POLICY "paye_meta_update_admin"
    ON public.paye_meta FOR UPDATE TO authenticated
    USING ((SELECT public.app_is_admin()))
    WITH CHECK ((SELECT public.app_is_admin()));

CREATE POLICY "paye_meta_delete_admin"
    ON public.paye_meta FOR DELETE TO authenticated
    USING ((SELECT public.app_is_admin()));


-- ─── rep_comm_rates: keep the admin-only writes, close the read ──────────────
-- The write policies here already read allowed_users through the JWT's
-- user_metadata; they are rewritten onto app_is_admin() so payroll has one
-- definition of "admin" rather than two that can drift apart.

DROP POLICY IF EXISTS "authenticated_can_read_rates" ON public.rep_comm_rates;
DROP POLICY IF EXISTS "admins_can_insert_rates"      ON public.rep_comm_rates;
DROP POLICY IF EXISTS "admins_can_update_rates"      ON public.rep_comm_rates;
DROP POLICY IF EXISTS "admins_can_delete_rates"      ON public.rep_comm_rates;
DROP POLICY IF EXISTS "rep_comm_rates_select_own_or_admin" ON public.rep_comm_rates;
DROP POLICY IF EXISTS "rep_comm_rates_insert_admin"        ON public.rep_comm_rates;
DROP POLICY IF EXISTS "rep_comm_rates_update_admin"        ON public.rep_comm_rates;
DROP POLICY IF EXISTS "rep_comm_rates_delete_admin"        ON public.rep_comm_rates;

CREATE POLICY "rep_comm_rates_select_own_or_admin"
    ON public.rep_comm_rates FOR SELECT TO authenticated
    USING ((SELECT public.app_is_admin()) OR rep_name = (SELECT public.app_rep_name()));

CREATE POLICY "rep_comm_rates_insert_admin"
    ON public.rep_comm_rates FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.app_is_admin()));

CREATE POLICY "rep_comm_rates_update_admin"
    ON public.rep_comm_rates FOR UPDATE TO authenticated
    USING ((SELECT public.app_is_admin()))
    WITH CHECK ((SELECT public.app_is_admin()));

CREATE POLICY "rep_comm_rates_delete_admin"
    ON public.rep_comm_rates FOR DELETE TO authenticated
    USING ((SELECT public.app_is_admin()));
