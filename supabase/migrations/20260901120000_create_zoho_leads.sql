-- Zoho CRM Leads + Contacts → a single `zoho_leads` table.
--
-- One row per Zoho record, keyed by the Zoho record id. `stage` says which module
-- it came from. Leads and Contacts share an id space in Zoho, so a single primary
-- key is safe.
--
-- Written only by the zoho-lead-sync edge function (service role). The legacy
-- hand-entered `leads` table is left untouched as an archive.

CREATE TABLE IF NOT EXISTS zoho_leads (
  zoho_record_id       TEXT PRIMARY KEY,
  stage                TEXT NOT NULL CHECK (stage IN ('lead', 'contact')),

  full_name            TEXT,
  first_name           TEXT,
  last_name            TEXT,
  -- Leads.Company (text) | Contacts.Account_Name (lookup → .name)
  company              TEXT,
  phone                TEXT,
  email                TEXT,

  owner_name           TEXT,
  owner_email          TEXT,
  -- allowed_users.rep_name when the owner email matches, else owner_name.
  -- Keeps this table joinable to the rest of the app, same as zoho_tasks.
  rep_name             TEXT,

  created_time         TIMESTAMPTZ,
  modified_time        TIMESTAMPTZ,

  -- The "Qualification" section fields. Both exist on Leads only; on Contacts they
  -- are inherited from the originating lead by the trigger below.
  lead_source          TEXT,
  service_interest     TEXT[] NOT NULL DEFAULT '{}',
  lead_status          TEXT,
  -- TRUE when lead_source/service_interest came from the lead, not the record itself.
  attribution_inherited BOOLEAN NOT NULL DEFAULT FALSE,

  is_converted         BOOLEAN NOT NULL DEFAULT FALSE,
  converted_contact_id TEXT,
  converted_account_id TEXT,
  converted_deal_id    TEXT,
  converted_time       TIMESTAMPTZ,

  zoho_crm_url         TEXT,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS zoho_leads_stage_idx      ON zoho_leads(stage);
CREATE INDEX IF NOT EXISTS zoho_leads_created_idx    ON zoho_leads(created_time DESC);
CREATE INDEX IF NOT EXISTS zoho_leads_modified_idx   ON zoho_leads(modified_time DESC);
CREATE INDEX IF NOT EXISTS zoho_leads_source_idx     ON zoho_leads(lead_source);
CREATE INDEX IF NOT EXISTS zoho_leads_rep_idx        ON zoho_leads(rep_name);
CREATE INDEX IF NOT EXISTS zoho_leads_email_idx      ON zoho_leads(lower(email));
CREATE INDEX IF NOT EXISTS zoho_leads_conv_contact_idx ON zoho_leads(converted_contact_id)
  WHERE converted_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS zoho_leads_service_idx    ON zoho_leads USING GIN (service_interest);

ALTER TABLE zoho_leads ENABLE ROW LEVEL SECURITY;

-- Read-only to the app. All writes go through the edge function's service-role key,
-- which bypasses RLS — so no INSERT/UPDATE/DELETE policy is granted on purpose.
DROP POLICY IF EXISTS "zoho_leads_select_authenticated" ON zoho_leads;
CREATE POLICY "zoho_leads_select_authenticated"
  ON zoho_leads FOR SELECT TO authenticated USING (true);


-- ─── Attribution inheritance ──────────────────────────────────────────────────
-- Zoho's Contacts module has no Lead_Source and no
-- Int_r_t_pour_quel_service_initialement field, so a converted contact loses the
-- campaign attribution its lead carried. The lead keeps a Converted_Contact
-- pointer, so we copy it across.
--
-- Webhook events arrive in arbitrary order (the contact may land before or after
-- the lead), so this runs on every write and handles both directions.

CREATE OR REPLACE FUNCTION zoho_leads_inherit_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_source   TEXT;
  v_services TEXT[];
BEGIN
  IF NEW.stage = 'lead' AND NEW.converted_contact_id IS NOT NULL THEN
    -- A lead landed: push its attribution down onto the contact it became.
    -- This re-fires the trigger on that contact row, but only one level deep —
    -- the row then has a non-null lead_source, so the ELSIF below can't match.
    UPDATE zoho_leads c
       SET lead_source           = COALESCE(c.lead_source, NEW.lead_source),
           service_interest      = CASE WHEN cardinality(c.service_interest) = 0
                                        THEN NEW.service_interest
                                        ELSE c.service_interest END,
           attribution_inherited = TRUE
     WHERE c.zoho_record_id = NEW.converted_contact_id
       AND c.stage = 'contact'
       AND NEW.lead_source IS NOT NULL
       AND (c.lead_source IS NULL OR cardinality(c.service_interest) = 0);

  ELSIF NEW.stage = 'contact' AND NEW.lead_source IS NULL THEN
    -- A contact landed first: pull attribution from the lead that points at it.
    -- Assigned via locals, not SELECT INTO NEW.*, because a miss would set every
    -- target to NULL and blow up the NOT NULL on attribution_inherited.
    SELECT l.lead_source, l.service_interest
      INTO v_source, v_services
      FROM zoho_leads l
     WHERE l.converted_contact_id = NEW.zoho_record_id
       AND l.stage = 'lead'
     ORDER BY l.converted_time DESC NULLS LAST
     LIMIT 1;

    IF v_source IS NOT NULL THEN
      NEW.lead_source           := v_source;
      NEW.service_interest      := COALESCE(v_services, '{}');
      NEW.attribution_inherited := TRUE;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zoho_leads_inherit_attribution_trg ON zoho_leads;
CREATE TRIGGER zoho_leads_inherit_attribution_trg
  BEFORE INSERT OR UPDATE ON zoho_leads
  FOR EACH ROW EXECUTE FUNCTION zoho_leads_inherit_attribution();


-- ─── Deduplicated view ────────────────────────────────────────────────────────
-- A converted lead and the contact it became are the same person. This view drops
-- the lead row whenever its contact is also synced, so counts aren't doubled.

-- security_invoker is required: without it the view runs as its owner and would
-- serve rows straight past the RLS policy on zoho_leads, including to anon.
CREATE OR REPLACE VIEW zoho_leads_unique
WITH (security_invoker = true) AS
SELECT l.*
  FROM zoho_leads l
 WHERE l.stage = 'contact'
    OR l.converted_contact_id IS NULL
    OR NOT EXISTS (
         SELECT 1 FROM zoho_leads c
          WHERE c.zoho_record_id = l.converted_contact_id
            AND c.stage = 'contact'
       );
