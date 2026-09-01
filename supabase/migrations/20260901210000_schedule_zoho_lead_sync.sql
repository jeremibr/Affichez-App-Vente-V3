-- Twice-daily incremental sync of Zoho Leads + Contacts.
--
-- The webhooks (4 Zoho workflow rules) handle the normal path within seconds.
-- This is the repair pass, because webhooks are fire-and-forget with no replay:
-- Zoho retries a failed call five times, gives up, and that record then stays
-- stale forever with no error anywhere. It also covers bulk imports and mass
-- updates, during which Zoho skips workflow rules entirely — import 500 contacts
-- and not one of them would sync.
--
-- Note there is no x-full-sync header: this is the *incremental* sync, which asks
-- Zoho what changed since its stored cursor and finishes in about 7 seconds. A
-- full sync must NOT be scheduled — it needs several invocations to finish and
-- cron.schedule fires net.http_post exactly once, so it would complete one slice
-- per run, never finish a pass, and leave the sync state permanently half-open.
-- Run a full sync by hand instead, calling it until the reply says "done": true.
--
-- cron.schedule upserts by job name, so re-running this migration re-points the
-- existing job rather than creating a duplicate.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Local/shadow databases have no pg_cron. Skipping keeps `db reset` working;
    -- the hosted project, where the other sync jobs already run, does have it.
    RAISE NOTICE 'pg_cron not installed - skipping zoho-lead-sync schedule';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'zoho-lead-sync-12h',
    '0 */12 * * *',   -- 00:00 and 12:00 UTC = 08:00 / 20:00 America/Toronto
    $job$
      SELECT net.http_post(
        url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-lead-sync',
        headers := '{"Content-Type":"application/json","x-sync-source":"cron"}'::jsonb
      );
    $job$
  );
END
$do$;
