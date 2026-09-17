-- Schedule ads-spend-sync every 4 hours (6 runs a day), in its default rolling
-- mode. Each run re-reads the recent window and upserts, so a failed run is
-- simply covered by the next one.
--
-- The historical back-fill is not scheduled: it advances one month per call.
-- Run it by hand until the response reports "done": true:
--
--   curl.exe -X POST -H "x-full-sync: true" ^
--     https://auyfucbskylougsmmrks.supabase.co/functions/v1/ads-spend-sync
--
-- Check credentials first:
--
--   curl.exe -H "x-check-scope: true" ^
--     https://auyfucbskylougsmmrks.supabase.co/functions/v1/ads-spend-sync
--
-- cron.schedule upserts by job name, so re-running this re-points the job.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed - skipping ads-spend-sync schedule';
    RETURN;
  END IF;

  -- Replaces the earlier twice-daily job name, if it was ever created.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ads-spend-sync-12h') THEN
    PERFORM cron.unschedule('ads-spend-sync-12h');
  END IF;

  PERFORM cron.schedule(
    'ads-spend-sync-4h',
    '40 */4 * * *',
    $job$
      SELECT net.http_post(
        url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/ads-spend-sync',
        headers := '{"Content-Type":"application/json","x-sync-source":"cron"}'::jsonb
      );
    $job$
  );
END
$do$;
