-- An `is_internal` flag on zoho_accounts_enriched.
--
-- The dashboard RPCs take p_exclude_ratings and handle NULL ratings correctly in
-- SQL. The detail table cannot: it queries the view straight through PostgREST,
-- and `rating=not.in.("Compte interne : Ne pas reprendre","Fournisseur")` becomes
-- `NOT (rating IN (...))`, which evaluates to NULL — not TRUE — for the 977
-- accounts with no rating at all. They would silently vanish from the table
-- while still being counted on the dashboard, and the two pages would disagree
-- for a reason nobody could see.
--
-- A precomputed boolean sidesteps the whole three-valued-logic problem: the
-- table filters `is_internal=eq.false` and NULL ratings are FALSE, which is what
-- "is this one of Affichez's own entities" should say about an account that
-- never got rated.

-- The list, in one place. zoho_accounts_scoped's p_exclude_ratings default is
-- the same two values written as a literal array — a parameter default cannot
-- read a column, so it cannot call this. Change one, change the other.
CREATE OR REPLACE FUNCTION zoho_internal_ratings()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY['Compte interne : Ne pas reprendre', 'Fournisseur'];
$$;

GRANT EXECUTE ON FUNCTION zoho_internal_ratings() TO authenticated;

COMMENT ON FUNCTION zoho_internal_ratings() IS
  'Zoho Rating values that mark an Affichez entity rather than a client. '
  'Excluded by default on the Comptes dashboard and detail table; both keep a '
  'filter to switch them back on. Mirrored by zoho_accounts_scoped''s '
  'p_exclude_ratings default.';

-- CREATE OR REPLACE VIEW can only append columns, which is all this does — the
-- 40 columns above it are unchanged and repeated verbatim so the replace is
-- accepted.
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

  -- COALESCE, not a bare =: an unrated account is a client until told otherwise.
  COALESCE(a.rating = ANY(zoho_internal_ratings()), FALSE) AS is_internal

FROM zoho_accounts a
LEFT JOIN (
  SELECT
    crm_account_id,
    count(*) FILTER (WHERE NOT is_avoir)::INT AS invoice_count,
    count(*) FILTER (WHERE is_avoir)::INT     AS credit_count,
    COALESCE(sum(amount), 0)                  AS revenue_lifetime,
    min(invoice_date)                         AS first_invoice_date,
    max(invoice_date)                         AS last_invoice_date
  FROM invoices
  WHERE crm_account_id IS NOT NULL
  GROUP BY crm_account_id
) i ON i.crm_account_id = a.zoho_account_id;

GRANT SELECT ON zoho_accounts_enriched TO authenticated;
