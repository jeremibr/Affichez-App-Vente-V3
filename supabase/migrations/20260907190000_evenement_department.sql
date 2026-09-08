-- ÉVÈNEMENT: a seventh department that has existed in Zoho Books since May 2025
-- and has never once reached this application.
--
-- Found on 2026-09-07, the moment the syncs stopped silently discarding records
-- whose department they did not recognise. Zoho Books has been billing under
-- "ÉVÈNEMENT" since 2025-05-29 — 160 invoices, $142,918 — and every one of them
-- was thrown away by `if (!dept) continue` in zoho-invoice-sync, with no error,
-- no log and nothing on screen.
--
-- It is a real Affichez business line, not a typo: "Événement" is already one of
-- the eight values in the CRM's service picklist. Only the Books department
-- mapping never learned about it.
--
-- This is half of what Dominic reported in the 2026-09-04 meeting. The other
-- half is that 92 CREDIT NOTES worth -$117,764 across 2025-2026 were being
-- dropped the same way, because a credit note with no inline department and no
-- resolvable reference_number failed the same check. His diagnosis — "on
-- n'inclut pas les crédits, les avoirs" — was correct.
--
-- Naming: EVENEMENT without accents, because that is the convention the existing
-- values follow. Zoho says "NUMÉRIQUE" and this app stores "NUMERIQUE"; Zoho
-- says "ÉVÈNEMENT" and this app stores "EVENEMENT". The syncs map every spelling
-- Zoho uses onto the one canonical value.

-- ALTER TYPE ... ADD VALUE is transactional on PG12+, but the new value cannot
-- be USED in the same transaction that adds it. Nothing here writes it — the
-- syncs do, on their next run — so this is safe as a single migration.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'department_enum' AND e.enumlabel = 'EVENEMENT'
  ) THEN
    ALTER TYPE department_enum ADD VALUE 'EVENEMENT';
  END IF;
END
$do$;

-- Re-classify the invoices already sitting unassigned. invoices.department is
-- plain TEXT, so this needs no enum and can run immediately; the 160 rows landed
-- with a NULL department and Zoho's own label preserved beside them, which is
-- exactly what makes this back-fill possible without going back to the API.
--
-- Deliberately narrow: only rows whose stored Zoho label is a spelling of
-- "évènement". The 3,739 rows from 2021-2022 with a genuinely empty label are
-- not touched — Zoho has no department for those, and inventing one would be
-- worse than leaving them honestly unassigned.
UPDATE invoices
   SET department = 'EVENEMENT'
 WHERE department IS NULL
   AND upper(translate(COALESCE(zoho_department_label, ''), 'ÉÈÊËéèêë', 'EEEEeeee')) = 'EVENEMENT';

COMMENT ON TYPE department_enum IS
  'Affichez billing departments. EVENEMENT was added 2026-09-07 after the sync '
  'stopped discarding unrecognised departments and revealed 160 invoices Zoho '
  'had been billing under "ÉVÈNEMENT" since May 2025. Objectives are set per '
  'department: objectives_factures has no rows for EVENEMENT yet, so it will '
  'show actuals against a zero target until somebody sets them.';
