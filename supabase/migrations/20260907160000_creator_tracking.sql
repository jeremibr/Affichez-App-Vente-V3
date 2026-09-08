-- Who CREATED a quote or an invoice, as opposed to who sold it.
--
-- Asked for on 2026-09-04: Dominic wants to see the quotes Morgane Owczarzak and
-- Guillaume Montambeault typed in, "même si c'est pas les autres représentants" —
-- including the ones where somebody else is the salesperson. Both are Affichez
-- staff who already appear as salespeople in their own right (Guillaume: 671
-- quotes, 795 invoices; Morgane: 233 and 226), so this is a second, overlapping
-- way of slicing the same records, not a new set of people.
--
-- Jérémi's objection in the meeting is the reason this never becomes a column on
-- an existing table: add up "created by" across everyone and the total exceeds
-- the real number of quotes, because one quote can be created by one person and
-- sold by another. It gets its own page and is never mixed into a rep figure.
--
-- Zoho gives the two modules away very differently — verified against the live
-- API on 2026-09-07:
--
--   INVOICES  the list payload already carries `created_by` as a NAME.
--             Free: no extra call, no lookup table. The very first record
--             sampled was created_by "Morgane Owczarzak" with salesperson
--             "Dominic Letendre" — exactly the case Dominic described.
--
--   ESTIMATES the list payload carries no creator at all. The DETAIL payload
--             carries `created_by_id` only — a numeric id, no name. So a quote
--             costs one extra API call, and the id then has to be resolved
--             through the organisation's user list. Hence zoho_books_users and
--             the separate zoho-quote-creator-sync function.

-- ─── Creator columns ──────────────────────────────────────────────────────────

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS created_by_name TEXT,
  ADD COLUMN IF NOT EXISTS created_by_id   TEXT;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS created_by_name TEXT,
  ADD COLUMN IF NOT EXISTS created_by_id   TEXT,
  -- 'pending' until the detail call has been made, then 'linked', or 'error'
  -- with the reason. Without it the back-fill cannot tell a quote it has never
  -- looked at from one Zoho genuinely has no creator for, and would retry the
  -- second group forever at one API call each.
  ADD COLUMN IF NOT EXISTS creator_link_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS creator_link_error  TEXT;

COMMENT ON COLUMN invoices.created_by_name IS
  'Zoho Books invoice.created_by - who keyed the invoice in, which is often NOT '
  'rep_name (the salesperson). Free: present on the list endpoint.';

COMMENT ON COLUMN sales.created_by_id IS
  'Zoho Books estimate.created_by_id, available only on the DETAIL endpoint, so '
  'it costs one API call per quote. Filled by zoho-quote-creator-sync and '
  'resolved to a name through zoho_books_users.';

-- ─── Books users, so an estimate's created_by_id can become a name ────────────

CREATE TABLE IF NOT EXISTS zoho_books_users (
  user_id    TEXT PRIMARY KEY,
  office     TEXT NOT NULL,
  -- Zoho's own display name. Frequently just a first name in the QC org
  -- ("Alexandre" appears three times with three different addresses), which is
  -- why email is the field the rep mapping keys on.
  name       TEXT,
  email      TEXT,
  status     TEXT,
  -- Resolved through allowed_users.email, exactly as the CRM syncs do, so the
  -- same person carries the same name on every page. Falls back to `name`.
  rep_name   TEXT,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS zoho_books_users_email_idx ON zoho_books_users(lower(email));

ALTER TABLE zoho_books_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "zoho_books_users_select_authenticated" ON zoho_books_users;
CREATE POLICY "zoho_books_users_select_authenticated"
  ON zoho_books_users FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE zoho_books_users IS
  'Zoho Books org users, cached so an estimate''s created_by_id can be turned '
  'into a name. 133 users in QC, 17 in MTL as of 2026-09-07. Refreshed by '
  'zoho-quote-creator-sync at the start of each run.';

-- ─── Stop the syncs silently dropping records ─────────────────────────────────
--
-- Both syncs currently do `if (!dept) continue` — an invoice or quote whose
-- department Zoho reports under a name the mapping does not know is thrown away
-- with no error, no log and no trace. Nothing is lost today, because DEPT_MAP
-- covers all six labels in live use. The day somebody adds a seventh department
-- in Zoho, that money disappears from the app and nobody finds out.
--
-- invoices.department is already nullable TEXT, so it needs nothing. sales
-- .department is a NOT NULL enum, and adding a 'NON ASSIGNE' member would put a
-- fake department in every filter dropdown in the app. Dropping NOT NULL is the
-- smaller change: the row lands, keeps Zoho's raw label in
-- zoho_department_label, and shows up in get_unmapped_department_summary so
-- somebody can fix the mapping.
ALTER TABLE sales ALTER COLUMN department DROP NOT NULL;
ALTER TABLE sales ALTER COLUMN zoho_department_label DROP NOT NULL;

-- ─── Indexes ──────────────────────────────────────────────────────────────────
-- The creator page groups and filters on these; the partial indexes back the
-- back-fill's "what is left to do" query, which runs on every invocation.

CREATE INDEX IF NOT EXISTS invoices_created_by_idx ON invoices(created_by_name)
  WHERE created_by_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_created_by_idx ON sales(created_by_name)
  WHERE created_by_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_creator_pending_idx ON sales(creator_link_status)
  WHERE creator_link_status = 'pending';
CREATE INDEX IF NOT EXISTS sales_dept_unmapped_idx ON sales(zoho_department_label)
  WHERE department IS NULL;
CREATE INDEX IF NOT EXISTS invoices_dept_unmapped_idx ON invoices(zoho_department_label)
  WHERE department IS NULL;
