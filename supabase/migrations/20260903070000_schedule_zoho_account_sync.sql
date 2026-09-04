-- Keep zoho_accounts current.
--
-- Twelve-hourly, matching zoho-lead-sync: an account's "Origine du client" and
-- initial-service fields are set once when the client is opened and then almost
-- never touched, so this is a reconcile against slow drift rather than a feed.
-- The live path for a *new* client is the invoice sync plus the books-customer
-- link, which already puts them on the Leads page within the half hour.
--
-- Incremental only. cron.schedule fires net.http_post exactly once, so a sliced
-- full sync would complete one slice per run, never finish a pass, and leave the
-- cursor permanently half-open — the same trap documented on the lead sync. Run
-- the initial full load by hand, calling it until the reply says "done": true:
--
--   curl.exe -X POST -H "x-full-sync: true" \
--     https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-account-sync
--
-- FIRST, though, confirm the CRM refresh token can actually read the module. It
-- was issued for leads + contacts + users; Accounts needs
-- ZohoCRM.modules.accounts.READ on top, and without it every page 401s and the
-- walk quietly upserts nothing:
--
--   curl.exe -H "x-check-scope: true" \
--     https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-account-sync
--
-- cron.schedule upserts by job name, so re-running this migration re-points the
-- existing job rather than creating a duplicate.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Local/shadow databases have no pg_cron; skipping keeps `db reset` working.
    RAISE NOTICE 'pg_cron not installed - skipping zoho-account-sync schedule';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'zoho-account-sync-12h',
    '30 */12 * * *',  -- 00:30 and 12:30 UTC, half an hour off the lead sync so the
                      -- two are not refreshing the shared CRM token at once
    $job$
      SELECT net.http_post(
        url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-account-sync',
        headers := '{"Content-Type":"application/json","x-sync-source":"cron"}'::jsonb
      );
    $job$
  );
END
$do$;
