-- Give contacts a source and a service.
--
-- Zoho's Contacts module carries neither Lead_Source nor the service multiselect;
-- both fields exist only on Leads. The trigger in 20260901120000 already pulls
-- them from the originating lead, but most contacts were created directly as
-- clients and no lead points at them, so those columns are simply empty for them.
--
-- Two other places in Zoho know the answer, and the rule agreed on 2026-09-03 is:
--
--   SOURCE   always the account's "Origine du client" once the contact is billed;
--            the lead's own source while they are not.
--
--   SERVICE  what they were actually invoiced for, taken from each invoice's
--            Département; the lead's own service if they have no invoices; the
--            account's "Intérêt pour quel service initialement" if neither.
--
-- Invoice departments are stored with Zoho Books' own wording ("DIST.
-- PUBLICITAIRE SOLO", "NUMERIQUE"), NOT translated into the CRM's eight-value
-- service picklist. That was a deliberate call: the two vocabularies are
-- genuinely different — six department values against eight services — and
-- mapping MULTI-ANNONCEURS or APPLICATION onto a service would be a guess baked
-- into the data. The cost is that the Service filter offers both vocabularies.
--
-- Nothing here touches the funnel. The dashboard reads zoho_leads directly with
-- stage = 'lead' (see zoho_leads_scoped), and every rule above applies only to
-- contacts, so no KPI, breakdown or monthly figure moves.

-- ─── Lookups ──────────────────────────────────────────────────────────────────
-- Small SQL functions rather than joins in the view: Postgres inlines them, so
-- they stay target-list expressions evaluated for the ~100 rows that survive the
-- LIMIT rather than a LATERAL join computed for all ~29k rows scanned. That
-- distinction is what keeps the detail page's pagination cheap.
--
-- SECURITY INVOKER, so they inherit the RLS on invoices and zoho_accounts
-- instead of quietly reading around it.

CREATE OR REPLACE FUNCTION zoho_account_source(p_account_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT a.origine_du_client
    FROM zoho_accounts a
   WHERE p_account_id IS NOT NULL
     AND a.zoho_account_id = p_account_id;
$$;

GRANT EXECUTE ON FUNCTION zoho_account_source(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION zoho_account_services(p_account_id TEXT)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT NULLIF(a.service_interest, '{}'::TEXT[])
    FROM zoho_accounts a
   WHERE p_account_id IS NOT NULL
     AND a.zoho_account_id = p_account_id;
$$;

GRANT EXECUTE ON FUNCTION zoho_account_services(TEXT) TO authenticated;

/**
 * Every distinct Département this account has actually been invoiced under.
 *
 * NULL, not '{}', when there is nothing: an aggregate over no rows returns NULL,
 * which is exactly what the COALESCE chain below needs to fall through on. An
 * account holding invoices that all have a NULL department therefore falls
 * through to the lead's or the account's stated service, which is the honest
 * answer — we know they bought something but not what.
 */
CREATE OR REPLACE FUNCTION zoho_account_departments(p_account_id TEXT)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT array_agg(DISTINCT btrim(i.department) ORDER BY btrim(i.department))
    FROM invoices i
   WHERE p_account_id IS NOT NULL
     AND i.crm_account_id = p_account_id
     AND i.department IS NOT NULL
     AND btrim(i.department) <> '';
$$;

GRANT EXECUTE ON FUNCTION zoho_account_departments(TEXT) TO authenticated;


-- ─── The view ─────────────────────────────────────────────────────────────────
-- Purely additive: `l.*` and has_invoices keep their positions and four columns
-- are appended, so CREATE OR REPLACE VIEW accepts it and no existing consumer
-- changes meaning. Deliberately NOT overwriting lead_source / service_interest
-- in place -- this repo cannot rebuild its own schema (several RPCs exist only in
-- the database), so enumerating every base column to override two of them would
-- break on any column added outside a migration. Keeping the raw Zoho values
-- beside the resolved ones also makes a wrong attribution possible to diagnose.
--
-- WHICH COLUMN TO USE: anything user-facing about a *contact* wants the
-- _resolved pair. lead_source / service_interest remain exactly what Zoho's own
-- Leads module said, which for a contact is usually nothing.

CREATE OR REPLACE VIEW zoho_leads_unique
WITH (security_invoker = true) AS
SELECT l.*,
       (l.account_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM invoices i WHERE i.crm_account_id = l.account_id
        )) AS has_invoices,

       -- Source. Billed contacts answer from the account; everyone else keeps
       -- what the lead said and only falls back to the account for a gap.
       CASE
         WHEN l.stage <> 'contact' THEN l.lead_source
         WHEN l.account_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM invoices i WHERE i.crm_account_id = l.account_id)
           THEN COALESCE(zoho_account_source(l.account_id), l.lead_source)
         ELSE COALESCE(l.lead_source, zoho_account_source(l.account_id))
       END AS source_resolved,

       -- Service. What they were billed for beats what anyone said they wanted.
       CASE
         WHEN l.stage <> 'contact' THEN l.service_interest
         ELSE COALESCE(
                zoho_account_departments(l.account_id),
                NULLIF(l.service_interest, '{}'::TEXT[]),
                zoho_account_services(l.account_id),
                '{}'::TEXT[]
              )
       END AS service_resolved,

       -- Where each value came from, so the table can mark an inherited value and
       -- so a surprising one can be traced without re-deriving the rules by hand.
       CASE
         WHEN l.stage <> 'contact' THEN 'own'
         WHEN l.account_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM invoices i WHERE i.crm_account_id = l.account_id)
              AND zoho_account_source(l.account_id) IS NOT NULL THEN 'account'
         WHEN l.lead_source IS NOT NULL
           THEN CASE WHEN l.attribution_inherited THEN 'lead' ELSE 'own' END
         WHEN zoho_account_source(l.account_id) IS NOT NULL THEN 'account'
         ELSE NULL
       END::TEXT AS source_origin,

       CASE
         WHEN l.stage <> 'contact' THEN 'own'
         WHEN zoho_account_departments(l.account_id) IS NOT NULL THEN 'invoice'
         WHEN cardinality(l.service_interest) > 0
           THEN CASE WHEN l.attribution_inherited THEN 'lead' ELSE 'own' END
         WHEN zoho_account_services(l.account_id) IS NOT NULL THEN 'account'
         ELSE NULL
       END::TEXT AS service_origin

  FROM zoho_leads l
 WHERE l.stage = 'contact'          -- every contact is kept
    OR NOT l.is_converted           -- an open lead is not a duplicate of anything
    OR (
         -- A converted lead is kept only while we cannot prove which contact it
         -- became: neither Zoho's pointer nor a unique email match resolves it.
         NOT EXISTS (
           SELECT 1 FROM zoho_leads c
            WHERE c.zoho_record_id = l.converted_contact_id
              AND c.stage = 'contact'
         )
         AND NOT (
           l.email IS NOT NULL
           AND btrim(l.email) <> ''
           AND (
             SELECT count(*) FROM zoho_leads c
              WHERE c.stage = 'contact'
                AND lower(btrim(c.email)) = lower(btrim(l.email))
           ) = 1
         )
       );

COMMENT ON VIEW zoho_leads_unique IS
  'zoho_leads with converted leads hidden behind the contact they became, plus '
  'has_invoices and the resolved attribution pair. Use source_resolved / '
  'service_resolved for anything user-facing: lead_source and service_interest '
  'are Zoho''s raw Leads-module values and are empty for most contacts. '
  'Directory view - use zoho_leads with stage = ''lead'' for funnel counts.';


-- ─── Service label map ────────────────────────────────────────────────────────
-- Widened to every vocabulary that can now reach service_resolved. Without this
-- the filter RPC's inner join to this map would silently drop every
-- invoice-derived service, so "DIST. PUBLICITAIRE SOLO" would show in the table
-- and be unselectable in the dropdown above it.
--
-- Non-circular on purpose: built from the three base tables, never from
-- zoho_leads_unique, which reads this map back through the filter RPC.
--
-- zoho_service_key() still folds only case and whitespace, so the CRM's
-- "Distribution Publicitaire" and Books' "DIST. PUBLICITAIRE SOLO" stay two
-- separate entries. They are different words for arguably the same thing, and
-- deciding that is a business call, not a normalisation.

CREATE OR REPLACE VIEW zoho_service_labels
WITH (security_invoker = true) AS
WITH raw AS (
  SELECT btrim(s), TRUE  FROM zoho_leads z,    LATERAL unnest(z.service_interest) AS s
  UNION ALL
  SELECT btrim(s), FALSE FROM zoho_accounts a, LATERAL unnest(a.service_interest) AS s
  UNION ALL
  SELECT btrim(i.department), FALSE FROM invoices i WHERE i.department IS NOT NULL
),
keyed AS (
  SELECT zoho_service_key(v) AS key, v, from_leads
    FROM raw AS r(v, from_leads)
   WHERE v <> ''
)
SELECT key,
       -- Labelled from the LEADS pool wherever the service appears there, and
       -- only from the wider pool otherwise. Without the FILTER, adding ~8.4k
       -- accounts to the vote would flip "Distribution publicitaire" (2,043
       -- leads, lowercase p) to the account picklist's "Distribution
       -- Publicitaire" and silently rename a bar on a dashboard this migration
       -- has no business touching.
       COALESCE(
         mode() WITHIN GROUP (ORDER BY v) FILTER (WHERE from_leads),
         mode() WITHIN GROUP (ORDER BY v)
       )                                AS label,
       array_agg(DISTINCT v ORDER BY v) AS variants
  FROM keyed
 GROUP BY key;


-- ─── Filter options ───────────────────────────────────────────────────────────
-- Re-pointed at the resolved columns. Body is otherwise unchanged from
-- 20260903030000: same p_stage handling, same Montreal-calendar year bound.
--
-- This is what makes the account- and invoice-derived values selectable. The
-- dashboard and rep portal pass p_stage => 'lead' and therefore see exactly the
-- same list as before, since a lead's resolved values are its own values.

CREATE OR REPLACE FUNCTION get_zoho_lead_filter_options(
  p_year  INT  DEFAULT NULL,
  -- 'lead' or 'contact' to match one module; NULL for both, which is what the
  -- detail page wants.
  p_stage TEXT DEFAULT NULL
)
RETURNS TABLE (
  sources          TEXT[],
  services         TEXT[],
  reps             TEXT[],
  -- { "Distribution publicitaire": ["Distribution publicitaire", "Distribution Publicitaire"], … }
  service_variants JSONB
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT source_resolved AS lead_source,
           service_resolved AS service_interest,
           rep_name
      FROM zoho_leads_unique
     WHERE (p_stage IS NULL OR stage = p_stage)
       -- Bounded on the local calendar year, to agree with zoho_leads_scoped.
       AND (p_year IS NULL
            OR EXTRACT(YEAR FROM created_time AT TIME ZONE 'America/Toronto')::INT = p_year)
  ),
  -- Only the services actually present in scope, labelled from the global map so
  -- the same service always reads the same way.
  svc_folded AS (
    SELECT DISTINCT l.label, l.variants
      FROM scoped, LATERAL unnest(service_interest) AS s
      JOIN zoho_service_labels l ON l.key = zoho_service_key(s)
     WHERE btrim(s) <> ''
  )
  SELECT
    -- '-None-' is what Zoho stores in a picklist that was never set.
    (SELECT COALESCE(array_agg(DISTINCT lead_source ORDER BY lead_source), '{}')
       FROM scoped WHERE lead_source IS NOT NULL AND lead_source <> '-None-'),
    (SELECT COALESCE(array_agg(label ORDER BY label), '{}') FROM svc_folded),
    (SELECT COALESCE(array_agg(DISTINCT rep_name ORDER BY rep_name), '{}')
       FROM scoped WHERE rep_name IS NOT NULL AND rep_name <> ''),
    (SELECT COALESCE(jsonb_object_agg(label, to_jsonb(variants)), '{}'::jsonb) FROM svc_folded);
$$;

GRANT EXECUTE ON FUNCTION get_zoho_lead_filter_options(INT, TEXT) TO authenticated;
