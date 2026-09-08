-- Read layer for the "Créé par" page and the unmapped-department alert.

-- ─── Who created what ─────────────────────────────────────────────────────────
--
-- One row per person, counting the quotes and invoices they KEYED IN, whoever
-- the salesperson was.
--
-- These numbers deliberately do NOT reconcile with the rep figures anywhere else
-- in the app, and that is not a bug. A quote created by Morgane and sold by
-- Dominic is counted once here under Morgane and once on the Factures dashboard
-- under Dominic. Summing this page's rows gives the true total number of quotes;
-- summing it *together with* a rep leaderboard double-counts. Jérémi raised
-- exactly this in the meeting — "faut pas que ça fausse les chiffres" — and the
-- answer agreed was a separate page, which is what this backs.
--
-- `quotes_won` uses status 'invoiced': an accepted quote that never turned into
-- an invoice has not made anybody any money yet, and Dominic asked for "combien
-- de devis gagnés".

CREATE OR REPLACE FUNCTION get_creator_summary(
  p_year   INT  DEFAULT NULL,
  p_month  INT  DEFAULT NULL,
  p_office TEXT DEFAULT NULL
)
RETURNS TABLE (
  creator          TEXT,
  quotes_created   BIGINT,
  quotes_won       BIGINT,
  quotes_amount    NUMERIC,
  quotes_won_amount NUMERIC,
  invoices_created BIGINT,
  invoices_amount  NUMERIC,
  win_rate         NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH q AS (
    SELECT COALESCE(s.created_by_name, 'Inconnu') AS creator,
           count(*) AS created,
           count(*) FILTER (WHERE s.status = 'invoiced') AS won,
           COALESCE(sum(s.amount), 0) AS amt,
           COALESCE(sum(s.amount) FILTER (WHERE s.status = 'invoiced'), 0) AS won_amt
      FROM sales s
     WHERE s.created_by_name IS NOT NULL
       AND (p_year   IS NULL OR EXTRACT(YEAR  FROM s.sale_date)::INT = p_year)
       AND (p_month  IS NULL OR EXTRACT(MONTH FROM s.sale_date)::INT = p_month)
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
    COALESCE(q.won, 0),
    COALESCE(q.amt, 0),
    COALESCE(q.won_amt, 0),
    COALESCE(i.created, 0),
    COALESCE(i.amt, 0),
    CASE WHEN COALESCE(q.created, 0) = 0 THEN 0
         ELSE ROUND(COALESCE(q.won, 0) * 100.0 / q.created, 1) END
  FROM q FULL OUTER JOIN i ON i.creator = q.creator
  ORDER BY COALESCE(q.created, 0) + COALESCE(i.created, 0) DESC;
$$;

GRANT EXECUTE ON FUNCTION get_creator_summary(INT, INT, TEXT) TO authenticated;

-- ─── Line items for one creator ───────────────────────────────────────────────
-- Quotes and invoices in one list, because the question being asked ("what did
-- Morgane put through in March") does not care which module a row came from.
-- `module` says which, and `sold_by` is the column that makes the point: it is
-- routinely somebody other than the creator.

CREATE OR REPLACE FUNCTION get_creator_detail(
  p_creator TEXT,
  p_year    INT  DEFAULT NULL,
  p_month   INT  DEFAULT NULL,
  p_office  TEXT DEFAULT NULL,
  p_module  TEXT DEFAULT NULL   -- 'devis' | 'factures' | NULL for both
)
RETURNS TABLE (
  module       TEXT,
  doc_number   TEXT,
  doc_date     DATE,
  client_name  TEXT,
  department   TEXT,
  office       TEXT,
  sold_by      TEXT,
  status       TEXT,
  amount       NUMERIC,
  is_avoir     BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT 'devis', s.quote_number, s.sale_date, s.client_name,
         COALESCE(s.department::TEXT, 'Non assigné'), s.office::TEXT,
         s.rep_name, s.status::TEXT, s.amount, FALSE
    FROM sales s
   WHERE s.created_by_name = p_creator
     AND (p_module IS NULL OR p_module = 'devis')
     AND (p_year   IS NULL OR EXTRACT(YEAR  FROM s.sale_date)::INT = p_year)
     AND (p_month  IS NULL OR EXTRACT(MONTH FROM s.sale_date)::INT = p_month)
     AND (p_office IS NULL OR s.office::TEXT = p_office)
  UNION ALL
  SELECT 'factures', v.invoice_number, v.invoice_date, v.client_name,
         COALESCE(v.department, 'Non assigné'), v.office::TEXT,
         v.rep_name, v.status::TEXT, v.amount, v.is_avoir
    FROM invoices v
   WHERE v.created_by_name = p_creator
     AND (p_module IS NULL OR p_module = 'factures')
     AND (p_year   IS NULL OR EXTRACT(YEAR  FROM v.invoice_date)::INT = p_year)
     AND (p_month  IS NULL OR EXTRACT(MONTH FROM v.invoice_date)::INT = p_month)
     AND (p_office IS NULL OR v.office::TEXT = p_office)
  ORDER BY 3 DESC NULLS LAST, 2 DESC;
$$;

GRANT EXECUTE ON FUNCTION get_creator_detail(TEXT, INT, INT, TEXT, TEXT) TO authenticated;

-- ─── Back-fill progress ───────────────────────────────────────────────────────
-- Invoices need no back-fill at all (the name is on the list payload), so this
-- reports quotes only. Read by the Settings sync panel; `pending` reaching zero
-- is how you know zoho-quote-creator-sync is done.

CREATE OR REPLACE FUNCTION get_quote_creator_link_status()
RETURNS TABLE (
  quotes_total    INTEGER,
  quotes_linked   INTEGER,
  quotes_pending  INTEGER,
  quotes_error    INTEGER,
  invoices_total  INTEGER,
  invoices_linked INTEGER,
  distinct_creators INTEGER
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (SELECT count(*)::INT FROM sales),
    (SELECT count(*)::INT FROM sales WHERE creator_link_status = 'linked'),
    (SELECT count(*)::INT FROM sales WHERE creator_link_status = 'pending'),
    (SELECT count(*)::INT FROM sales WHERE creator_link_status = 'error'),
    (SELECT count(*)::INT FROM invoices),
    (SELECT count(*)::INT FROM invoices WHERE created_by_name IS NOT NULL),
    (SELECT count(DISTINCT c)::INT FROM (
       SELECT created_by_name c FROM sales    WHERE created_by_name IS NOT NULL
       UNION
       SELECT created_by_name   FROM invoices WHERE created_by_name IS NOT NULL
     ) u);
$$;

GRANT EXECUTE ON FUNCTION get_quote_creator_link_status() TO authenticated;

-- ─── Unmapped departments ─────────────────────────────────────────────────────
--
-- The alert half of the change that stopped the syncs throwing records away.
-- A row here means Zoho sent a department name DEPT_MAP does not know: the money
-- is now safely in the database, but it is missing from every per-department
-- figure until somebody adds the label to the mapping in
-- zoho-invoice-sync/index.ts and zoho-sync/index.ts.
--
-- Expected to return zero rows. It returning anything is the point.

CREATE OR REPLACE FUNCTION get_unmapped_department_summary()
RETURNS TABLE (
  module        TEXT,
  zoho_label    TEXT,
  record_count  BIGINT,
  total_amount  NUMERIC,
  first_seen    DATE,
  last_seen     DATE
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT 'devis', COALESCE(s.zoho_department_label, '(vide)'),
         count(*), COALESCE(sum(s.amount), 0), min(s.sale_date), max(s.sale_date)
    FROM sales s
   WHERE s.department IS NULL
   GROUP BY 2
  UNION ALL
  SELECT 'factures', COALESCE(v.zoho_department_label, '(vide)'),
         count(*), COALESCE(sum(v.amount), 0), min(v.invoice_date), max(v.invoice_date)
    FROM invoices v
   WHERE v.department IS NULL
   GROUP BY 2
  ORDER BY 3 DESC;
$$;

GRANT EXECUTE ON FUNCTION get_unmapped_department_summary() TO authenticated;
