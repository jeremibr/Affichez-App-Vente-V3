-- Keep the Books-customer → CRM-account bridge current.
--
-- zoho-invoice-sync runs every 5 minutes and writes books_customer_id straight
-- from Zoho, but a customer invoiced for the first time has no CRM account id
-- yet, so its invoices show against no lead until this job resolves it.
--
-- Idle runs are nearly free: with an empty queue the function reads the queue,
-- finds nothing and returns without calling Zoho at all. It only spends API quota
-- when there is genuinely a new customer to look up, and even then it is capped
-- per run — Zoho Books allows 100 calls/minute/org and 1,000-10,000/day by plan.
--
-- Half-hourly is a deliberate compromise: fast enough that a new client's
-- invoices appear on their lead the same morning, slow enough to leave the
-- per-minute budget to zoho-invoice-sync, which shares the same quota.
--
-- This job also carries the initial back-fill to completion on its own. Each run
-- takes another slice of the ~3,100 queued customers, so the table fills in over
-- the following hours whether or not anyone drives it by hand.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Local/shadow databases have no pg_cron; skipping keeps `db reset` working.
    RAISE NOTICE 'pg_cron not installed - skipping zoho-books-customer-link schedule';
    RETURN;
  END IF;

  -- cron.schedule upserts by job name, so re-running this re-points the existing
  -- job instead of creating a duplicate.
  PERFORM cron.schedule(
    'zoho-books-customer-link-30m',
    '*/30 * * * *',
    $job$
      SELECT net.http_post(
        url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-books-customer-link',
        headers := '{"Content-Type":"application/json","x-sync-source":"cron"}'::jsonb
      );
    $job$
  );
END
$do$;
