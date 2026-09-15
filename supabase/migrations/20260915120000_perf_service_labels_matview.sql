-- zoho_service_labels: a 15-row lookup that was costing 354 ms a call.
--
-- It is a view, and every read of it scanned three whole tables —
-- zoho_leads (29,468 rows) and zoho_accounts (20,737) unnested over their
-- service arrays, plus invoices (18,309) — sorted the 30,208 rows that came
-- out, and grouped them down to **fifteen**. Measured on the live database:
--
--   Hash (rows=15)  354 ms
--     -> GroupAggregate  Sort (rows=30208)
--          -> Seq Scan zoho_leads    (29468)
--          -> Seq Scan zoho_accounts (20737)
--          -> Seq Scan invoices      (18309)
--
-- Four functions join it — get_zoho_accounts_by_service,
-- get_zoho_account_filter_options, get_zoho_leads_by_service,
-- get_zoho_lead_filter_options — and the Comptes dashboard calls two of them
-- on every load, so the same three table scans happened twice per page.
--
-- It is now a materialized view. The content is identical; the cost is a
-- 15-row read.
--
-- **Staleness is the trade.** A service Zoho has never billed or quoted before
-- shows its raw spelling instead of the canonical label until the next refresh,
-- and the Service filter will not offer it. That is acceptable here: this is a
-- Zoho picklist, the account and lead syncs only run every 12 hours anyway, and
-- the refresh below runs every 10 minutes regardless.

DROP VIEW IF EXISTS public.zoho_service_labels;

CREATE MATERIALIZED VIEW public.zoho_service_labels AS
WITH raw AS (
    SELECT btrim(s.s) AS v, true AS from_leads
      FROM public.zoho_leads z, LATERAL unnest(z.service_interest) s(s)
    UNION ALL
    SELECT btrim(s.s), false
      FROM public.zoho_accounts a, LATERAL unnest(a.service_interest) s(s)
    UNION ALL
    SELECT btrim(i.department), false
      FROM public.invoices i WHERE i.department IS NOT NULL
), keyed AS (
    SELECT public.zoho_service_key(r.v) AS key, r.v, r.from_leads
      FROM raw r WHERE r.v <> ''
)
SELECT key,
       COALESCE(mode() WITHIN GROUP (ORDER BY v) FILTER (WHERE from_leads),
                mode() WITHIN GROUP (ORDER BY v)) AS label,
       array_agg(DISTINCT v ORDER BY v) AS variants
  FROM keyed
 GROUP BY key;

-- REFRESH ... CONCURRENTLY requires a unique index, and concurrently is the
-- point: a plain refresh takes an ACCESS EXCLUSIVE lock, which would stall
-- every dashboard reading the table for the half-second the rebuild takes.
CREATE UNIQUE INDEX zoho_service_labels_key_idx ON public.zoho_service_labels (key);

GRANT SELECT ON public.zoho_service_labels TO anon, authenticated, service_role;


-- Refreshing
-- ----------
-- SECURITY DEFINER because REFRESH requires ownership of the view, which the
-- authenticated role does not have and should not be given.

CREATE OR REPLACE FUNCTION public.refresh_zoho_service_labels()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.zoho_service_labels;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_zoho_service_labels() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_zoho_service_labels() TO service_role;

SELECT cron.schedule(
  'refresh-zoho-service-labels-10m',
  '*/10 * * * *',
  $$SELECT public.refresh_zoho_service_labels()$$
);
