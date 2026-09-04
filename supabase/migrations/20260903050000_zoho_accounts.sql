-- Zoho CRM Accounts, for the two fields a Contact does not carry itself.
--
-- A Contact in Zoho has no Lead_Source and no service multiselect. Those live on
-- the Lead it converted from — already handled by the inheritance trigger in
-- 20260901120000 — and on the Account it belongs to. The account is the only
-- option for a contact created directly as a client, which is most of them.
--
-- Measured against the live org on 2026-09-03:
--   20,632 accounts in total
--   17,846 (86%) carry Origine_du_client
--    8,369 (41%) carry the service multiselect
--    2,761 (13%) carry neither and contribute nothing
--   21,345 of 21,538 contacts point at an account, so the join lands ~99% of the time
--
-- Deliberately NOT copied onto zoho_leads rows. An account is not a person and
-- holds many contacts; joining at read time keeps one row per account instead of
-- duplicating its attribution across every contact under it, where it would go
-- stale the moment someone edits the account in Zoho.

CREATE TABLE IF NOT EXISTS zoho_accounts (
  zoho_account_id   TEXT PRIMARY KEY,
  account_name      TEXT,

  -- Accounts.Origine_du_client — the "Origine du client" picklist.
  --
  -- It overlaps Leads.Lead_Source but is NOT the same vocabulary: 21 values
  -- against that field's 33, sharing only 13. Eight are account-only
  -- (Accroche-Porte, Cold-call, Internet, Publicité Postale, Référence client,
  -- Référence employé, Site Web d'Affichez, Client Royer & Fils).
  --
  -- Stored with Zoho's own wording. Folding "Référence client" into the Leads
  -- field's "Référence d'un client" would assert that two picklists in two
  -- modules mean the same thing; if that is wrong, two real attributions merge
  -- and nothing on screen shows it. The existing zoho_service_key() folding is
  -- safe because it only collapses case and whitespace within one field.
  origine_du_client TEXT,

  -- Accounts.Int_r_t_pour_quel_service_initialement — same API name AND the same
  -- eight picklist values as the Leads field, compared value-by-value on
  -- 2026-09-03. No translation needed for these to share a column with a lead's
  -- own services.
  service_interest  TEXT[] NOT NULL DEFAULT '{}',

  modified_time     TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The incremental walk sorts on Modified_Time; this backs the local side of it
-- and the staleness check.
CREATE INDEX IF NOT EXISTS zoho_accounts_modified_idx
  ON zoho_accounts(modified_time);

-- Matches zoho_leads and invoices: readable behind the login, written only by the
-- sync under the service-role key, which bypasses RLS entirely.
ALTER TABLE zoho_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "zoho_accounts_select_authenticated" ON zoho_accounts;
CREATE POLICY "zoho_accounts_select_authenticated"
  ON zoho_accounts FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE zoho_accounts IS
  'Zoho CRM Accounts, synced by zoho-account-sync for the two attribution fields '
  'a Contact does not carry: Origine_du_client and the service multiselect. '
  'Joined to zoho_leads.account_id at read time by zoho_leads_unique.';

COMMENT ON COLUMN zoho_accounts.origine_du_client IS
  'Accounts."Origine du client". A different picklist from Leads.Lead_Source - '
  'only 13 values are shared between them. Kept in Zoho''s own wording.';
