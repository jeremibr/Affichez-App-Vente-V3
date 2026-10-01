-- Access is decided by allowed_users, section by section.
--
-- Three rules, all enforced in the database and not only in the nav:
--
--   1. No row in allowed_users, no data. Signing in creates an auth session, and
--      until now any session could read every table carrying a
--      "TO authenticated USING (true)" policy. A RESTRICTIVE policy is ANDed with
--      a table's permissive ones, so one of them per table closes all of that
--      without rewriting a single existing policy.
--
--   2. A member sees the sections ticked on their row. Five flags, one per
--      section of the nav:
--
--        can_access_devis      Devis               default true
--        can_access_factures   Factures            default false (already there)
--        can_access_comptes    Comptes             default false
--        can_access_publicite  Publicité           default false
--        can_access_portail    Mon Portail         default true
--
--      An admin has every section regardless of the flags. Notre équipe and
--      Administration stay admin-only and have no flag.
--
--   3. Only an admin changes settings: objectives, excluded clients, reps. The
--      screens that write them are admin-only; until now the tables themselves
--      accepted a write from any signed-in user.
--
-- The defaults reproduce what each existing member can open today, so applying
-- this migration changes nobody's access.
--
-- What the flags gate in the database: zoho_accounts (Comptes and Publicité both
-- read it) and the two ad tables (Publicité). sales, invoices and zoho_leads
-- stay readable to every listed user, as before: Mon Portail is built on them.
-- There the flags decide which screens exist, not which rows can be read.

-- ─── 1. Flags ─────────────────────────────────────────────────────────────────

ALTER TABLE public.allowed_users
  ADD COLUMN IF NOT EXISTS can_access_devis     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_access_comptes   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_access_publicite BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_access_portail   BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.allowed_users.can_access_devis     IS 'Member may open the Devis section. Ignored for admins.';
COMMENT ON COLUMN public.allowed_users.can_access_comptes   IS 'Member may open the Comptes section and read zoho_accounts. Ignored for admins.';
COMMENT ON COLUMN public.allowed_users.can_access_publicite IS 'Member may open Publicité and read ad spend and zoho_accounts. Ignored for admins.';
COMMENT ON COLUMN public.allowed_users.can_access_portail   IS 'Member may open Mon Portail. Ignored for admins.';

-- ─── 2. Helpers ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER with a pinned search_path, like app_is_admin(): they read
-- allowed_users on behalf of a caller whose own RLS shows only their own row,
-- and they are called from policies, so they must not depend on the caller's
-- search_path. Owned by the table owner, so reading allowed_users from a policy
-- on another table does not recurse.
--
-- Identity is the email in the session token, so a session only counts when it
-- was opened through the Zoho sign-in. That flow issues a one-time link; it
-- never sets a password. A session opened with a password can therefore only
-- come from the public sign-up endpoint, where anybody may register any address
-- with a password of their own before its owner has ever signed in. Such a
-- session is refused here, whatever address it carries.

CREATE OR REPLACE FUNCTION public.app_session_trusted()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT NOT (COALESCE(auth.jwt() -> 'amr', '[]'::jsonb) @> '[{"method": "password"}]'::jsonb);
$$;

CREATE OR REPLACE FUNCTION public.app_is_listed()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.app_session_trusted() AND EXISTS (
    SELECT 1 FROM public.allowed_users u
     WHERE lower(u.email) = lower(auth.jwt() ->> 'email')
  );
$$;

CREATE OR REPLACE FUNCTION public.app_can_access(p_section TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.app_session_trusted() AND EXISTS (
    SELECT 1 FROM public.allowed_users u
     WHERE lower(u.email) = lower(auth.jwt() ->> 'email')
       AND (u.role = 'admin'
            OR CASE p_section
                 WHEN 'devis'     THEN u.can_access_devis
                 WHEN 'factures'  THEN u.can_access_factures
                 WHEN 'comptes'   THEN u.can_access_comptes
                 WHEN 'publicite' THEN u.can_access_publicite
                 WHEN 'portail'   THEN u.can_access_portail
                 ELSE false
               END)
  );
$$;

-- Same definition as before, plus the session check.
CREATE OR REPLACE FUNCTION public.app_is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.app_session_trusted() AND EXISTS (
    SELECT 1 FROM public.allowed_users u
     WHERE lower(u.email) = lower(auth.jwt() ->> 'email')
       AND u.role = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.app_session_trusted()  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.app_is_listed()        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.app_can_access(TEXT)   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_session_trusted()  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_is_listed()        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_can_access(TEXT)   TO authenticated, service_role;

-- ─── 3. Not listed, no rows ───────────────────────────────────────────────────
-- Every table in public that has RLS enabled, except allowed_users itself: its
-- own policies already show a caller nothing but their own row, and an unlisted
-- caller has none.
--
-- The check is wrapped in a scalar subquery so it runs once per statement, not
-- once per row. The syncs are unaffected: they use the service role, which
-- bypasses RLS.
--
-- A table created after this migration needs the same policy; nothing adds it
-- automatically.

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relrowsecurity
       AND c.relname <> 'allowed_users'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS listed_users_only ON public.%I', t.relname);
    EXECUTE format(
      'CREATE POLICY listed_users_only ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((SELECT public.app_is_listed()))', t.relname);
  END LOOP;
END $$;

-- ─── 4. Settings are written by admins only ───────────────────────────────────
-- These tables carry a permissive "any signed-in user may write" policy from
-- before the app had roles. Every screen that writes them is admin-only
-- (Paramètres, Objectifs d'équipe, Objectifs des reps), so the tables now say
-- the same thing: a member, and in particular a member who only has Publicité,
-- can read them and cannot change them. Reads are untouched.
--
-- Three restrictive policies per table rather than one FOR ALL, which would
-- restrict SELECT as well.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'excluded_clients', 'objectives', 'objectives_factures',
    'rep_objectives', 'rep_objectives_dept', 'reps', 'leads'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS admin_insert_only ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS admin_update_only ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS admin_delete_only ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY admin_insert_only ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated '
      'WITH CHECK ((SELECT public.app_is_admin()))', t);
    EXECUTE format(
      'CREATE POLICY admin_update_only ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated '
      'USING ((SELECT public.app_is_admin())) WITH CHECK ((SELECT public.app_is_admin()))', t);
    EXECUTE format(
      'CREATE POLICY admin_delete_only ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated '
      'USING ((SELECT public.app_is_admin()))', t);
  END LOOP;
END $$;

-- ─── 5. SECURITY DEFINER functions ────────────────────────────────────────────
-- A SECURITY DEFINER function runs as its owner, which bypasses RLS, so the
-- policies above do not reach it: each one has to refuse the caller itself.
--
--   get_sales_team()      rep names, to every listed user;
--   tasks_visible_reps()  rep names, inside the task RPCs;
--   get_weekly_trend()    weekly sales totals. It only reads `sales`, which a
--                         listed user can read anyway, so it does not need its
--                         owner's rights at all and becomes SECURITY INVOKER;
--   refresh_zoho_service_labels()  maintenance, called by the syncs and by cron.
--
-- The guard refuses an API caller who is anonymous or signed in but not listed.
-- The service role and a direct SQL session carry neither claim and pass, so a
-- sync, a cron job or the SQL editor sees what it saw before.

CREATE OR REPLACE FUNCTION public.get_sales_team()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT DISTINCT au.rep_name
    FROM public.allowed_users au
   WHERE au.rep_name IS NOT NULL
     AND btrim(au.rep_name) <> ''
     AND (COALESCE(auth.jwt() ->> 'role', '') NOT IN ('anon', 'authenticated') OR public.app_is_listed())
   ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION public.tasks_visible_reps()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT au.rep_name FROM allowed_users au
  WHERE au.rep_name IS NOT NULL
    AND (COALESCE(auth.jwt() ->> 'role', '') NOT IN ('anon', 'authenticated') OR public.app_is_listed())
    AND normalize(au.rep_name, NFC) <> ALL (ARRAY[
      normalize('Simon Fortin Massé', NFC),
      normalize('Magasin Affichez', NFC),
      normalize('Charles Côté', NFC),
      normalize('Pier-Alexandre Lévesque', NFC),
      normalize('Vente interne', NFC)
    ]);
$$;

REVOKE ALL ON FUNCTION public.tasks_visible_reps() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tasks_visible_reps() TO authenticated, service_role;

ALTER FUNCTION public.get_weekly_trend(INTEGER, public.office_enum, public.sale_status_enum, INTEGER)
  SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.refresh_zoho_service_labels() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_zoho_service_labels() TO service_role;

-- ─── 6. Section-gated tables ──────────────────────────────────────────────────
-- Replaces the admin-only policies. An admin passes app_can_access() for every
-- section, so nothing changes for them.

-- Comptes reads zoho_accounts directly; Publicité reads it through its RPCs,
-- which are SECURITY INVOKER.
DROP POLICY IF EXISTS "zoho_accounts_select_admin"   ON public.zoho_accounts;
DROP POLICY IF EXISTS "zoho_accounts_select_section" ON public.zoho_accounts;
CREATE POLICY "zoho_accounts_select_section"
  ON public.zoho_accounts FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access('comptes'))
      OR (SELECT public.app_can_access('publicite')));

DROP POLICY IF EXISTS "ad_spend_daily_select_admin"   ON public.ad_spend_daily;
DROP POLICY IF EXISTS "ad_spend_daily_select_section" ON public.ad_spend_daily;
CREATE POLICY "ad_spend_daily_select_section"
  ON public.ad_spend_daily FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access('publicite')));

DROP POLICY IF EXISTS "ad_campaigns_select_admin"   ON public.ad_campaigns;
DROP POLICY IF EXISTS "ad_campaigns_select_section" ON public.ad_campaigns;
CREATE POLICY "ad_campaigns_select_section"
  ON public.ad_campaigns FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access('publicite')));
