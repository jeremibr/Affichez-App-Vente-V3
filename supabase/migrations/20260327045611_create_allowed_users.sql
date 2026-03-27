CREATE TABLE IF NOT EXISTS allowed_users (
  email      text PRIMARY KEY,
  name       text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE allowed_users ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read their own row (to verify access)
CREATE POLICY "users can read own row"
  ON allowed_users FOR SELECT
  TO authenticated
  USING (lower(email) = lower(auth.jwt() ->> 'email'));

-- Service role has full access (used by edge function + admin)
CREATE POLICY "service role full access"
  ON allowed_users FOR ALL
  TO service_role
  USING (true);