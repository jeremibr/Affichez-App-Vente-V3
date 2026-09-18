-- The Taux finally has a denominator.
--
-- Step 2c of three, and the point of the other two. `sales` now holds every quote
-- rather than only the won ones (20260918220000 + the zoho-sync backfill), so a
-- closing rate can be computed instead of approximated.
--
-- What was wrong: win_rate divided by `quotes_created`, which was every row in
-- `sales` — and every row in `sales` was a quote that had already been won. The
-- page read 92% because it was dividing winners by winners. Measured against
-- Zoho, the real figure for quotes issued in 2026 is 48%.
--
-- Three changes, and the third is the one that makes the other two honest.
--
-- 1. A DENOMINATOR THAT MEANS SOMETHING. `quotes_sent` counts the quotes that
--    actually reached a client — sent, accepted, invoiced, declined, expired.
--    Drafts are deliberately out, decided with Jérémi 2026-09-18: a draft was
--    never shown to anybody, so counting it as a lost opportunity punishes a rep
--    for work in progress. They are still stored and still counted in
--    `quotes_created`, which is what that column claims to be.
--
-- 2. THE COHORT DATE. The filter moves from sale_date to quote_date. sale_date is
--    when a quote was ACCEPTED (falling back to its issue date when it never was),
--    so filtering a rate by it compares "accepted in 2026" against "issued in
--    2026" — two different populations, the same error already fixed twice in this
--    project. A closing rate is a cohort: of the quotes ISSUED in a period, how
--    many were won. COALESCE keeps the four rows Zoho has since deleted, which
--    have no quote_date, from silently vanishing.
--
-- 3. `quotes_won` STAYS 'invoiced'. Not an oversight. 20260907170000 records the
--    reason — "an accepted quote that never turned into an invoice has not made
--    anybody any money yet, and Dominic asked for combien de devis gagnés" — and
--    the page displays that same number in the Devis gagnés column. A rate whose
--    numerator disagrees with the column printed next to it is how pages stop
--    adding up, so the rate uses what the page shows. It reads a little lower than
--    a rate counting accepted quotes as won, and it is consistent.
--
-- One caveat worth knowing while reading the page: it can only show quotes whose
-- creator has been resolved, and zoho-quote-creator-sync resolves them one Zoho
-- call at a time. Until it finishes, the newly-stored non-won quotes are missing
-- from the denominator and the Taux reads higher than the truth. It corrects
-- itself as the back-fill lands; get_quote_creator_link_status() reports progress.

-- The return type gains quotes_sent, and Postgres will not change a function's
-- return type in place.
DROP FUNCTION IF EXISTS public.get_creator_summary(integer, integer, text);

CREATE OR REPLACE FUNCTION public.get_creator_summary(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_office text DEFAULT NULL::text)
 RETURNS TABLE(creator text, quotes_created bigint, quotes_sent bigint, quotes_won bigint, quotes_amount numeric, quotes_won_amount numeric, invoices_created bigint, invoices_amount numeric, win_rate numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH q AS (
    SELECT COALESCE(s.created_by_name, 'Inconnu') AS creator,
           count(*) AS created,
           -- Reached a client. Drafts excluded: never shown to anybody, so not a
           -- lost opportunity. This is the rate's denominator.
           count(*) FILTER (
             WHERE s.status IN ('sent','accepted','invoiced','declined','expired')
           ) AS sent,
           count(*) FILTER (WHERE s.status = 'invoiced') AS won,
           COALESCE(sum(s.amount), 0) AS amt,
           COALESCE(sum(s.amount) FILTER (WHERE s.status = 'invoiced'), 0) AS won_amt
      FROM sales s
     WHERE s.created_by_name IS NOT NULL
       -- Cohort date: when the quote was ISSUED, not when it was accepted.
       AND (p_year   IS NULL OR EXTRACT(YEAR  FROM COALESCE(s.quote_date, s.sale_date))::INT = p_year)
       AND (p_month  IS NULL OR EXTRACT(MONTH FROM COALESCE(s.quote_date, s.sale_date))::INT = p_month)
       AND (p_office IS NULL OR s.office::TEXT = p_office)
     GROUP BY 1
  ),
  i AS (
    SELECT COALESCE(v.created_by_name, 'Inconnu') AS creator,
           -- Credit notes are not something anybody "created" in the sense meant
           -- here, and counting them would make a busy month look busier.
           count(*) FILTER (WHERE NOT v.is_avoir) AS created,
           COALESCE(sum(v.amount), 0) AS amt
      FROM invoices v
     WHERE v.created_by_name IS NOT NULL
       AND (p_year   IS NULL OR EXTRACT(YEAR  FROM v.invoice_date)::INT = p_year)
       AND (p_month  IS NULL OR EXTRACT(MONTH FROM v.invoice_date)::INT = p_month)
       AND (p_office IS NULL OR v.office::TEXT = p_office)
     GROUP BY 1
  )
  SELECT
    COALESCE(q.creator, i.creator),
    COALESCE(q.created, 0),
    COALESCE(q.sent, 0),
    COALESCE(q.won, 0),
    COALESCE(q.amt, 0),
    COALESCE(q.won_amt, 0),
    COALESCE(i.created, 0),
    COALESCE(i.amt, 0),
    -- Won over quotes that reached a client. Nothing sent means no rate to show,
    -- not a rate of zero — a creator with only drafts has not lost anything.
    CASE WHEN COALESCE(q.sent, 0) = 0 THEN NULL
         ELSE ROUND(COALESCE(q.won, 0) * 100.0 / q.sent, 1) END
  FROM q FULL OUTER JOIN i ON i.creator = q.creator
  ORDER BY COALESCE(q.created, 0) + COALESCE(i.created, 0) DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_creator_summary(INT, INT, TEXT) TO authenticated;
