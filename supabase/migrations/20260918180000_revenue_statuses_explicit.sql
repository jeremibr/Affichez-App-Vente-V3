-- Say which statuses are revenue, instead of which one is not.
--
-- Groundwork for storing every quote status. No behaviour changes today -- this
-- is provably a no-op, and that is the point of shipping it on its own.
--
-- 18 objects (11 functions, 7 views) decide which `sales` rows count as revenue,
-- and every one of them asks the same question backwards:
--
--     AND s.status::text != 'declined'
--
-- sale_status_enum holds exactly three values -- accepted, invoiced, declined --
-- so "not declined" and "accepted or invoiced" are the same set today. They stop
-- being the same set the moment the sync starts writing `sent`, `draft` and
-- `expired`, which is what the closing-rate fix requires. At that point every one
-- of these 18 would quietly fold 3,000+ expired quotes and every unanswered
-- estimate into revenue. No error, just a much larger number.
--
-- So the filters are tightened first, while it is still a no-op and can be
-- verified as one, and the sync changes second. Doing it in the other order has a
-- window where the dashboard is wrong.
--
-- NULL behaves identically under both forms: `NULL != declined` and
-- `NULL IN (...)` are both NULL, so a row with no status stays excluded either
-- way. `status` is nullable (DEFAULT accepted, no NOT NULL), so this mattered.
--
-- Sources: supabase/schema.sql, except get_quarterly_yoy and
-- get_quarterly_yoy_totals which come from 20260918160000. The snapshot was taken
-- before that migration merged and is already stale for those two -- rebuilding
-- them from it would have silently reverted the NULL guard it added. Exactly the
-- staleness its own header warns about, inside the same afternoon.
--
-- Everything below is mechanical: 21 predicates replaced across 18 objects, with
-- nothing else touched.

CREATE OR REPLACE FUNCTION "public"."get_available_weeks"("p_year" integer DEFAULT NULL::integer, "p_office" "public"."office_enum" DEFAULT NULL::"public"."office_enum", "p_status" "public"."sale_status_enum" DEFAULT NULL::"public"."sale_status_enum") RETURNS TABLE("week_start" "date", "week_end" "date", "total_amount" numeric, "num_sales" bigint)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  SELECT s.week_start, s.week_end, COALESCE(SUM(s.amount),0), COUNT(*)
  FROM sales s
  WHERE (p_year IS NULL OR s.year = p_year)
    AND s.status::text IN ('accepted','invoiced')
    AND (p_office IS NULL OR s.office = p_office)
    AND (p_status IS NULL OR s.status = p_status)
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (s.rep_name IS NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  GROUP BY s.week_start, s.week_end
  ORDER BY s.week_start DESC;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_dashboard_kpis"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("ytd_total" numeric, "ytd_count" bigint, "avg_deal_size" numeric, "annual_target" numeric, "pct_of_target" numeric, "invoiced_total" numeric, "accepted_total" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  WITH filtered_sales AS (
    SELECT amount, status FROM sales
    WHERE EXTRACT(year FROM sale_date::date) = p_year
      AND status::text IN ('accepted','invoiced')
      AND (p_office IS NULL OR office::text = p_office)
      AND (p_status IS NULL OR status::text = p_status)
      AND (p_month  IS NULL OR EXTRACT(month FROM sale_date::date) = p_month)
      AND (p_dept   IS NULL OR department::text = p_dept)
      AND (p_rep    IS NULL OR rep_name = p_rep)
      AND (p_reps   IS NULL OR rep_name = ANY(p_reps))
      AND client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (rep_name IS NULL OR p_reps IS NOT NULL OR rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  ),
  agg AS (
    SELECT COALESCE(SUM(amount),0) AS ytd_total, COUNT(*) AS ytd_count,
      COALESCE(AVG(amount),0) AS avg_deal_size,
      COALESCE(SUM(amount) FILTER (WHERE status::text='invoiced'),0) AS invoiced_total,
      COALESCE(SUM(amount) FILTER (WHERE status::text='accepted'),0) AS accepted_total
    FROM filtered_sales
  ),
  obj AS (
    SELECT COALESCE(SUM(o_target), 0) AS annual_target
    FROM (
      SELECT target_amount AS o_target FROM rep_objectives
      WHERE p_office IS NULL
        AND p_rep IS NOT NULL AND rep_name = p_rep AND module = 'devis' AND year = p_year
        AND (p_month IS NULL OR month = p_month)
      UNION ALL
      SELECT target_amount AS o_target FROM objectives
      WHERE p_office IS NULL
        AND p_rep IS NULL AND year = p_year
        AND (p_month IS NULL OR month = p_month)
        AND (p_dept IS NULL OR department::text = p_dept)
    ) combined
  )
  SELECT agg.ytd_total, agg.ytd_count, agg.avg_deal_size, obj.annual_target,
    CASE WHEN obj.annual_target=0 THEN 0
         ELSE ROUND((agg.ytd_total/obj.annual_target*100)::numeric,1) END,
    agg.invoiced_total, agg.accepted_total
  FROM agg, obj;
$$;

CREATE OR REPLACE FUNCTION "public"."get_quarterly_yoy"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text") RETURNS TABLE("quarter" integer, "rep_name" "text", "office" "text", "current_avg" numeric, "previous_avg" numeric, "resultat" numeric, "deal_count" bigint)
    LANGUAGE "sql" STABLE
    AS $$
WITH prev_defined AS (
  SELECT EXISTS (SELECT 1 FROM fiscal_quarters WHERE year = p_year - 1) AS ok
),
fq_weeks AS (
  SELECT year, quarter, start_date, end_date, num_weeks,
    CASE WHEN end_date < CURRENT_DATE THEN num_weeks
         WHEN start_date > CURRENT_DATE THEN 1
         ELSE LEAST(num_weeks, CEIL((CURRENT_DATE - start_date + 1)::float / 7)::int)
    END AS weeks_completed
  FROM fiscal_quarters
),
current_year AS (
  SELECT fq.quarter, s.rep_name, COALESCE(p_office,'Tous')::text AS office,
    SUM(s.amount)::numeric / MAX(fq.weeks_completed) AS avg_deal, COUNT(*)::bigint AS deal_count
  FROM sales s
  JOIN fq_weeks fq ON s.sale_date::date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year
    AND s.status::text IN ('accepted','invoiced')
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND s.rep_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND s.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
  GROUP BY fq.quarter, s.rep_name
),
previous_year AS (
  SELECT fq.quarter, s.rep_name,
    SUM(s.amount)::numeric / MAX(fq.weeks_completed) AS avg_deal
  FROM sales s
  JOIN fq_weeks fq ON s.sale_date::date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year - 1
    AND s.status::text IN ('accepted','invoiced')
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND s.rep_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND s.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
  GROUP BY fq.quarter, s.rep_name
)
SELECT cy.quarter, cy.rep_name, cy.office,
  cy.avg_deal,
  CASE WHEN (SELECT ok FROM prev_defined) THEN COALESCE(py.avg_deal,0) ELSE NULL END,
  CASE WHEN (SELECT ok FROM prev_defined) THEN cy.avg_deal - COALESCE(py.avg_deal,0) ELSE NULL END,
  cy.deal_count
FROM current_year cy
LEFT JOIN previous_year py ON cy.quarter=py.quarter AND cy.rep_name=py.rep_name
ORDER BY cy.quarter, cy.rep_name;
$$;

CREATE OR REPLACE FUNCTION public.get_quarterly_yoy_totals(
  p_year integer, p_office text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS TABLE(quarter integer, current_total numeric, previous_total numeric)
 LANGUAGE sql
 STABLE
AS $function$
WITH defined AS (
  SELECT EXISTS (SELECT 1 FROM fiscal_quarters WHERE year = p_year)     AS cur_ok,
         EXISTS (SELECT 1 FROM fiscal_quarters WHERE year = p_year - 1) AS prev_ok
),
fq_weeks AS (
  SELECT year, quarter, start_date, end_date, num_weeks,
    CASE WHEN end_date < CURRENT_DATE THEN num_weeks
         WHEN start_date > CURRENT_DATE THEN 1
         ELSE LEAST(num_weeks, CEIL((CURRENT_DATE - start_date + 1)::float / 7)::int)
    END AS weeks_completed
  FROM fiscal_quarters
),
cur AS (
  SELECT fq.quarter, SUM(s.amount)::numeric / MAX(fq.weeks_completed) AS total
  FROM sales s
  JOIN fq_weeks fq ON s.sale_date::date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year
    AND s.status::text IN ('accepted','invoiced')
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND s.rep_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND s.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
  GROUP BY fq.quarter
),
prev AS (
  SELECT fq.quarter, SUM(s.amount)::numeric / MAX(fq.weeks_completed) AS total
  FROM sales s
  JOIN fq_weeks fq ON s.sale_date::date BETWEEN fq.start_date AND fq.end_date
  WHERE fq.year = p_year - 1
    AND s.status::text IN ('accepted','invoiced')
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND s.rep_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND s.rep_name     NOT IN (SELECT rep_name    FROM excluded_reps)
  GROUP BY fq.quarter
)
SELECT q.quarter,
       CASE WHEN (SELECT cur_ok  FROM defined) THEN COALESCE(cur.total, 0)::numeric  ELSE NULL END,
       CASE WHEN (SELECT prev_ok FROM defined) THEN COALESCE(prev.total, 0)::numeric ELSE NULL END
FROM (SELECT DISTINCT quarter FROM fq_weeks) q
LEFT JOIN cur  ON cur.quarter  = q.quarter
LEFT JOIN prev ON prev.quarter = q.quarter
ORDER BY q.quarter;
$function$;

CREATE OR REPLACE FUNCTION "public"."get_rep_leaderboard"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("rep_name" "text", "office" "text", "total_amount" numeric, "deal_count" bigint, "avg_deal" numeric, "rank" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  WITH base AS (
    SELECT s.rep_name, MAX(s.office::text) AS office,
      SUM(s.amount)::numeric AS total_amount, COUNT(*) AS deal_count, AVG(s.amount)::numeric AS avg_deal
    FROM sales s
    WHERE EXTRACT(year FROM s.sale_date::date) = p_year
      AND s.status::text IN ('accepted','invoiced')
      AND (p_office IS NULL OR s.office::text = p_office)
      AND (p_status IS NULL OR s.status::text = p_status)
      AND (p_month  IS NULL OR EXTRACT(month FROM s.sale_date::date) = p_month)
      AND (p_dept   IS NULL OR s.department::text = p_dept)
      AND (p_rep    IS NULL OR s.rep_name = p_rep)
      AND (p_reps   IS NULL OR s.rep_name = ANY(p_reps))
      AND s.rep_name IS NOT NULL
      AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (p_reps IS NOT NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    GROUP BY s.rep_name
  )
  SELECT base.rep_name, base.office, base.total_amount, base.deal_count, base.avg_deal,
    ROW_NUMBER() OVER (ORDER BY base.total_amount DESC)
  FROM base ORDER BY base.total_amount DESC;
$$;

CREATE OR REPLACE FUNCTION "public"."get_sommaire"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("month" integer, "department" "public"."department_enum", "objectif" numeric, "actual_amount" numeric, "pct_atteint" numeric, "deal_count" bigint)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o.month AS o_month, o.department AS o_dept, o.target_amount AS o_total
    FROM objectives o
    WHERE o.year = p_year
      AND p_rep IS NULL AND p_reps IS NULL
      AND p_office IS NULL
  ),
  sales_agg AS (
    SELECT s.month AS s_month, s.department AS s_dept,
      COALESCE(SUM(s.amount), 0) AS s_total, COUNT(*)::bigint AS s_count
    FROM sales s
    WHERE s.year = p_year
      AND s.status::text IN ('accepted','invoiced')
      AND (p_office IS NULL OR s.office::text = p_office)
      AND (p_status IS NULL OR s.status::text = p_status)
      AND (p_rep    IS NULL OR s.rep_name = p_rep)
      AND (p_reps   IS NULL OR s.rep_name = ANY(p_reps))
      AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (s.rep_name IS NULL OR p_reps IS NOT NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    GROUP BY s.month, s.department
  ),
  all_combos AS (
    SELECT o_month AS m, o_dept AS d FROM obj
    UNION SELECT s_month AS m, s_dept AS d FROM sales_agg
  )
  SELECT ac.m::int, ac.d,
    COALESCE(o.o_total,0), COALESCE(sa.s_total,0),
    CASE WHEN COALESCE(o.o_total,0) > 0
         THEN ROUND((COALESCE(sa.s_total,0)/o.o_total)*100,2) ELSE 0::numeric END,
    COALESCE(sa.s_count,0)
  FROM all_combos ac
  LEFT JOIN obj       o  ON o.o_month=ac.m AND o.o_dept=ac.d
  LEFT JOIN sales_agg sa ON sa.s_month=ac.m AND sa.s_dept=ac.d
  ORDER BY ac.m, ac.d;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_sommaire_grand_total"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("month" integer, "objectif" numeric, "actual_amount" numeric, "pct_atteint" numeric, "deal_count" bigint)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  WITH obj AS (
    SELECT o_month, SUM(o_target) AS o_total
    FROM (
      SELECT ro.month AS o_month, ro.target_amount AS o_target FROM rep_objectives ro
      WHERE p_office IS NULL
        AND p_rep IS NOT NULL AND ro.rep_name = p_rep AND ro.module = 'devis' AND ro.year = p_year
      UNION ALL
      SELECT od.month AS o_month, od.target_amount AS o_target FROM objectives od
      WHERE p_office IS NULL
        AND p_rep IS NULL AND od.year = p_year
    ) combined GROUP BY o_month
  ),
  sales_agg AS (
    SELECT s.month AS s_month,
      COALESCE(SUM(s.amount), 0) AS s_total, COUNT(*)::bigint AS s_count
    FROM sales s
    WHERE s.year = p_year
      AND s.status::text IN ('accepted','invoiced')
      AND (p_office IS NULL OR s.office::text = p_office)
      AND (p_status IS NULL OR s.status::text = p_status)
      AND (p_rep    IS NULL OR s.rep_name = p_rep)
      AND (p_reps   IS NULL OR s.rep_name = ANY(p_reps))
      AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND (s.rep_name IS NULL OR p_reps IS NOT NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    GROUP BY s.month
  ),
  all_months AS (SELECT o_month AS m FROM obj UNION SELECT s_month AS m FROM sales_agg)
  SELECT am.m::int, COALESCE(o.o_total,0), COALESCE(sa.s_total,0),
    CASE WHEN COALESCE(o.o_total,0) > 0
         THEN ROUND((COALESCE(sa.s_total,0)/o.o_total)*100,2) ELSE 0::numeric END,
    COALESCE(sa.s_count,0)
  FROM all_months am
  LEFT JOIN obj       o  ON o.o_month  = am.m
  LEFT JOIN sales_agg sa ON sa.s_month = am.m
  ORDER BY am.m;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_top_clients"("p_year" integer, "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 10, "p_month" integer DEFAULT NULL::integer, "p_dept" "text" DEFAULT NULL::"text", "p_rep" "text" DEFAULT NULL::"text", "p_reps" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("client_name" "text", "total_amount" numeric, "deal_count" bigint, "office" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT s.client_name, SUM(s.amount)::numeric, COUNT(*), COALESCE(MAX(s.office::text), p_office)
  FROM sales s
  WHERE EXTRACT(year FROM sale_date::date) = p_year
    AND s.status::text IN ('accepted','invoiced')
    AND (p_office IS NULL OR s.office::text = p_office)
    AND (p_status IS NULL OR s.status::text = p_status)
    AND (p_month  IS NULL OR EXTRACT(month FROM sale_date::date) = p_month)
    AND (p_dept   IS NULL OR s.department::text = p_dept)
    AND (p_rep    IS NULL OR s.rep_name = p_rep)
    AND (p_reps   IS NULL OR s.rep_name = ANY(p_reps))
    AND s.client_name IS NOT NULL
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (s.rep_name IS NULL OR p_reps IS NOT NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
  GROUP BY s.client_name ORDER BY 2 DESC LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION "public"."get_weekly_detail"("p_week_start" "date", "p_office" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text") RETURNS TABLE("sale_date" "text", "client_name" "text", "amount" numeric, "quote_number" "text", "rep_name" "text", "department" "text", "zoho_department_label" "text", "office" "text", "status" "text", "zoho_id" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT s.sale_date::text, s.client_name, s.amount::numeric, s.quote_number,
    s.rep_name, s.department, s.zoho_department_label, s.office::text, s.status::text, s.zoho_id
  FROM sales s
  WHERE s.sale_date::date >= p_week_start
    AND s.sale_date::date < p_week_start + 7
    AND (p_office IS NULL OR s.office::text = p_office)
    AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (s.rep_name IS NULL OR s.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    AND (CASE WHEN p_status IS NULL THEN s.status::text IN ('accepted','invoiced')
              ELSE s.status::text = p_status END)
  ORDER BY s.sale_date DESC;
$$;

CREATE OR REPLACE FUNCTION "public"."get_weekly_mandates"("p_week_start" "date") RETURNS TABLE("client_name" "text", "departments" "text"[], "nb_quotes" bigint, "total_amount" numeric, "is_new" boolean)
    LANGUAGE "sql" STABLE
    AS $$
  WITH won AS (
    SELECT s.client_name, s.department, s.amount
    FROM sales s
    WHERE s.week_start = p_week_start
      AND s.status::text IN ('accepted','invoiced')
      AND s.client_name IS NOT NULL
      AND s.client_name NOT IN (SELECT client_name FROM excluded_clients)
      AND s.rep_name    NOT IN (SELECT rep_name    FROM excluded_reps)
  ),
  agg AS (
    SELECT w.client_name,
           array_agg(DISTINCT w.department::text ORDER BY w.department::text) AS departments,
           COUNT(*)::bigint AS nb_quotes,
           SUM(w.amount)::numeric AS total_amount
    FROM won w
    GROUP BY w.client_name
  )
  SELECT a.client_name, a.departments, a.nb_quotes, a.total_amount,
         NOT EXISTS (
           SELECT 1 FROM sales s2
           WHERE s2.client_name = a.client_name
             AND s2.status::text IN ('accepted','invoiced')
             AND s2.sale_date < p_week_start
         ) AS is_new
  FROM agg a
  ORDER BY a.total_amount DESC NULLS LAST, a.client_name;
$$;

CREATE OR REPLACE FUNCTION "public"."get_weekly_trend"("p_year" integer, "p_office" "public"."office_enum" DEFAULT NULL::"public"."office_enum", "p_status" "public"."sale_status_enum" DEFAULT NULL::"public"."sale_status_enum", "p_weeks" integer DEFAULT 12) RETURNS TABLE("week_start" "date", "total_amount" numeric, "deal_count" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT s.week_start, SUM(s.amount) AS total_amount, COUNT(*) AS deal_count
  FROM sales s
  WHERE s.year = p_year
    AND s.status::text IN ('accepted','invoiced')
    AND (p_office IS NULL OR s.office = p_office)
    AND (p_status IS NULL OR s.status = p_status)
  GROUP BY s.week_start
  ORDER BY s.week_start DESC
  LIMIT p_weeks;
END;
$$;

CREATE OR REPLACE VIEW "public"."v_weekly_summary" AS
 SELECT ("date_trunc"('week'::"text", ("sale_date")::timestamp without time zone))::"date" AS "week_start",
    (("date_trunc"('week'::"text", ("sale_date")::timestamp without time zone))::"date" + 6) AS "week_end",
    "rep_name",
    ("office")::"text" AS "office",
    ("status")::"text" AS "status",
    "department",
    "sum"("amount") AS "total_amount",
    "count"(*) AS "num_sales"
   FROM "public"."sales"
  WHERE (("rep_name" IS NOT NULL) AND (("status")::"text" = ANY (ARRAY['accepted'::"text", 'invoiced'::"text"])) AND (NOT ("client_name" IN ( SELECT "excluded_clients"."client_name"
           FROM "public"."excluded_clients"))) AND (NOT ("rep_name" IN ( SELECT "excluded_reps"."rep_name"
           FROM "public"."excluded_reps"))))
  GROUP BY (("date_trunc"('week'::"text", ("sale_date")::timestamp without time zone))::"date"), (("date_trunc"('week'::"text", ("sale_date")::timestamp without time zone))::"date" + 6), "rep_name", "office", "status", "department";


CREATE OR REPLACE VIEW "public"."v_weekly_dept_totals" AS
 SELECT "week_start",
    "week_end",
    "department",
    COALESCE("sum"("amount"), (0)::numeric) AS "total_amount",
    "count"(*) AS "num_sales"
   FROM "public"."sales"
  WHERE (("status")::"text" = ANY (ARRAY['accepted'::"text", 'invoiced'::"text"]))
  GROUP BY "week_start", "week_end", "department"
  ORDER BY "week_start" DESC, "department";


CREATE OR REPLACE VIEW "public"."v_weekly_grand_totals" AS
 SELECT "week_start",
    "week_end",
    COALESCE("sum"("amount"), (0)::numeric) AS "total_amount",
    "count"(*) AS "num_sales"
   FROM "public"."sales"
  WHERE (("status")::"text" = ANY (ARRAY['accepted'::"text", 'invoiced'::"text"]))
  GROUP BY "week_start", "week_end"
  ORDER BY "week_start" DESC;


CREATE OR REPLACE VIEW "public"."v_monthly_rep_totals" AS
 SELECT "s"."year",
    "s"."month",
    "r"."name" AS "rep_name",
    "r"."office",
    "s"."department",
    COALESCE("sum"("s"."amount"), (0)::numeric) AS "total_amount",
    "count"(*) AS "num_sales"
   FROM ("public"."sales" "s"
     JOIN "public"."reps" "r" ON (("r"."id" = "s"."rep_id")))
  WHERE (("s"."status")::"text" = ANY (ARRAY['accepted'::"text", 'invoiced'::"text"]))
  GROUP BY "s"."year", "s"."month", "r"."name", "r"."office", "s"."department"
  ORDER BY "s"."year", "s"."month", "r"."name", "s"."department";


CREATE OR REPLACE VIEW "public"."v_monthly_dept_totals" AS
 SELECT "year",
    "month",
    "department",
    COALESCE("sum"("amount"), (0)::numeric) AS "total_amount"
   FROM "public"."sales"
  WHERE (("status")::"text" = ANY (ARRAY['accepted'::"text", 'invoiced'::"text"]))
  GROUP BY "year", "month", "department"
  ORDER BY "year", "month", "department";


CREATE OR REPLACE VIEW "public"."v_monthly_grand_totals" AS
 SELECT "year",
    "month",
    COALESCE("sum"("amount"), (0)::numeric) AS "total_amount"
   FROM "public"."sales"
  WHERE (("status")::"text" = ANY (ARRAY['accepted'::"text", 'invoiced'::"text"]))
  GROUP BY "year", "month"
  ORDER BY "year", "month";


CREATE OR REPLACE VIEW "public"."v_quarterly_rep_averages" AS
 SELECT "fq"."year",
    "fq"."quarter",
    "r"."name" AS "rep_name",
    COALESCE("sum"("s"."amount"), (0)::numeric) AS "quarter_total",
        CASE
            WHEN ("fq"."end_date" > CURRENT_DATE) THEN GREATEST(1, ((CURRENT_DATE - "fq"."start_date") / 7))
            ELSE "fq"."num_weeks"
        END AS "num_weeks",
    "round"((COALESCE("sum"("s"."amount"), (0)::numeric) / (GREATEST(1,
        CASE
            WHEN ("fq"."end_date" > CURRENT_DATE) THEN ((CURRENT_DATE - "fq"."start_date") / 7)
            ELSE "fq"."num_weeks"
        END))::numeric), 2) AS "weekly_average"
   FROM (("public"."fiscal_quarters" "fq"
     CROSS JOIN "public"."reps" "r")
     LEFT JOIN "public"."sales" "s" ON ((("s"."rep_id" = "r"."id") AND ("s"."sale_date" >= "fq"."start_date") AND ("s"."sale_date" <= "fq"."end_date") AND (("s"."status")::"text" = ANY (ARRAY['accepted'::"text", 'invoiced'::"text"])))))
  WHERE ("r"."is_active" = true)
  GROUP BY "fq"."year", "fq"."quarter", "fq"."num_weeks", "fq"."start_date", "fq"."end_date", "r"."name"
  ORDER BY "fq"."year", "fq"."quarter", "r"."name";

