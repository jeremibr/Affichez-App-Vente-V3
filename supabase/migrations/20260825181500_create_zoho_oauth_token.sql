-- Shared cache for Zoho OAuth access tokens.
--
-- Every sync function used to call the OAuth refresh endpoint on each run:
-- 12/h (zoho-sync) + 12/h (zoho-invoice-sync) + 3/h (zoho-task-sync) = 27
-- refreshes per hour against a single refresh token. Zoho throttles that
-- endpoint per refresh token and started returning
--   "You have made too many requests continuously"
-- which surfaced as 500s in webhook_log, and left no headroom for a manual
-- sync from Réglages or an ad-hoc research call.
--
-- Access tokens are valid one hour, so one cached row per credential set
-- serves every function and every invocation: ~1 refresh/hour instead of 27.
--
-- Keyed like sync_state: 'books' (zoho-sync, zoho-invoice-sync) and 'crm'
-- (zoho-task-sync, which prefers the ZOHO_CRM_* secrets). The two are kept
-- apart because they may be different refresh tokens with different scopes.
CREATE TABLE IF NOT EXISTS zoho_oauth_token (
  key          text PRIMARY KEY,
  access_token text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The edge functions talk to PostgREST with the service role, which bypasses
-- RLS. Enabling RLS with no policy therefore changes nothing for them while
-- making the token unreadable through the anon/authenticated API — the anon
-- key is shipped in the frontend bundle and must never be able to read it.
ALTER TABLE zoho_oauth_token ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON zoho_oauth_token FROM anon, authenticated;
