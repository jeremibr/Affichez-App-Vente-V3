-- Extend allowed_users with role, factures access, and rep name
ALTER TABLE allowed_users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member')),
  ADD COLUMN IF NOT EXISTS can_access_factures boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rep_name text;
