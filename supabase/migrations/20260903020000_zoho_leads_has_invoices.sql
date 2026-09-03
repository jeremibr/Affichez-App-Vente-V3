-- Let the Leads detail page filter on "has invoices" without pulling the rows
-- to the browser first.
--
-- The Factures column is populated after the fact by get_lead_invoice_totals,
-- one round trip per page of 100. That is fine for display, but it cannot drive
-- a filter: the page is cut by LIMIT/OFFSET in Postgres, so filtering on the
-- rollup client-side would search 100 rows out of ~29k and page counts would be
-- wrong. The flag therefore has to exist on the row PostgREST is selecting.
--
-- Definition matches exactly what the Factures cell shows — "this record's CRM
-- account has at least one invoice or avoir, ever" — so "Avec factures" returns
-- precisely the rows whose cell carries a number, and "Sans factures" precisely
-- the rows showing an em dash. Deliberately NOT date-scoped the way the
-- dashboard's revenue_attributed is: that KPI answers "did this lead generate
-- revenue", while this column answers "is this account billed at all", and the
-- two would disagree on screen for an account invoiced before the lead arrived.
--
-- A record with no account_id (an open lead, or a contact with no company in the
-- CRM) is false, not null: nothing to look up is indistinguishable from nothing
-- found, from the reader's side of the table.
--
-- Cost: one index probe per row on invoices_crm_account_idx. Only paid when the
-- filter is applied — as a target-list expression Postgres evaluates it for the
-- ~100 rows that survive the LIMIT, not the whole table.
--
-- Body is unchanged from 20260903000100_zoho_leads_account_id.sql; only the
-- trailing column is new. CREATE OR REPLACE VIEW allows appending columns but
-- not reordering them, so a future `ALTER TABLE zoho_leads ADD COLUMN` will need
-- this file's SELECT list re-applied rather than a bare `SELECT l.*`.
CREATE OR REPLACE VIEW zoho_leads_unique
WITH (security_invoker = true) AS
SELECT l.*,
       (l.account_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM invoices i WHERE i.crm_account_id = l.account_id
        )) AS has_invoices
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
  'has_invoices: the record''s CRM account has at least one invoice or avoir. '
  'Directory view — use zoho_leads with stage = ''lead'' for funnel counts.';
