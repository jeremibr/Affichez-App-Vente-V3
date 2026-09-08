-- Carry the quote-creator back-fill to completion, then keep it current.
--
-- 7,961 quotes need one Zoho detail call each, because the estimates LIST
-- endpoint carries no creator at all — only the detail endpoint does, and only
-- as an id. At Zoho's 100-calls/minute/organisation ceiling that is roughly 80
-- minutes of API budget, which no single 150s invocation can spend.
--
-- Every 3 minutes, not every 30 like zoho-books-customer-link, and the reason is
-- that this job has a finite end: ~250 quotes a run (two orgs paced separately)
-- clears the queue in about three hours instead of two and a half days. Once
-- `pending` hits zero an idle run costs two calls — it reads the queue, finds
-- nothing, and returns — so leaving the schedule in place is cheaper than
-- remembering to remove it, and it picks up new quotes as zoho-sync creates them.
--
-- The per-minute budget is shared with zoho-sync (every 5 min) and
-- zoho-invoice-sync (every 5 min). The function paces itself at 80 of the 100
-- available per org, which is what leaves room for those two.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Local/shadow databases have no pg_cron; skipping keeps `db reset` working.
    RAISE NOTICE 'pg_cron not installed - skipping zoho-quote-creator-sync schedule';
    RETURN;
  END IF;

  -- cron.schedule upserts by job name, so re-running this re-points the existing
  -- job instead of creating a duplicate.
  PERFORM cron.schedule(
    'zoho-quote-creator-sync-3m',
    '*/3 * * * *',
    $job$
      SELECT net.http_post(
        url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-quote-creator-sync',
        headers := '{"Content-Type":"application/json","x-sync-source":"cron"}'::jsonb
      );
    $job$
  );
END
$do$;
