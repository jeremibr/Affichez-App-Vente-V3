-- Hide converted leads whose contact Zoho failed to link.
--
-- When Zoho converts a lead it normally writes Converted_Contact back onto the
-- lead, and the view uses that pointer to hide the now-duplicate lead row. But
-- when a rep converts into an *existing* account, Zoho leaves that pointer null —
-- 216 leads are in that state. The contact exists; only the link is missing, so
-- the same person appeared twice in the app.
--
-- Example: lead "Diane Bedard" and contact "Diane Bédard" share
-- dianebedard@conseiltaq.com and company CTAQ. Same person, two rows.
--
-- Email is the fallback key. Names cannot be used: leads store "Goyette, Jessica"
-- where contacts store "Jessica Goyette", and accents differ between the two
-- (Bedard / Bédard).
--
-- Guard: the match counts only when the email belongs to exactly ONE contact.
-- Nine of the 216 share an address with several contacts — a shared info@ inbox —
-- and collapsing those could hide a genuinely different person. Ambiguous rows
-- stay visible; a rare duplicate beats silently dropping someone.
--
-- Effect: 407 leads shown → ~307. Nothing is deleted; this is display only.

-- Supports the per-lead lookup below. Partial: only contacts are ever searched.
CREATE INDEX IF NOT EXISTS zoho_leads_contact_email_idx
  ON zoho_leads (lower(btrim(email)))
  WHERE stage = 'contact';

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
