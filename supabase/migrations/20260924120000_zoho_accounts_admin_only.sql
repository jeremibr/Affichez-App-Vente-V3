-- Comptes is admin-only, at the row level and not just in the nav.
--
-- The Comptes module and Publicité moved behind the admin check in App.tsx and
-- Layout.tsx. Hiding a route only hides it: a signed-in rep could still read the
-- whole client list straight through PostgREST, because zoho_accounts carried a
-- read-to-any-authenticated policy. This replaces it with the same admin check
-- ad_spend_daily already uses.
--
-- Nothing a rep uses reads this table. Every reader is a Comptes or Publicité
-- screen: get_zoho_account_kpis, get_zoho_accounts_by_{rep,source,service,
-- domaine}, get_zoho_accounts_monthly_summary, get_zoho_account_filter_options,
-- get_ad_performance, get_ad_monthly, ad_source_first_used - all of them
-- SECURITY INVOKER, so an admin still sees every row and a member now sees none
-- rather than an error. zoho_accounts_enriched is security_invoker=true, so the
-- Détail comptes view follows this policy without a change of its own.
--
-- invoices and zoho_leads deliberately keep their read-to-any-authenticated
-- policies: the Factures module and Mon Portail are built on them.
--
-- The syncs are unaffected - zoho-account-sync writes with the service role,
-- which bypasses RLS.
--
-- To undo: drop this policy and recreate zoho_accounts_select_authenticated
-- with USING (true).

DROP POLICY IF EXISTS "zoho_accounts_select_authenticated" ON public.zoho_accounts;
DROP POLICY IF EXISTS "zoho_accounts_select_admin" ON public.zoho_accounts;

CREATE POLICY "zoho_accounts_select_admin"
    ON public.zoho_accounts
    FOR SELECT
    TO authenticated
    USING (public.app_is_admin());
