-- Close the two critical findings from Supabase's security advisor.
--
-- ─── 1. RLS must not trust user_metadata (4 findings, public.allowed_users) ───
--
-- The four admin policies on allowed_users read the caller's role out of
-- `auth.jwt() -> 'user_metadata'`. That field belongs to the user: any signed-in
-- account can rewrite it from the browser with
-- `supabase.auth.updateUser({ data: { role: 'admin' } })`, and the next token
-- carries whatever they put there. So the policies could be satisfied by the
-- very person they are meant to stop, and allowed_users is the worst table for
-- that to happen on:
--
--   user edits their own metadata  ->  passes these policies
--     ->  UPDATE allowed_users SET role='admin' on their own row
--       ->  app_is_admin() is now true for them everywhere
--         ->  full access to accounts, ad spend and payroll
--
-- Every other table in this database already decides admin with
-- `app_is_admin()`, which reads allowed_users.role - a column only an admin can
-- change. These four now do the same, which also removes the second, conflicting
-- definition of "admin" that has been the source of several bugs.
--
-- app_is_admin() is SECURITY DEFINER and owned by postgres, which owns
-- allowed_users, and a table owner is exempt from its own RLS unless the table
-- sets FORCE ROW LEVEL SECURITY (it does not). So calling it from a policy on
-- allowed_users does not recurse.
--
-- The "own row" policies are left exactly as they are: every signed-in user
-- still reads their own row, which is what AuthContext needs to boot.
--
-- ─── 2. Views must run as the caller (8 findings) ────────────────────────────
--
-- A view without `security_invoker` runs with its creator's rights (postgres),
-- so it hands back rows the querying user's own RLS would have refused. The
-- eight below are switched to the caller's rights, joining the five that
-- already were (v_sommaire, v_quarterly_yoy, zoho_accounts_enriched, …).
--
-- NO DATA MOVES. Every base table these views read - sales, invoices, reps,
-- fiscal_quarters, excluded_clients, excluded_reps - already carries a
-- `FOR SELECT TO authenticated USING (true)` policy and a SELECT grant, so a
-- signed-in user can read all of it directly today. Row counts before and after
-- are identical; verified per view as a real member account. What changes is
-- that the views stop being a way around RLS if any of those tables is ever
-- tightened - the reason the advisor flags them.

-- ─── 1. allowed_users ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "admins can read all users"  ON public.allowed_users;
DROP POLICY IF EXISTS "admins can insert users"    ON public.allowed_users;
DROP POLICY IF EXISTS "admins can update users"    ON public.allowed_users;
DROP POLICY IF EXISTS "admins can delete users"    ON public.allowed_users;

CREATE POLICY "admins can read all users"
    ON public.allowed_users FOR SELECT TO authenticated
    USING ((SELECT public.app_is_admin()));

CREATE POLICY "admins can insert users"
    ON public.allowed_users FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.app_is_admin()));

CREATE POLICY "admins can update users"
    ON public.allowed_users FOR UPDATE TO authenticated
    USING ((SELECT public.app_is_admin()))
    WITH CHECK ((SELECT public.app_is_admin()));

CREATE POLICY "admins can delete users"
    ON public.allowed_users FOR DELETE TO authenticated
    USING ((SELECT public.app_is_admin()));

-- ─── 2. the eight views ──────────────────────────────────────────────────────

ALTER VIEW public.v_weekly_summary         SET (security_invoker = on);
ALTER VIEW public.v_weekly_dept_totals     SET (security_invoker = on);
ALTER VIEW public.v_weekly_grand_totals    SET (security_invoker = on);
ALTER VIEW public.v_monthly_dept_totals    SET (security_invoker = on);
ALTER VIEW public.v_monthly_grand_totals   SET (security_invoker = on);
ALTER VIEW public.v_monthly_rep_totals     SET (security_invoker = on);
ALTER VIEW public.v_quarterly_rep_averages SET (security_invoker = on);
ALTER VIEW public.v_inv_weekly_summary     SET (security_invoker = on);
