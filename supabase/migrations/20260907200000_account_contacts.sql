-- The people at a company, for the Comptes detail page.
--
-- The Comptes module deliberately counts companies rather than people — that was
-- the whole point of replacing the Leads pages. But when somebody has found the
-- company they were looking for and wants to phone it, "who do I call" is the
-- next question, and sending them back to Zoho for a name and a number is a poor
-- answer when the app already holds both.
--
-- So: contacts are never counted anywhere, and are shown only on the one screen
-- where a human is already looking at a single company.
--
-- Reads zoho_leads, which holds Leads and Contacts in one table with `stage`
-- saying which. Both are returned: a lead that has not converted yet still has a
-- phone number worth having, and the stage column says which is which.

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
    FROM zoho_leads z
   WHERE p_account_id IS NOT NULL
     AND z.account_id = p_account_id
   -- Contacts before leads, then newest first: a contact is a live relationship,
   -- a lead attached to an existing account is usually an old enquiry.
   ORDER BY (z.stage = 'contact') DESC, z.created_time DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION get_account_contacts(TEXT) TO authenticated;
