-- What the Leads page needs to render an "Factures" column and its detail modal.
--
-- Two functions rather than one: the table shows a page of 100 leads at a time and
-- needs one aggregate per account (one round trip for the whole page), while the
-- modal needs the full line items for a single account (one round trip on click).
-- Fetching every invoice for 100 accounts up front would move thousands of rows
-- to the browser to render a count and a total.

-- ─── Per-account rollup for the table column ──────────────────────────────────

DROP FUNCTION IF EXISTS get_lead_invoice_totals(TEXT[]);

CREATE OR REPLACE FUNCTION get_lead_invoice_totals(p_account_ids TEXT[])
RETURNS TABLE (
  account_id        TEXT,
  invoice_count     INTEGER,
  credit_count      INTEGER,
  total_amount      NUMERIC,
  last_invoice_date DATE
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    i.crm_account_id,
    count(*) FILTER (WHERE NOT i.is_avoir)::INTEGER,
    count(*) FILTER (WHERE i.is_avoir)::INTEGER,
    -- Avoirs are stored negative, so a plain sum is already the net figure.
    COALESCE(sum(i.amount), 0),
    max(i.invoice_date)
  FROM invoices i
  WHERE i.crm_account_id = ANY(p_account_ids)
  GROUP BY i.crm_account_id;
$$;

GRANT EXECUTE ON FUNCTION get_lead_invoice_totals(TEXT[]) TO authenticated;

-- ─── Line items for the modal ─────────────────────────────────────────────────

DROP FUNCTION IF EXISTS get_lead_invoices(TEXT);

CREATE OR REPLACE FUNCTION get_lead_invoices(p_account_id TEXT)
RETURNS TABLE (
  zoho_id           TEXT,
  invoice_number    TEXT,
  client_name       TEXT,
  amount            NUMERIC,
  invoice_date      DATE,
  status            TEXT,
  is_avoir          BOOLEAN,
  department        TEXT,
  office            TEXT,
  rep_name          TEXT,
  books_customer_id TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    i.zoho_id, i.invoice_number, i.client_name, i.amount, i.invoice_date,
    i.status::TEXT, i.is_avoir, i.department, i.office, i.rep_name,
    i.books_customer_id
  FROM invoices i
  WHERE p_account_id IS NOT NULL
    AND i.crm_account_id = p_account_id
  ORDER BY i.invoice_date DESC NULLS LAST, i.invoice_number DESC;
$$;

GRANT EXECUTE ON FUNCTION get_lead_invoices(TEXT) TO authenticated;

-- ─── Linkage health ───────────────────────────────────────────────────────────
-- How far the backfill has got, and how much of the invoice book is attributable.
-- Read by the Settings sync panel; also the first thing to check when a lead shows
-- no invoices — an unresolved customer and a customer with no CRM account look
-- identical from the Leads page.

CREATE OR REPLACE FUNCTION get_invoice_linkage_status()
RETURNS TABLE (
  customers_total     INTEGER,
  customers_pending   INTEGER,
  customers_linked    INTEGER,
  customers_unlinked  INTEGER,
  customers_error     INTEGER,
  invoices_total      INTEGER,
  invoices_with_account INTEGER
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (SELECT count(*)::INTEGER FROM zoho_books_customers),
    (SELECT count(*)::INTEGER FROM zoho_books_customers WHERE link_status = 'pending'),
    (SELECT count(*)::INTEGER FROM zoho_books_customers WHERE link_status = 'linked'),
    (SELECT count(*)::INTEGER FROM zoho_books_customers WHERE link_status = 'unlinked'),
    (SELECT count(*)::INTEGER FROM zoho_books_customers WHERE link_status = 'error'),
    (SELECT count(*)::INTEGER FROM invoices),
    (SELECT count(*)::INTEGER FROM invoices WHERE crm_account_id IS NOT NULL);
$$;

GRANT EXECUTE ON FUNCTION get_invoice_linkage_status() TO authenticated;
