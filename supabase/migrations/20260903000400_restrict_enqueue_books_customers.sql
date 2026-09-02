-- Keep enqueue_books_customers() out of the browser's reach.
--
-- It is SECURITY DEFINER and writes to zoho_books_customers, so it should only be
-- callable by the edge function's service-role key. The REVOKE ... FROM PUBLIC in
-- 20260903000000 is not enough on its own: Supabase's default privileges grant
-- EXECUTE to anon and authenticated explicitly, and revoking the PUBLIC grant
-- leaves those role-level grants in place.
--
-- Nothing in the app calls it — the two read-only RPCs the Leads page and the
-- Settings panel use (get_lead_invoices, get_lead_invoice_totals,
-- get_invoice_linkage_status) are unaffected.

REVOKE ALL ON FUNCTION enqueue_books_customers() FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_books_customers() FROM anon;
REVOKE ALL ON FUNCTION enqueue_books_customers() FROM authenticated;

GRANT EXECUTE ON FUNCTION enqueue_books_customers() TO service_role;
