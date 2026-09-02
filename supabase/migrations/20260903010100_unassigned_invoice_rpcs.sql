-- How much invoicing the app cannot tie back to a CRM account, and which rows.
--
-- Every invoice reaches a lead through invoices.crm_account_id (see
-- 20260903000000_invoice_account_linkage.sql). When that is NULL the money is
-- real but belongs to nobody in the Leads view, so it silently disappears from
-- attribution. This surfaces it on the Factures dashboard instead of leaving it
-- to be discovered by someone noticing the totals do not reconcile.
--
-- Two distinct causes, reported separately because only one is a problem:
--
--   * The Books customer exists but carries no CRM account (`unlinked`) — 378
--     invoices. These are genuine attribution gaps.
--   * The invoice has no Books customer id at all — 27 rows, all 2026 credit
--     notes that Zoho no longer returns.
--
-- Internal billing is excluded from the headline figure. "Affichez Inc." bills
-- itself 34 times for $868,058 — 77% of the raw unassigned total — and reporting
-- that as a gap would be misleading, since it is not a client and never will have
-- a CRM account. It is returned separately so the number is auditable rather than
-- quietly dropped.

/**
 * Matches the company's own name in invoices.client_name. Exactly one customer
 * matches today ("Affichez Inc."); the pattern rather than the literal so a
 * variant spelling is caught too.
 */
CREATE OR REPLACE FUNCTION invoice_is_internal(p_client_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(p_client_name, '') ILIKE '%affichez%';
$$;

GRANT EXECUTE ON FUNCTION invoice_is_internal(TEXT) TO authenticated;


CREATE OR REPLACE FUNCTION get_invoice_unassigned_summary(
  p_year   INT  DEFAULT NULL,
  p_office TEXT DEFAULT NULL,
  p_month  INT  DEFAULT NULL,
  p_dept   TEXT DEFAULT NULL,
  p_rep    TEXT DEFAULT NULL
)
RETURNS TABLE (
  unassigned_count  BIGINT,
  unassigned_amount NUMERIC,
  internal_count    BIGINT,
  internal_amount   NUMERIC,
  assigned_amount   NUMERIC,
  total_count       BIGINT,
  total_amount      NUMERIC,
  unassigned_share  NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT i.amount, i.crm_account_id, invoice_is_internal(i.client_name) AS internal
      FROM invoices i
     WHERE (p_year   IS NULL OR EXTRACT(YEAR  FROM i.invoice_date)::INT = p_year)
       AND (p_month  IS NULL OR EXTRACT(MONTH FROM i.invoice_date)::INT = p_month)
       AND (p_office IS NULL OR i.office     = p_office)
       AND (p_dept   IS NULL OR i.department = p_dept)
       AND (p_rep    IS NULL OR i.rep_name   = p_rep)
  ), agg AS (
    SELECT
      count(*) FILTER (WHERE crm_account_id IS NULL AND NOT internal)        AS un_n,
      COALESCE(sum(amount) FILTER (WHERE crm_account_id IS NULL AND NOT internal), 0) AS un_amt,
      count(*) FILTER (WHERE internal)                                      AS int_n,
      COALESCE(sum(amount) FILTER (WHERE internal), 0)                      AS int_amt,
      COALESCE(sum(amount) FILTER (WHERE crm_account_id IS NOT NULL AND NOT internal), 0) AS as_amt,
      count(*)                                                              AS all_n,
      COALESCE(sum(amount), 0)                                              AS all_amt
      FROM scoped
  )
  SELECT
    un_n, un_amt, int_n, int_amt, as_amt, all_n, all_amt,
    -- Share of non-internal billing that cannot be attributed. Guarded against a
    -- zero or negative denominator (a month of nothing but credit notes).
    CASE WHEN (un_amt + as_amt) <= 0 THEN 0
         ELSE ROUND(un_amt * 100.0 / (un_amt + as_amt), 1) END
  FROM agg;
$$;

GRANT EXECUTE ON FUNCTION get_invoice_unassigned_summary(INT, TEXT, INT, TEXT, TEXT) TO authenticated;


/** The rows behind the figure, for the drill-down. Internal billing excluded, to match. */
CREATE OR REPLACE FUNCTION get_unassigned_invoices(
  p_year   INT  DEFAULT NULL,
  p_office TEXT DEFAULT NULL,
  p_month  INT  DEFAULT NULL,
  p_dept   TEXT DEFAULT NULL,
  p_rep    TEXT DEFAULT NULL,
  p_limit  INT  DEFAULT 500
)
RETURNS TABLE (
  zoho_id        TEXT,
  invoice_number TEXT,
  client_name    TEXT,
  amount         NUMERIC,
  invoice_date   DATE,
  status         TEXT,
  is_avoir       BOOLEAN,
  department     TEXT,
  office         TEXT,
  rep_name       TEXT,
  reason         TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    i.zoho_id, i.invoice_number, i.client_name, i.amount, i.invoice_date,
    i.status::TEXT, i.is_avoir, i.department, i.office, i.rep_name,
    CASE
      WHEN i.books_customer_id IS NULL THEN 'Aucun client Zoho Books'
      WHEN c.books_customer_id IS NULL THEN 'Client pas encore analysé'
      WHEN c.link_status = 'unlinked'  THEN 'Client sans compte CRM'
      WHEN c.link_status = 'error'     THEN 'Erreur de liaison'
      ELSE 'En attente de liaison'
    END
  FROM invoices i
  LEFT JOIN zoho_books_customers c ON c.books_customer_id = i.books_customer_id
  WHERE i.crm_account_id IS NULL
    AND NOT invoice_is_internal(i.client_name)
    AND (p_year   IS NULL OR EXTRACT(YEAR  FROM i.invoice_date)::INT = p_year)
    AND (p_month  IS NULL OR EXTRACT(MONTH FROM i.invoice_date)::INT = p_month)
    AND (p_office IS NULL OR i.office     = p_office)
    AND (p_dept   IS NULL OR i.department = p_dept)
    AND (p_rep    IS NULL OR i.rep_name   = p_rep)
  ORDER BY abs(i.amount) DESC, i.invoice_date DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION get_unassigned_invoices(INT, TEXT, INT, TEXT, TEXT, INT) TO authenticated;
