-- Foundation for storing every quote, not only the won ones.
--
-- Step 2a of three. Schema only: nothing writes these columns yet and no number
-- moves. 20260918180000 was step 1 (the 18 revenue filters made explicit);
-- zoho-sync changes in 2b; the Taux is recomputed in 2c.
--
-- ─── Why the table needs new columns rather than just new enum values ───────
--
-- `sale_date` is built by the sync as
--
--     cf_date_acceptation  ??  accepted_date  ??  date
--
-- Today every row is a won quote, so it is always an acceptance date and means
-- "when the money happened". The moment a `sent` quote is stored, the fallback
-- fires and the same column starts meaning "when the quote was issued" for some
-- rows -- and `week_start`, `week_end`, `month` and `year` are all derived from
-- it. A closing rate over that column would compare "accepted in 2026" with
-- "issued in 2026": two different cohorts, which is the error this project has
-- already fixed twice (Tâches completion_rate, and the quarterly YoY).
--
-- A closing rate is a cohort: OF THE QUOTES ISSUED in a period, how many were
-- won. That needs the issue date as a first-class column, so:
--
--     quote_date     Zoho's `date` -- when the quote was issued. Present on every
--                    estimate regardless of status, verified against the API.
--     accepted_date  the real acceptance date, NULL when never accepted. Stops
--                    "was this accepted" being inferred from a fallback.
--
-- Both are NULL on existing rows. They are populated for 2025 onward by 2b's
-- backfill; older rows keep NULL, so the closing rate is only computed where the
-- data actually supports it rather than quietly assuming.
--
-- ─── The trigger that would have corrupted revenue dating ──────────────────
--
-- preserve_first_sale_date pins sale_date on first insert and never lets it
-- change. That is correct while a row only ever appears once it is already won.
-- It is actively wrong once quotes arrive earlier in their life: a quote stored
-- as `sent` gets sale_date = issue date, and when it is accepted next week the
-- sync's correct value is silently discarded. A quote issued 28 December and won
-- 5 January would be December revenue forever, with nothing on screen to show it.
--
-- The trigger's real purpose is to keep a WON quote's revenue date stable. So it
-- now preserves only when the row was already won. A quote that has not been
-- accepted yet is free to acquire its true sale_date the moment it is.
--
-- ─── Status: raw text plus a mapped enum, never enum alone ─────────────────
--
-- Observed Zoho values are draft, sent, accepted, invoiced, declined, expired.
-- That set cannot be proven closed -- `partially_invoiced` returns nothing today
-- but exists in the API's vocabulary -- and an unknown value hitting an enum
-- column fails the INSERT, which takes the sync down. This project has already
-- lost a day to a silently dead sync; it should not add a way to kill it loudly.
--
-- So the same shape the departments already use, and for the same reason
-- (see CLAUDE.md, "The syncs no longer discard records silently"):
--
--     zoho_status   raw, exactly as Zoho sent it. Never constrained, never fails.
--     status        the mapped enum the app reasons with. NULL when unmapped.
--     get_unmapped_status_summary()   surfaces anything unmapped, the way
--                                     get_unmapped_department_summary does.
--
-- That pattern found $142,918 of unbilled revenue the first time it was used.
--
-- DEFAULT 'accepted' is dropped from status. It was harmless when everything was
-- accepted; with six possible states a row that forgets to set one should be
-- visibly NULL, not silently a sale.


-- ── New statuses ────────────────────────────────────────────────────────────
-- Postgres allows ADD VALUE inside a transaction as long as the value is not
-- used in that same transaction. Nothing below uses them.
ALTER TYPE "public"."sale_status_enum" ADD VALUE IF NOT EXISTS 'sent';
ALTER TYPE "public"."sale_status_enum" ADD VALUE IF NOT EXISTS 'draft';
ALTER TYPE "public"."sale_status_enum" ADD VALUE IF NOT EXISTS 'expired';


-- ── New columns ─────────────────────────────────────────────────────────────
ALTER TABLE "public"."sales" ADD COLUMN IF NOT EXISTS "zoho_status"   "text";
ALTER TABLE "public"."sales" ADD COLUMN IF NOT EXISTS "quote_date"    "date";
ALTER TABLE "public"."sales" ADD COLUMN IF NOT EXISTS "accepted_date" "date";

COMMENT ON COLUMN "public"."sales"."zoho_status" IS
  'Raw status string exactly as Zoho Books sent it. Never constrained, so an '
  'unrecognised value can never fail the sync. `status` is the mapped enum.';
COMMENT ON COLUMN "public"."sales"."quote_date" IS
  'When the quote was ISSUED (Zoho `date`). The cohort date for a closing rate. '
  'NULL on rows synced before 20260918220000.';
COMMENT ON COLUMN "public"."sales"."accepted_date" IS
  'When the quote was ACCEPTED, NULL if it never was. sale_date falls back to the '
  'issue date, so it cannot be used to tell whether a quote was accepted.';

-- Closing rates group by issue date and filter by status.
CREATE INDEX IF NOT EXISTS "sales_quote_date_idx" ON "public"."sales" ("quote_date");
CREATE INDEX IF NOT EXISTS "sales_status_idx"     ON "public"."sales" ("status");

-- Six possible states now; a row that sets none should be visibly NULL rather
-- than silently counted as a sale.
ALTER TABLE "public"."sales" ALTER COLUMN "status" DROP DEFAULT;


-- ── Keep a WON quote's revenue date stable, not any quote's first date ──────

CREATE OR REPLACE FUNCTION "public"."preserve_first_sale_date"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Only a quote that was ALREADY won has a revenue date worth protecting.
  -- Pinning the placeholder date of a quote that has not been accepted yet would
  -- freeze it to its issue date, so accepting it later could never correct it.
  IF OLD.sale_date IS NOT NULL
     AND OLD.status IN ('accepted'::"public"."sale_status_enum",
                        'invoiced'::"public"."sale_status_enum") THEN
    NEW.sale_date := OLD.sale_date;
  END IF;
  RETURN NEW;
END;
$$;


-- ── Surface anything Zoho sends that the mapping does not know ──────────────
-- The status twin of get_unmapped_department_summary. Expected to return zero
-- rows; it returning anything is the point.

CREATE OR REPLACE FUNCTION "public"."get_unmapped_status_summary"()
RETURNS TABLE("zoho_status" "text", "record_count" bigint, "first_seen" "date", "last_seen" "date")
    LANGUAGE "sql"
    STABLE
    SECURITY INVOKER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(s.zoho_status, '(vide)'),
         count(*),
         min(COALESCE(s.quote_date, s.sale_date)),
         max(COALESCE(s.quote_date, s.sale_date))
    FROM sales s
   WHERE s.status IS NULL
   GROUP BY 1
   ORDER BY 2 DESC;
$$;

GRANT EXECUTE ON FUNCTION "public"."get_unmapped_status_summary"() TO "authenticated";
