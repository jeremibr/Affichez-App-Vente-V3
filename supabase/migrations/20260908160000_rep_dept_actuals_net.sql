-- The per-department breakdown on "Mes Objectifs" did not add up to its own total.
--
-- Reported 2026-09-08 with a screenshot: TOTAL 2026 read $70,682.81 while the
-- department cards below it summed to $83,248. Measured across every rep, the
-- gap is EXACTLY the credit notes, every time:
--
--   rep                       total      departments        gap      avoirs
--   Dominic Letendre      1,560,985        1,722,706   -161,721    -161,721
--   Kim Foster Cunningham 1,119,760        1,221,141   -101,381    -101,381
--   Richard Courville     1,036,932        1,151,744   -114,812    -114,812
--   Francis Adam             70,683           83,248    -12,565     -12,565
--
-- Cause: this function carried `AND i.is_avoir = false`, so refunds were dropped
-- from the departments — while get_inv_sommaire_grand_total, which draws the
-- total above them, includes them. The parts were gross and the total was net.
--
-- This is the same class of fault Dominic reported in the 2026-09-04 meeting:
-- "on n'inclut pas les crédits, les avoirs" — the departments not carrying the
-- refunds. That instance was in the invoice sync; this is a second one, in the
-- read layer, and it survived the first fix because nothing here was ever
-- compared against its own total.
--
-- Two changes:
--
--  1. Credit notes are counted. They are stored negative, so a plain SUM is
--     already net and each department now shows money-in minus money-back.
--
--  2. A credit note whose department could not be traced back to the invoice it
--     corrects is returned under 'Non assigné' instead of being dropped. Without
--     it the cards would still not reconcile — they would be short by exactly
--     those rows, which is how this bug looked in the first place.

CREATE OR REPLACE FUNCTION get_rep_dept_actuals_factures(p_rep TEXT, p_year INTEGER)
RETURNS TABLE(month INTEGER, department TEXT, actual_amount NUMERIC)
LANGUAGE sql
STABLE
AS $$
  SELECT EXTRACT(MONTH FROM i.invoice_date)::int,
         -- Never dropped: a row with no department still moved money, and the
         -- total above these cards counts it.
         COALESCE(i.department, 'Non assigné'),
         SUM(i.amount)
    FROM invoices i
   WHERE i.rep_name = p_rep
     AND EXTRACT(YEAR FROM i.invoice_date) = p_year
     AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
     AND (i.rep_name IS NULL OR i.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
   GROUP BY 1, 2;
$$;

COMMENT ON FUNCTION get_rep_dept_actuals_factures(TEXT, INTEGER) IS
  'Per-department billing for one rep. Net of credit notes, and returns rows '
  'with no department under "Non assigné", so the cards sum to the total shown '
  'above them. Both were true of the total already and neither was true here.';
