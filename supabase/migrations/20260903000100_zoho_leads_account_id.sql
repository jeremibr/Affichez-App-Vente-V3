-- The CRM account a lead or contact belongs to — the key that joins a person to
-- their invoices (see 20260903000000_invoice_account_linkage.sql).
--
-- One column for both stages, because the question "which account is this?" has a
-- different answer per module:
--   contact → Contacts.Account_Name.id   (the account it belongs to)
--   lead    → Converted_Account.id       (the account it became, NULL if still open)
--
-- converted_account_id is kept as it was: it means "this lead created that
-- account", which is a narrower claim than account_id's "this record belongs to
-- that account". The sync writes both.

ALTER TABLE zoho_leads
  ADD COLUMN IF NOT EXISTS account_id TEXT;

COMMENT ON COLUMN zoho_leads.account_id IS
  'Zoho CRM account id this record belongs to. Contacts: Account_Name.id. '
  'Leads: Converted_Account.id, NULL while unconverted. Joins to invoices.crm_account_id.';

CREATE INDEX IF NOT EXISTS zoho_leads_account_idx
  ON zoho_leads(account_id)
  WHERE account_id IS NOT NULL;

-- Converted leads can be back-filled here and now — the pointer is already stored.
-- Contacts need Account_Name from the CRM, so they are filled by the next
-- zoho-lead-sync run rather than guessed at.
UPDATE zoho_leads
   SET account_id = converted_account_id
 WHERE stage = 'lead'
   AND converted_account_id IS NOT NULL
   AND account_id IS NULL;

-- The view selects l.*, and Postgres froze that into an explicit column list when
-- the view was created — so account_id is invisible to the app until the view is
-- replaced. Body unchanged from 20260901220000_dedupe_leads_by_email.sql; only the
-- column list is being refreshed.
CREATE OR REPLACE VIEW zoho_leads_unique
WITH (security_invoker = true) AS
SELECT l.*
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
