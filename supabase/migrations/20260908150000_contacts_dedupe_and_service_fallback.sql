-- Two fixes reported 2026-09-08.

-- ─── 1. The same person listed twice, once tagged "Lead" ──────────────────────
--
-- Vivre Ici showed "Sylvain Bolduc" twice — same phone, same email — with a
-- "Lead" badge on the second. Both rows are real: zoho_leads holds Leads AND
-- Contacts, and when Zoho converts a lead it creates the contact WITHOUT
-- removing the lead. So a converted person exists twice.
--
-- zoho_leads_unique already solves this: it drops a converted lead when the
-- contact it became is also synced. get_account_contacts was reading the base
-- table and so showed both halves of the same person.
--
-- The Lead badge stays meaningful after this change — it now marks only people
-- who really are still leads, which is the point of showing it.

CREATE OR REPLACE FUNCTION get_account_contacts(p_account_id TEXT)
RETURNS TABLE (
  zoho_record_id TEXT,
  stage          TEXT,
  full_name      TEXT,
  email          TEXT,
  phone          TEXT,
  rep_name       TEXT,
  lead_status    TEXT,
  created_time   TIMESTAMPTZ,
  zoho_crm_url   TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT z.zoho_record_id, z.stage, z.full_name, z.email, z.phone,
         z.rep_name, z.lead_status, z.created_time, z.zoho_crm_url
    FROM zoho_leads_unique z
   WHERE p_account_id IS NOT NULL
     AND z.account_id = p_account_id
   ORDER BY (z.stage = 'contact') DESC, z.created_time DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION get_account_contacts(TEXT) TO authenticated;

-- ─── 2. An empty Service column on a company that has clearly bought things ───
--
-- Shop Santé Inc. showed nothing under Service, yet opening it listed invoices
-- under DIST. PUBLICITAIRE SOLO and MULTI-ANNONCEURS. Both are true: Zoho's
-- service multiselect is the service the customer ASKED about when they arrived,
-- and 59% of accounts have never had it filled in. What they actually BOUGHT
-- lives on the invoices, as a department.
--
-- So the column falls back the same way the Leads page already does: the CRM
-- service when there is one, otherwise the departments actually billed.
-- service_origin says which, so the table can mark a borrowed value rather than
-- passing an invoice department off as a CRM answer.
--
-- Departments keep Zoho Books' own wording ("DIST. PUBLICITAIRE SOLO"), NOT
-- translated into the CRM's service vocabulary — six departments against eight
-- services, with no honest mapping for MULTI-ANNONCEURS. That is the same
-- decision already documented for contacts in CLAUDE.md.

CREATE OR REPLACE VIEW zoho_accounts_enriched
WITH (security_invoker = true) AS
SELECT
  a.zoho_account_id,
  a.account_name,
  a.phone,
  a.website,
  a.description,
  a.billing_street,
  a.billing_city,
  a.billing_state,
  a.billing_code,
  a.billing_country,

  a.owner_name,
  a.owner_email,
  a.rep_name,
  a.charge_de_projets,

  a.created_time,
  zoho_local_date(a.created_time) AS created_date,
  a.modified_time,
  a.last_activity_time,

  a.origine_du_client,
  a.service_interest,
  a.domaine_activite,
  a.region_administrative,
  a.region_cible,
  a.type_marche,
  a.periode_publicitaire,
  a.nombre_employes,
  a.budget_publicitaire_annuel,
  a.potentiel_multi_annonceurs,
  a.potentiel_services_ia,
  a.revendeur,
  a.rating,
  a.tags,

  a.parent_account_id,
  a.parent_account_name,

  a.nombre_taches,
  a.derniere_tache_fermee,

  a.ventes_totales,
  a.ventes_2026,
  a.ventes_2025,

  a.zoho_crm_url,

  COALESCE(i.invoice_count, 0)    AS invoice_count,
  COALESCE(i.credit_count, 0)     AS credit_count,
  COALESCE(i.revenue_lifetime, 0) AS revenue_lifetime,
  i.first_invoice_date,
  i.last_invoice_date,
  (i.invoice_count IS NOT NULL)   AS has_invoices,

  zoho_account_is_bulk_import(a.origine_du_client) AS is_bulk_import,

  COALESCE(a.rating = ANY(zoho_internal_ratings()), FALSE) AS is_internal,

  -- What to show in the Service column: the CRM answer when there is one, the
  -- departments actually billed otherwise.
  CASE
    WHEN cardinality(a.service_interest) > 0 THEN a.service_interest
    ELSE COALESCE(i.departments, '{}')
  END AS service_resolved,

  CASE
    WHEN cardinality(a.service_interest) > 0 THEN 'crm'
    WHEN COALESCE(cardinality(i.departments), 0) > 0 THEN 'invoice'
    ELSE 'none'
  END AS service_origin

FROM zoho_accounts a
LEFT JOIN (
  SELECT
    crm_account_id,
    count(*) FILTER (WHERE NOT is_avoir)::INT AS invoice_count,
    count(*) FILTER (WHERE is_avoir)::INT     AS credit_count,
    COALESCE(sum(amount), 0)                  AS revenue_lifetime,
    min(invoice_date)                         AS first_invoice_date,
    max(invoice_date)                         AS last_invoice_date,
    -- Credit notes excluded: a refund is not evidence of a service bought.
    array_agg(DISTINCT department ORDER BY department)
      FILTER (WHERE department IS NOT NULL AND NOT is_avoir) AS departments
  FROM invoices
  WHERE crm_account_id IS NOT NULL
  GROUP BY crm_account_id
) i ON i.crm_account_id = a.zoho_account_id;

GRANT SELECT ON zoho_accounts_enriched TO authenticated;
