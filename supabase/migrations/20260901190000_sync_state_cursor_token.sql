-- Lets a paginated walk resume mid-query across invocations.
--
-- The full lead/contact sync cannot finish inside one 150s request, so it runs in
-- slices. The first attempt resumed using Modified_Time as the cursor, which has a
-- flaw: when a whole page of records shares one timestamp the cursor cannot
-- advance, so it steps forward a second to avoid looping — and silently skips any
-- record modified inside that second. Those records then look unseen to the orphan
-- pass and get deleted despite still existing in Zoho. That cost 39 contacts.
--
-- Zoho's own page_token has no such ambiguity, so the walk now persists the token
-- and resumes the same query rather than re-deriving a position from timestamps.

ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS cursor_token TEXT;

COMMENT ON COLUMN sync_state.cursor_token IS
  'Zoho page_token for an in-progress paginated walk. NULL when no walk is mid-flight. '
  'Bound to the exact query that produced it — a changed filter invalidates it.';
