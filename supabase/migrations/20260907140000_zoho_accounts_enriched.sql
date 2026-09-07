-- One row per account, with its invoice rollup already attached.
--
-- What the Comptes detail table reads. It exists so the table can filter, sort
-- and paginate in Postgres: the page shows 100 of 20,645 rows, so a "comptes
-- facturés seulement" filter applied in the browser would search 100 records and
-- leave the count and the pager wrong — the same trap documented on the leads
-- side in 20260901220000.
--
-- Revenue here is LIFETIME, not windowed. A row is an account, and an account's
-- own page should show what it has actually billed; the 12-month attribution
-- window is a property of a cohort comparison, which is the dashboard's job, and
-- a window cannot be a column in a static view anyway. get_zoho_account_kpis and
-- the breakdowns are where p_window_months lives.
--
-- security_invoker so the view inherits RLS from zoho_accounts and invoices
-- rather than running as its owner.

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

  -- Royer & Fils / VotreLogo.ca promo revenue, from the CRM rollup. Kept beside
  -- the invoice figures and never added into them: that business is billed
  -- outside the QC and MTL Books orgs, so the two never overlap and summing them
  -- would put two companies' revenue in one column.
  a.ventes_totales,
  a.ventes_2026,
  a.ventes_2025,

  a.zoho_crm_url,

  -- Invoice rollup. LEFT JOIN, so the 17,680 accounts that have never been
  -- billed still appear — they are most of the book and the whole point of an
  -- invoiced-rate.
  COALESCE(i.invoice_count, 0)  AS invoice_count,
  COALESCE(i.credit_count, 0)   AS credit_count,
  COALESCE(i.revenue_lifetime, 0) AS revenue_lifetime,
  i.first_invoice_date,
  i.last_invoice_date,
  (i.invoice_count IS NOT NULL) AS has_invoices,

  zoho_account_is_bulk_import(a.origine_du_client) AS is_bulk_import

FROM zoho_accounts a
LEFT JOIN (
  SELECT
    crm_account_id,
    count(*) FILTER (WHERE NOT is_avoir)::INT AS invoice_count,
    count(*) FILTER (WHERE is_avoir)::INT     AS credit_count,
    -- Avoirs are stored negative, so a plain sum is already net of credits.
    COALESCE(sum(amount), 0)                  AS revenue_lifetime,
    min(invoice_date)                         AS first_invoice_date,
    max(invoice_date)                         AS last_invoice_date
  FROM invoices
  WHERE crm_account_id IS NOT NULL
  GROUP BY crm_account_id
) i ON i.crm_account_id = a.zoho_account_id;

GRANT SELECT ON zoho_accounts_enriched TO authenticated;

COMMENT ON VIEW zoho_accounts_enriched IS
  'One row per Zoho CRM account with its lifetime invoice rollup attached. '
  'Backs the Comptes detail table, which filters and paginates server-side. '
  'Revenue is lifetime; the 12-month attribution window lives in '
  'get_zoho_account_kpis and the breakdown RPCs, not here.';
