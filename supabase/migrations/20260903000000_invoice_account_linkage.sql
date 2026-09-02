-- Bind every invoice to the Zoho CRM account that owns it, so a lead/contact can
-- show its invoices.
--
-- The chain, and why it runs in this direction:
--
--   CRM Contact ──Account_Name──▶ CRM Account ◀──zcrm_account_id── Books customer
--                                                                        ▲
--                                                                   customer_id
--                                                                        │
--                                                                     Invoice
--
-- Zoho Books stores the CRM account id on the *customer* (`zcrm_account_id`), and
-- every invoice already names its customer (`customer_id`). So the cheap direction
-- is invoice → customer → account, not account → customer.
--
-- Measured on live data (2026-09-03): 14,010 invoices point at only 3,107 distinct
-- customers (QC 2,283 / MTL 824), and 79 of 80 sampled customers carried a
-- zcrm_account_id — 97.5% QC, 100% MTL. Resolving per *customer* therefore costs
-- ~3,100 Books API calls once; resolving per *account* would have cost 41,000
-- (20,617 CRM accounts x 2 orgs). The CRM side offers no shortcut: the Accounts
-- module has no Books field, so the Books API is the only bridge.
--
-- `zoho_books_customers` is that bridge, cached. Zoho Books allows 100 API calls
-- per minute per organization and 1,000-10,000 per day depending on plan, so the
-- mapping is resolved once and reused rather than looked up per request.

-- ─── The bridge table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS zoho_books_customers (
  -- Books customer id. Globally unique across both orgs — QC ids start 6027…,
  -- MTL 4210… — so this is safe as a bare primary key.
  books_customer_id TEXT PRIMARY KEY,
  office            TEXT NOT NULL CHECK (office IN ('QC', 'MTL')),
  customer_name     TEXT,

  -- From the Books contact detail endpoint. NULL once link_status says 'unlinked':
  -- the customer exists in Books but was never tied to a CRM account.
  crm_account_id    TEXT,
  -- Books also names the primary CRM contact for the account. Kept for reference
  -- only — invoices are matched on the account, see the note at the bottom.
  crm_contact_id    TEXT,

  --   pending  — discovered from an invoice, not yet asked about
  --   linked   — Books returned a zcrm_account_id
  --   unlinked — Books answered, and the customer carries no CRM account
  --   error    — the lookup failed; retried on the next run
  link_status       TEXT NOT NULL DEFAULT 'pending'
                      CHECK (link_status IN ('pending', 'linked', 'unlinked', 'error')),
  last_error        TEXT,
  resolved_at       TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The resolver's work queue: pending first, then errors to retry.
CREATE INDEX IF NOT EXISTS zoho_books_customers_status_idx
  ON zoho_books_customers(link_status)
  WHERE link_status IN ('pending', 'error');

CREATE INDEX IF NOT EXISTS zoho_books_customers_account_idx
  ON zoho_books_customers(crm_account_id)
  WHERE crm_account_id IS NOT NULL;

ALTER TABLE zoho_books_customers ENABLE ROW LEVEL SECURITY;

-- Read-only to the app, like zoho_leads. Every write goes through the edge
-- function's service-role key, which bypasses RLS.
DROP POLICY IF EXISTS "zoho_books_customers_select_authenticated" ON zoho_books_customers;
CREATE POLICY "zoho_books_customers_select_authenticated"
  ON zoho_books_customers FOR SELECT TO authenticated USING (true);

-- ─── Invoice columns ──────────────────────────────────────────────────────────

ALTER TABLE invoices
  -- Zoho Books `invoice.customer_id` / `creditnote.customer_id`. Comes free with
  -- the existing sync — it is already in the list response we fetch.
  ADD COLUMN IF NOT EXISTS books_customer_id TEXT,
  -- Denormalised from zoho_books_customers by the triggers below, so the Leads
  -- page can filter and aggregate without a join through the bridge.
  ADD COLUMN IF NOT EXISTS crm_account_id    TEXT,
  ADD COLUMN IF NOT EXISTS crm_contact_id    TEXT;

-- Drives get_lead_invoices / get_lead_invoice_totals.
CREATE INDEX IF NOT EXISTS invoices_crm_account_idx
  ON invoices(crm_account_id)
  WHERE crm_account_id IS NOT NULL;

-- Used by the customer→invoice propagation trigger and by the discovery pass.
CREATE INDEX IF NOT EXISTS invoices_books_customer_idx
  ON invoices(books_customer_id)
  WHERE books_customer_id IS NOT NULL;

COMMENT ON COLUMN invoices.books_customer_id IS
  'Zoho Books customer_id. The raw link; always available from the sync.';
COMMENT ON COLUMN invoices.crm_account_id IS
  'Zoho CRM account id, resolved via zoho_books_customers. NULL when the Books '
  'customer has no CRM account. Maintained by trigger, never written by the sync.';

-- ─── Keeping the two in step ──────────────────────────────────────────────────
-- Two triggers, one per direction, so the linkage is self-maintaining: the sync
-- writes only books_customer_id, the resolver writes only the bridge table, and
-- neither has to know about the other.

-- Direction 1: a new or re-synced invoice picks up whatever the bridge knows.
CREATE OR REPLACE FUNCTION invoices_fill_crm_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- A miss leaves both NULL, which is the right answer: the customer is not yet
  -- resolved, or has no CRM account. The resolver fills it in later via trigger 2.
  SELECT c.crm_account_id, c.crm_contact_id
    INTO NEW.crm_account_id, NEW.crm_contact_id
    FROM zoho_books_customers c
   WHERE c.books_customer_id = NEW.books_customer_id
     AND c.link_status = 'linked';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_fill_crm_account_trg ON invoices;
CREATE TRIGGER invoices_fill_crm_account_trg
  BEFORE INSERT OR UPDATE OF books_customer_id ON invoices
  FOR EACH ROW
  WHEN (NEW.books_customer_id IS NOT NULL)
  EXECUTE FUNCTION invoices_fill_crm_account();

-- Direction 2: a customer that has just been resolved back-fills its invoices.
CREATE OR REPLACE FUNCTION zoho_books_customers_propagate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE invoices i
     SET crm_account_id = NEW.crm_account_id,
         crm_contact_id = NEW.crm_contact_id
   WHERE i.books_customer_id = NEW.books_customer_id
     AND (i.crm_account_id IS DISTINCT FROM NEW.crm_account_id
       OR i.crm_contact_id IS DISTINCT FROM NEW.crm_contact_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS zoho_books_customers_propagate_trg ON zoho_books_customers;
CREATE TRIGGER zoho_books_customers_propagate_trg
  AFTER INSERT OR UPDATE OF crm_account_id, crm_contact_id ON zoho_books_customers
  FOR EACH ROW EXECUTE FUNCTION zoho_books_customers_propagate();

-- ─── Discovery ────────────────────────────────────────────────────────────────
-- Adds every customer named by an invoice to the resolver queue. Cheap to re-run:
-- ON CONFLICT DO NOTHING means an already-resolved customer is never re-queued.

CREATE OR REPLACE FUNCTION enqueue_books_customers()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted INTEGER;
BEGIN
  WITH candidates AS (
    -- DISTINCT ON keeps one row per customer, preferring the most recent invoice
    -- so customer_name reflects the latest spelling in Books.
    SELECT DISTINCT ON (i.books_customer_id)
           i.books_customer_id, i.office, i.client_name
      FROM invoices i
     WHERE i.books_customer_id IS NOT NULL
       AND i.office IS NOT NULL   -- the org id is needed to call Zoho
     ORDER BY i.books_customer_id, i.invoice_date DESC NULLS LAST
  ), ins AS (
    INSERT INTO zoho_books_customers (books_customer_id, office, customer_name, link_status)
    SELECT books_customer_id, office, client_name, 'pending' FROM candidates
    ON CONFLICT (books_customer_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_inserted FROM ins;

  RETURN v_inserted;
END;
$$;

-- Called only by the edge function's service-role key; no grant to authenticated.
REVOKE ALL ON FUNCTION enqueue_books_customers() FROM PUBLIC;

-- ─── A note on granularity ────────────────────────────────────────────────────
-- Invoices attach to an ACCOUNT, not to a person. Zoho Books links its customers
-- to CRM accounts (zcrm_account_id), and a CRM account can hold several contacts,
-- so two contacts at the same company legitimately show the same invoices. That
-- is the real shape of the data, not an approximation: Books has no per-contact
-- invoice ownership to draw on. crm_contact_id records which contact Books calls
-- the account's primary, and is displayed as a hint, never used to filter.
