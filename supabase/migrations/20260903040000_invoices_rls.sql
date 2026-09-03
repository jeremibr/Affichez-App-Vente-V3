-- Close the invoice book to anonymous readers.
--
-- `invoices` was created without RLS and never had any enabled, so the anon key —
-- which ships inside the built JS bundle and is therefore public to anyone with
-- the site URL — could read all 14,020 rows: client names, amounts, reps, offices.
-- Verified on 2026-09-03 by querying /rest/v1/invoices with nothing but that key.
--
-- Every other table in this schema is already authenticated-only (zoho_leads,
-- zoho_books_customers); invoices was simply the one that predates that pattern.
-- This matches them.
--
-- Note for anyone auditing the rest of this schema: the `GRANT EXECUTE ... TO
-- authenticated` lines on the RPCs are decorative. Postgres grants EXECUTE on a
-- new function to PUBLIC by default and nothing here revokes it, so anon can call
-- every one of them — confirmed by reaching get_invoice_linkage_status with the
-- anon key. Table RLS is the only real boundary, which is why this file matters.
--
-- Writes are unaffected: the Zoho sync edge functions use the service-role key,
-- which bypasses RLS entirely. Reads from the app are unaffected too — every page
-- that touches invoices does so behind the login.

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invoices_select_authenticated" ON invoices;
CREATE POLICY "invoices_select_authenticated"
  ON invoices FOR SELECT TO authenticated USING (true);

-- The lead-facing RPCs are SECURITY INVOKER and read invoices, so they inherit
-- the policy above rather than working around it. Left explicit here because a
-- future SECURITY DEFINER function would silently re-open this door.
COMMENT ON TABLE invoices IS
  'Zoho Books invoices and credit notes, both organisations. RLS: readable by '
  'authenticated users only; written solely by the sync edge functions under the '
  'service-role key.';
