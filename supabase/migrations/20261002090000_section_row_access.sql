-- A section that is not ticked is locked in the database, not only hidden.
--
-- 20261001130000 put the five section flags on allowed_users and gated three
-- tables with them (zoho_accounts, ad_spend_daily, ad_campaigns). Everything
-- else stayed readable to every listed user, so a member without Devis or
-- Factures no longer had the screens and could still read `sales` and
-- `invoices` through the API. This migration closes that: each table is
-- readable by the sections that have a screen on it, and by nobody else.
--
--   table                    read in full by             own rows only
--   ───────────────────────  ──────────────────────────  ─────────────────────────
--   sales                    Devis                       Mon Portail
--   invoices                 Factures, Comptes           Mon Portail (see below)
--   zoho_leads               Comptes, Mon Portail
--   zoho_accounts            Comptes
--   ad_spend_daily           Publicité                   (unchanged)
--   ad_campaigns             Publicité                   (unchanged)
--   objectives               Devis
--   objectives_factures      Factures
--   rep_objectives(_dept)    Devis, Factures             Mon Portail
--   excluded_clients         Devis, Factures, Mon Portail
--   excluded_reps            Devis, Factures, Mon Portail
--   fiscal_quarters          Devis, Factures
--   zoho_books_customers     Factures
--   reps                     Devis
--   zoho_tasks, webhook_log, zoho_books_users,
--   department_mappings, leads                           admins only
--
-- An admin holds every section, so nothing changes for an admin.
--
-- "Own rows" means rows whose rep_name is the caller's rep_name in
-- allowed_users, and only while Mon Portail is ticked. Every portal screen
-- already filters on that name, so the figures a rep sees are the same rows as
-- before; what goes away is the ability to ask for somebody else's.
--
-- Three choices that are not obvious from the table:
--
--   * Mon Portail also reads the invoices of the accounts the rep holds a lead
--     or a contact on, whoever the invoice is credited to. The portal's leads
--     screen totals revenue per account, and an invoice belongs to an account,
--     not to a person. Without this the "facturé" column would silently drop
--     to the rep's own invoices.
--
--   * zoho_leads is not cut down to own rows. zoho_leads_unique hides a
--     converted lead behind the contact it became, and that contact can belong
--     to another rep: with only their own rows visible, a rep's list would grow
--     leads that are hidden today.
--
--   * Comptes reads invoices in full. Its detail screen opens the billing
--     history of any account, so the section is the invoices, at another grain.
--
-- Publicité is the one section that needs figures built on tables it must not
-- read: revenue per channel comes from zoho_accounts and invoices. Its three
-- RPCs therefore become SECURITY DEFINER and check the section themselves; an
-- ads-only member gets the aggregates on the page and cannot list a client or
-- an invoice.
--
-- A table whose rows are hidden from a caller does not raise an error inside an
-- RPC, it changes the result: an excluded client stops being excluded, a
-- target reads 0. So a new screen that reads one of these tables has to be
-- added to the table's policy here, in the same release.

-- ─── 1. Helpers ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER with a pinned search_path, like app_can_access(): they read
-- allowed_users for a caller who can only see their own row, from policies on
-- other tables.

CREATE OR REPLACE FUNCTION public.app_can_access_any(VARIADIC p_sections TEXT[])
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
            OR (u.can_access_devis     AND 'devis'     = ANY(p_sections))
            OR (u.can_access_factures  AND 'factures'  = ANY(p_sections))
            OR (u.can_access_comptes   AND 'comptes'   = ANY(p_sections))
            OR (u.can_access_publicite AND 'publicite' = ANY(p_sections))
            OR (u.can_access_portail   AND 'portail'   = ANY(p_sections)))
  );
$$;

-- The caller's rep name while Mon Portail is open to them, NULL otherwise. A
-- policy compares a row's rep_name with it, and nothing equals NULL.
CREATE OR REPLACE FUNCTION public.app_portal_rep()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULLIF(btrim(u.rep_name), '')
    FROM public.allowed_users u
   WHERE public.app_session_trusted()
     AND lower(u.email) = lower(auth.jwt() ->> 'email')
     AND (u.role = 'admin' OR u.can_access_portail)
   LIMIT 1;
$$;

-- Guard for a SECURITY DEFINER RPC: it runs as its owner, so no policy stops
-- the caller and the function has to. An API caller without the section gets
-- 42501, which PostgREST answers with 403. The service role and a direct SQL
-- session carry neither API role and pass, as they do in get_sales_team().
CREATE OR REPLACE FUNCTION public.app_require_section(p_section TEXT)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') IN ('anon', 'authenticated')
     AND NOT public.app_can_access(p_section) THEN
    RAISE EXCEPTION 'section "%" is not open to this user', p_section
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.app_can_access_any(TEXT[])  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.app_portal_rep()            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.app_require_section(TEXT)   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_can_access_any(TEXT[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_portal_rep()           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_require_section(TEXT)  TO authenticated, service_role;

-- ─── 2. Read policies ─────────────────────────────────────────────────────────
-- A table's permissive policies are ORed together, so one leftover
-- "USING (true)" under any name would undo the lock. Rather than naming the
-- policies to drop, every permissive policy open to anon or authenticated on
-- the tables below is removed and the section policy is the only one created.
-- The RESTRICTIVE policies (listed_users_only, admin_*_only) are ANDed on top
-- and stay as they are. The service role bypasses RLS and is not concerned.

DO $$
DECLARE
  p RECORD;
BEGIN
  FOR p IN
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND permissive = 'PERMISSIVE'
       AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
       AND tablename = ANY (ARRAY[
             'sales', 'invoices', 'zoho_leads', 'zoho_accounts', 'zoho_tasks',
             'objectives', 'objectives_factures', 'rep_objectives', 'rep_objectives_dept',
             'excluded_clients', 'excluded_reps', 'fiscal_quarters', 'reps',
             'zoho_books_customers', 'zoho_books_users', 'webhook_log',
             'department_mappings', 'leads'
           ])
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END $$;

-- Each check is a scalar subquery so it runs once per statement, not per row.

-- Devis in full; a rep's own quotes through Mon Portail.
CREATE POLICY sales_select_section ON public.sales
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access('devis'))
      OR rep_name = (SELECT public.app_portal_rep()));

-- Factures and Comptes in full; through Mon Portail a rep's own invoices and
-- those of the accounts they hold a lead or a contact on.
CREATE POLICY invoices_select_section ON public.invoices
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access_any('factures', 'comptes'))
      OR rep_name = (SELECT public.app_portal_rep())
      OR crm_account_id IN (
           SELECT z.account_id
             FROM public.zoho_leads z
            WHERE z.rep_name = (SELECT public.app_portal_rep())));

CREATE POLICY zoho_leads_select_section ON public.zoho_leads
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access_any('comptes', 'portail')));

-- Publicité no longer reads this table: its RPCs run as their owner (section 4).
CREATE POLICY zoho_accounts_select_section ON public.zoho_accounts
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access('comptes')));

CREATE POLICY objectives_select_section ON public.objectives
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access('devis')));

CREATE POLICY objectives_factures_select_section ON public.objectives_factures
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access('factures')));

-- The Devis and Factures dashboards sum the objectives of the reps selected in
-- the filter; a rep reads their own.
CREATE POLICY rep_objectives_select_section ON public.rep_objectives
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access_any('devis', 'factures'))
      OR rep_name = (SELECT public.app_portal_rep()));

CREATE POLICY rep_objectives_dept_select_section ON public.rep_objectives_dept
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access_any('devis', 'factures'))
      OR rep_name = (SELECT public.app_portal_rep()));

-- Every sales RPC subtracts these two lists. A caller who cannot read them does
-- not get an error, they get totals with the excluded clients counted in, so
-- all three sections that run those RPCs read them.
CREATE POLICY excluded_clients_select_section ON public.excluded_clients
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access_any('devis', 'factures', 'portail')));

CREATE POLICY excluded_reps_select_section ON public.excluded_reps
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access_any('devis', 'factures', 'portail')));

CREATE POLICY fiscal_quarters_select_section ON public.fiscal_quarters
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access_any('devis', 'factures')));

-- Read by the "à assigner" list of the Factures dashboard.
CREATE POLICY zoho_books_customers_select_section ON public.zoho_books_customers
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access('factures')));

-- Only the v_*_rep_* views over `sales` join it.
CREATE POLICY reps_select_section ON public.reps
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_access('devis')));

-- No member screen reads these.
CREATE POLICY zoho_tasks_select_admin ON public.zoho_tasks
  FOR SELECT TO authenticated
  USING ((SELECT public.app_is_admin()));

CREATE POLICY webhook_log_select_admin ON public.webhook_log
  FOR SELECT TO authenticated
  USING ((SELECT public.app_is_admin()));

CREATE POLICY zoho_books_users_select_admin ON public.zoho_books_users
  FOR SELECT TO authenticated
  USING ((SELECT public.app_is_admin()));

CREATE POLICY department_mappings_select_admin ON public.department_mappings
  FOR SELECT TO authenticated
  USING ((SELECT public.app_is_admin()));

-- ─── 3. Write policies ────────────────────────────────────────────────────────
-- The settings tables were writable through the permissive "any signed-in
-- user" policies dropped above, narrowed to admins by the restrictive
-- admin_*_only ones. With the permissive side gone a write needs a policy that
-- grants it: admins, FOR ALL. The restrictive policies stay as a second lock.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'excluded_clients', 'objectives', 'objectives_factures',
    'rep_objectives', 'rep_objectives_dept', 'reps', 'leads'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
      'USING ((SELECT public.app_is_admin())) WITH CHECK ((SELECT public.app_is_admin()))',
      t || '_admin_all', t);
  END LOOP;
END $$;

-- ─── 4. Publicité RPCs run as their owner ─────────────────────────────────────
-- Bodies unchanged from 20261001150000 apart from the first statement, which
-- refuses a caller without the section. The SET search_path clause is right
-- here and wrong on the helpers they call: these are SECURITY DEFINER entry
-- points, never inlined into another query, while zoho_accounts_scoped() must
-- stay inlinable and keeps no SET clause.
--
-- get_ad_campaigns() and get_ad_spend_status() read the two ad tables only,
-- which Publicité can read, and stay SECURITY INVOKER.

CREATE OR REPLACE FUNCTION public.get_ad_filter_options(p_year integer DEFAULT NULL::integer, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_view text DEFAULT 'paid'::text)
 RETURNS TABLE(sources text[], services text[], reps text[], domaines text[], regions text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.app_require_section('publicite');

  WITH map AS (
    SELECT m.* FROM public.ad_channel_source_map(public.ad_resolve_view(p_view, false)) m
  ),
  scoped AS (
    SELECT s.*
    FROM public.zoho_accounts_scoped(
           p_year, NULL, NULL, NULL, NULL, NULL, NULL, p_exclude_ratings) s
    JOIN map m
      ON m.source_value = s.origine_du_client
     AND (m.created_from   IS NULL OR s.created_date >= m.created_from)
     AND (m.created_before IS NULL OR s.created_date <  m.created_before)
  )
  SELECT
    COALESCE((SELECT array_agg(DISTINCT m.source_value ORDER BY m.source_value) FROM map m), '{}'),
    -- Folded through zoho_service_key, then labelled from the shared map, so a
    -- service reads the same way here as on Comptes.
    COALESCE((SELECT array_agg(DISTINCT l.label ORDER BY l.label)
                FROM (SELECT DISTINCT public.zoho_service_key(v) AS key
                        FROM scoped s, LATERAL unnest(s.service_interest) AS v
                       WHERE btrim(v) <> '') k
                JOIN public.zoho_service_labels l ON l.key = k.key), '{}'),
    COALESCE((SELECT array_agg(DISTINCT s.rep_name ORDER BY s.rep_name)
                FROM scoped s WHERE COALESCE(btrim(s.rep_name), '') <> ''), '{}'),
    COALESCE((SELECT array_agg(DISTINCT s.domaine_activite ORDER BY s.domaine_activite)
                FROM scoped s WHERE COALESCE(btrim(s.domaine_activite), '') NOT IN ('', '-None-')), '{}'),
    COALESCE((SELECT array_agg(DISTINCT s.region_administrative ORDER BY s.region_administrative)
                FROM scoped s WHERE COALESCE(btrim(s.region_administrative), '') NOT IN ('', '-None-')), '{}');
$function$;

CREATE OR REPLACE FUNCTION public.get_ad_monthly(p_year integer, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_organic boolean DEFAULT false, p_view text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[])
 RETURNS TABLE(channel text, month integer, spend numeric, platform_conversions numeric, accounts_created bigint, accounts_invoiced bigint, revenue_attributed numeric, revenue_per_account numeric, cost_per_account numeric, roas numeric, window_ends_on date, source_first_used date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.app_require_section('publicite');

  WITH map AS (
    SELECT m.*
    FROM public.ad_channel_source_map(public.ad_resolve_view(p_view, p_organic)) m
    WHERE p_sources IS NULL OR m.source_value = ANY(p_sources)
  ),
  grid AS (
    SELECT c.channel, g.month
    FROM (SELECT DISTINCT channel FROM map) c
    CROSS JOIN generate_series(1, 12) AS g(month)
  ),
  sp AS (
    SELECT
      d.platform AS channel,
      EXTRACT(MONTH FROM d.spend_date)::INT AS month,
      sum(d.spend)       AS spend,
      sum(d.conversions) AS conversions
    FROM public.ad_spend_daily d
    WHERE public.ad_resolve_view(p_view, p_organic) = 'paid'
      AND d.spend_date >= pg_catalog.make_date(p_year, 1, 1)
      AND d.spend_date <  pg_catalog.make_date(p_year + 1, 1, 1)
    GROUP BY 1, 2
  ),
  scoped AS (
    SELECT s.*, m.channel
    FROM public.zoho_accounts_scoped(
           p_year, NULL, NULL, NULL, NULL, NULL, NULL, p_exclude_ratings,
           p_reps, NULL, p_services, p_domaines, p_regions) s
    JOIN map m
      ON m.source_value = s.origine_du_client
     AND (m.created_from   IS NULL OR s.created_date >= m.created_from)
     AND (m.created_before IS NULL OR s.created_date <  m.created_before)
  ),
  per_acct AS (
    SELECT
      s.channel,
      EXTRACT(MONTH FROM s.created_date)::INT AS month,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  public.zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS attributed
    FROM scoped s
    LEFT JOIN public.invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2, 3
  ),
  acct AS (
    SELECT
      p.channel, p.month,
      count(*)                                  AS accounts_created,
      count(*) FILTER (WHERE p.attributed <> 0) AS accounts_invoiced,
      COALESCE(sum(p.attributed), 0)            AS revenue_attributed
    FROM per_acct p
    GROUP BY 1, 2
  ),
  flags AS (
    SELECT (p_reps IS NOT NULL OR p_services IS NOT NULL
            OR p_domaines IS NOT NULL OR p_regions IS NOT NULL) AS narrowed
  )
  SELECT
    g.channel,
    g.month,
    ROUND(COALESCE(sp.spend, 0), 2),
    ROUND(COALESCE(sp.conversions, 0), 2),
    COALESCE(acct.accounts_created, 0),
    COALESCE(acct.accounts_invoiced, 0),
    COALESCE(acct.revenue_attributed, 0),
    ROUND(COALESCE(acct.revenue_attributed, 0) / NULLIF(acct.accounts_created, 0), 2),
    CASE WHEN COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(sp.spend / NULLIF(acct.accounts_created, 0), 2) END,
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0 AND NOT f.narrowed
         THEN ROUND(acct.revenue_attributed / NULLIF(sp.spend, 0), 2) END,
    public.ad_window_ends_on(
      (pg_catalog.make_date(p_year, g.month, 1) + INTERVAL '1 month')::date,
      p_window_months),
    fu.first_used
  FROM grid g
  CROSS JOIN flags f
  LEFT JOIN sp   ON sp.channel   = g.channel AND sp.month   = g.month
  LEFT JOIN acct ON acct.channel = g.channel AND acct.month = g.month
  LEFT JOIN public.ad_source_first_used(public.ad_resolve_view(p_view, p_organic)) fu
         ON fu.channel = g.channel
  ORDER BY g.channel, g.month;
$function$;

CREATE OR REPLACE FUNCTION public.get_ad_performance(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_organic boolean DEFAULT false, p_view text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[])
 RETURNS TABLE(channel text, sources text[], currencies text[], spend numeric, impressions bigint, clicks bigint, platform_conversions numeric, platform_leads numeric, accounts_created bigint, accounts_invoiced bigint, revenue_attributed numeric, revenue_lifetime numeric, revenue_per_account numeric, cost_per_account numeric, cost_per_client numeric, roas numeric, net numeric, days_with_spend bigint, window_ends_on date, source_first_used date, cohort_from date, cohort_before date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.app_require_section('publicite');

  WITH period AS (
    SELECT * FROM public.ad_period(p_year, p_month)
  ),
  map AS (
    SELECT m.*
    FROM public.ad_channel_source_map(public.ad_resolve_view(p_view, p_organic)) m
    WHERE p_sources IS NULL OR m.source_value = ANY(p_sources)
  ),
  src AS (
    SELECT m.channel,
           array_agg(DISTINCT m.source_value ORDER BY m.source_value) AS sources,
           min(m.created_from)   AS cohort_from,
           max(m.created_before) AS cohort_before
    FROM map m
    GROUP BY m.channel
  ),
  -- Spend belongs to the paid view only: the other two cost nothing.
  sp AS (
    SELECT
      d.platform AS channel,
      COALESCE(sum(d.spend), 0)       AS spend,
      COALESCE(sum(d.impressions), 0) AS impressions,
      COALESCE(sum(d.clicks), 0)      AS clicks,
      COALESCE(sum(d.conversions), 0) AS conversions,
      COALESCE(sum(d.leads), 0)       AS leads,
      count(DISTINCT d.spend_date)    AS days_with_spend,
      array_agg(DISTINCT d.currency) FILTER (WHERE d.currency IS NOT NULL) AS currencies
    FROM public.ad_spend_daily d, period p
    WHERE public.ad_resolve_view(p_view, p_organic) = 'paid'
      AND d.spend_date >= p.period_start
      AND d.spend_date <  p.period_end
    GROUP BY d.platform
  ),
  scoped AS (
    SELECT s.*, m.channel
    -- The month only applies within a year, matching ad_period's spend range.
    -- Sources are narrowed by the map join, so none is passed here.
    FROM public.zoho_accounts_scoped(
           p_year, CASE WHEN p_year IS NULL THEN NULL ELSE p_month END,
           NULL, NULL, NULL, NULL, NULL, p_exclude_ratings,
           p_reps, NULL, p_services, p_domaines, p_regions) s
    JOIN map m
      ON m.source_value = s.origine_du_client
     AND (m.created_from   IS NULL OR s.created_date >= m.created_from)
     AND (m.created_before IS NULL OR s.created_date <  m.created_before)
  ),
  per_acct AS (
    SELECT
      s.channel,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  public.zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS attributed,
      COALESCE(sum(i.amount), 0) AS lifetime
    FROM scoped s
    LEFT JOIN public.invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2
  ),
  acct AS (
    SELECT
      p.channel,
      count(*)                                  AS accounts_created,
      count(*) FILTER (WHERE p.attributed <> 0) AS accounts_invoiced,
      COALESCE(sum(p.attributed), 0)            AS revenue_attributed,
      COALESCE(sum(p.lifetime), 0)              AS revenue_lifetime
    FROM per_acct p
    GROUP BY p.channel
  ),
  -- True when the accounts are a subset the spend cannot be matched to.
  flags AS (
    SELECT (p_reps IS NOT NULL OR p_services IS NOT NULL
            OR p_domaines IS NOT NULL OR p_regions IS NOT NULL) AS narrowed
  )
  SELECT
    src.channel,
    src.sources,
    COALESCE(sp.currencies, ARRAY[]::TEXT[]),
    ROUND(COALESCE(sp.spend, 0), 2),
    COALESCE(sp.impressions, 0),
    COALESCE(sp.clicks, 0),
    COALESCE(sp.conversions, 0),
    COALESCE(sp.leads, 0),
    COALESCE(acct.accounts_created, 0),
    COALESCE(acct.accounts_invoiced, 0),
    COALESCE(acct.revenue_attributed, 0),
    COALESCE(acct.revenue_lifetime, 0),
    ROUND(COALESCE(acct.revenue_attributed, 0) / NULLIF(acct.accounts_created, 0), 2),
    -- Costs only exist against a spend, and only for the whole channel. Divided
    -- by all accounts created, matching revenue_per_account on Comptes.
    CASE WHEN COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(sp.spend / NULLIF(acct.accounts_created, 0), 2) END,
    CASE WHEN COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(sp.spend / NULLIF(acct.accounts_invoiced, 0), 2) END,
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0 AND NOT f.narrowed
         THEN ROUND(acct.revenue_attributed / NULLIF(sp.spend, 0), 2) END,
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0 AND COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(acct.revenue_attributed - sp.spend, 2) END,
    COALESCE(sp.days_with_spend, 0),
    (SELECT public.ad_window_ends_on(p.period_end, p_window_months) FROM period p),
    fu.first_used,
    src.cohort_from,
    src.cohort_before
  FROM src
  CROSS JOIN flags f
  LEFT JOIN sp   ON sp.channel   = src.channel
  LEFT JOIN acct ON acct.channel = src.channel
  LEFT JOIN public.ad_source_first_used(public.ad_resolve_view(p_view, p_organic)) fu
         ON fu.channel = src.channel
  ORDER BY src.channel;
$function$;

-- A SECURITY DEFINER function is callable by PUBLIC unless that is taken away.
REVOKE ALL ON FUNCTION public.get_ad_filter_options(p_year integer, p_exclude_ratings text[], p_view text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_filter_options(p_year integer, p_exclude_ratings text[], p_view text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_ad_monthly(p_year integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_monthly(p_year integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_ad_performance(p_year integer, p_month integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_performance(p_year integer, p_month integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]) TO authenticated, service_role;

-- ─── 5. The covering index follows the policy ────────────────────────────────
-- The invoices policy reads rep_name on every row. The Comptes and Publicité
-- RPCs join invoices on crm_account_id through an index-only scan; with
-- rep_name outside the index each of those rows would cost a heap fetch.

CREATE INDEX IF NOT EXISTS invoices_crm_account_cover2_idx
  ON public.invoices (crm_account_id) INCLUDE (invoice_date, amount, rep_name);
DROP INDEX IF EXISTS public.invoices_crm_account_cover_idx;
