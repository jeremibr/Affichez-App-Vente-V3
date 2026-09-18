# Stats integrity — what the numbers actually mean

Audit date: **2026-09-18**. Method: read every RPC in `supabase/migrations/` and
`supabase_*.sql`, then check each conclusion against live production data.
Findings marked **PROVEN** were reproduced against the live database; findings
marked **CODE** were read off the SQL but could not be executed, because RLS
blocks the anon key from `invoices`, `zoho_tasks` and `zoho_leads`.

The dashboard exists to be trusted. A number that is subtly wrong is worse than
no number, because nobody goes looking for it. Read the cardinal rule before
writing or changing any statistic.

---

## The cardinal rule: a table is not its subject

**Every table in this app holds a filtered subset of what its name suggests.**
The filter lives in the sync function, thousands of lines away from the SQL that
aggregates it, and it is invisible from the query.

| table | name suggests | actually contains |
| --- | --- | --- |
| `sales` | all quotes | **only quotes that were won** — `accepted`, `invoiced`, plus `declined` *only if it was accepted first* |
| `invoices` | all invoices | all except `draft` and `void`; credit notes stored separately with `is_avoir = true` and a **negative** amount |
| `zoho_tasks` | all tasks | only reps in `tasks_visible_reps()` |
| `zoho_leads` | all leads | complete — the sync applies no status filter |

### Why `sales` is the dangerous one

`zoho-sync/index.ts` writes a row **only** when Zoho reports `accepted`,
`invoiced` or `paid` ([:316](supabase/functions/zoho-sync/index.ts#L316)).
`declined`/`void` trigger a **PATCH of an existing row**, never an insert
([:343](supabase/functions/zoho-sync/index.ts#L343)) — so a quote declined
without ever being accepted is never recorded at all. A full sync asks Zoho only
for `Accepted` and `Invoiced` ([:283](supabase/functions/zoho-sync/index.ts#L283)).

Verified live, whole table — 8,085 rows, every one a winner:

| status | rows |
| --- | --- |
| `invoiced` | 7,753 |
| `accepted` | 147 |
| `declined` | 185 |
| `sent` / `draft` / `expired` | **0** |

Ground truth from the Zoho Books API, **QC org alone**: **> 3,000 expired**,
**> 1,500 declined**, **1,000–3,000 sent**, **> 200 draft**. At least ~5,700 lost
quotes the database has never seen, against 7,753 won across both offices.

> **Therefore: you cannot compute a closing rate, win rate, conversion rate or
> any other ratio from `sales`. The losing quotes are not in there.**

---

## Confirmed defects

### 1. `Taux` on the Créé par page is not a closing rate — **PROVEN**

`get_creator_summary` ([creator_rpcs.sql:43](supabase/migrations/20260907170000_creator_rpcs.sql#L43))
computes `quotes_won / quotes_created`, where `quotes_created` is simply every
`sales` row for that creator. Per the cardinal rule, that denominator is a
population of winners.

Guillaume Montambeault, 2026: 27 accepted + 479 invoiced + 14 declined = 520;
479/520 = **92.1%**, exactly what the page shows. The real company-wide rate is
**at most ~58%** and realistically nearer 50% — that bound counts QC's losses
only and ignores Montréal's entirely.

What it actually measures: *of the quotes already won, the share that got
invoiced.* Fixing it requires changing the sync to store every status, not
changing the SQL.

**In progress, in three steps.** The order matters, because doing it the other way
round leaves a window where every dashboard overstates revenue:

1. `20260918180000_revenue_statuses_explicit.sql` — **done.** 18 objects (11
   functions, 7 views) asked "is this row *not* declined". With only three enum
   values that was the same as "is it accepted or invoiced", but it stops being
   the same the moment new statuses exist: 3,000+ expired quotes and every
   unanswered estimate would fold into revenue silently. Now stated explicitly.
   A provable no-op on its own.
2. Extend `sale_status_enum` and change `zoho-sync` to write every status rather
   than only the winners.
3. Recompute `Taux` over the denominator that finally exists.

### 2. `% of target` is wrong whenever an office or rep-group filter is applied — **PROVEN**

> **Office half fixed** by `20260918130000_objectives_office_scope.sql`: with an
> office filter the objective source now yields no rows, so the card reads "—"
> instead of a percentage against somebody else's target. The rep-group half is
> deliberately untouched — see the end of this entry.

`objectives` and `objectives_factures` have **no `office` column** — targets are
company-wide. But the actuals are office-filtered while the target subquery is
not ([devis_rep_groups.sql:60](supabase/migrations/20260914120000_devis_rep_groups.sql#L60),
[invoice_rep_groups.sql:63](supabase/migrations/20260908130000_invoice_rep_groups.sql#L63)).

`get_dashboard_kpis(2026)` — the target never moves:

| filter | actual | target | shown |
| --- | --- | --- | --- |
| All offices | 5,971,595 | 8,429,650 | 70.8% |
| QC | 3,898,909 | **8,429,650** | **46.3%** |
| MTL | 2,072,685 | **8,429,650** | **24.6%** |

46.3 + 24.6 ≈ 70.8. The per-office figures are not attainment; they are "share of
the company target this office delivered". QC could be at 95% of its own target
and still display 46%.

The same applies to `p_reps` (the "Interne"/"Équipe" groups): actuals narrow to
the group, the target stays company-wide. `p_rep` (a single named rep) is handled
correctly via `rep_objectives`, and `p_dept`/`p_month` are correctly filtered on
both sides.

Affected `get_dashboard_kpis`, `get_sommaire`, `get_sommaire_grand_total`, and all
three `get_inv_*` equivalents.

**Why the rep-group half is still open.** For "Équipe entière" the team objective
*is* the right target; for "Interne" it is not. The two need different answers
and choosing between them is a product decision, not a bug fix, so it was left
alone rather than settled quietly. Note the codebase is already inconsistent
here: `get_sommaire` suppresses the objective on `p_reps`, the other five do not.

**Getting the percentage back under an office filter** needs an `office` column
on `objectives` / `objectives_factures` and a way to enter those numbers in
Réglages. At that point the guards become
`AND (p_office IS NULL OR office = p_office)`.

### 3. Year-over-year silently reports zero for 2025 — **PROVEN**

> **Symptom fixed** by `20260918150000_fiscal_quarters_2024.sql`, which adds the
> four 2024 quarters so 2025 has a real year to be measured against. **The
> underlying defect is still open**: a missing calendar year still returns `0`
> rather than "unknown". See "What is still open" at the end of this entry.

`fiscal_quarters` only covers **2025-01-01 → 2026-12-31** (8 rows, no gaps or
overlaps). The YoY functions inner-join sales to that table and select
`fq.year = p_year - 1` for the comparison, so asking for 2025 looks for 2024
quarters that do not exist:

```
get_quarterly_yoy_totals(2025) → previous_total = 0 for Q1, Q2, Q3, Q4
```

…while `sales` holds **1,868 rows dated 2024**. `QuarterBlock.tsx` renders
`totalCurrent - totalPrevious`, so every quarter shows the full current amount as
a green `TrendingUp` gain against a year that simply was not queried.

Two consequences of the same inner join:
- **Any sale dated outside 2025–2026 is invisible to every quarterly page.**
- The moment 2027 begins, 2027 pages break the same way unless rows are added.

The weekly-rate normalisation itself (`SUM(amount) / weeks_completed`) is
**sound** — both sides are per-week figures, so they are comparable. Note only
that a quarter one day old divides by a full week, so early-quarter rates are
noisy.

The calendar is calendar quarters with `num_weeks` as a nominal 13, not a
measured length: 2025 Q1 is 90 days, Q3 is 92, both recorded as 13. Keep that
convention when adding a year, or the weekly rate stops being comparable across
quarters.

**The cause is fixed too**, by `20260918160000_yoy_unknown_not_zero.sql`. `0` for
a year that was never queried was indistinguishable from `0` for a year with no
sales, and that is what kept this invisible from 2025-01-01 until it was found.
All four functions now return `NULL` when the year in question has no
`fiscal_quarters` rows, and the UI prints "—". A defined year with no sales still
returns `0`, because that zero is a real measurement.

All four had to change together: the per-rep `get_quarterly_yoy` and
`get_inv_quarterly_yoy` were database-only until `supabase/schema.sql` captured
them, and fixing only the two team-total functions already in the repo would have
printed "—" on the Total équipe row above rep rows still printing `0`.

### 4. Task `completion_rate` compares two different cohorts — **CODE**

[supabase_tasks.sql:96](supabase_tasks.sql#L96) and
[:135](supabase_tasks.sql#L135):

```sql
COUNT(*) FILTER (WHERE in_completed) * 100.0 / COUNT(*) FILTER (WHERE in_created)
```

The numerator counts tasks **closed** in the period; the denominator counts tasks
**created** in the period. A task created in January and closed in March lands in
January's denominator and March's numerator. The ratio is two unrelated flows and
**can exceed 100%**.

A real completion rate needs one cohort: of the tasks *created* in the period,
how many are now closed. Separately, `total_open` and `total_overdue` are
current-state and ignore the period filter entirely — deliberate and commented,
but it means a KPI strip headed "Janvier" mixes January flow with today's backlog.

### 5. "Number of invoices" has two different definitions on one page — **CODE**

> **Fixed** by `20260918170000_inv_count_excludes_avoirs.sql`: both Sommaire
> functions now count with `FILTER (WHERE NOT i.is_avoir)`, matching the KPI card.
> Amounts are untouched and stay net of credit notes — see below for why that
> asymmetry is the correct one.

- `get_inv_dashboard_kpis` → `COUNT(*) FILTER (WHERE NOT is_avoir)` (excludes credit notes)
- `get_inv_sommaire` / `get_inv_sommaire_grand_total` → plain `COUNT(*)` (includes them)

The KPI card and the table beneath it will disagree by the number of credit
notes. Amounts are consistent (both net, credit notes being negative); only the
counts diverge.

### 6. Smaller inconsistencies — **PROVEN**

- `get_creator_summary.quotes_created` counts `declined` rows; every other devis
  RPC excludes them with `status != 'declined'`.
- `get_dashboard_kpis` includes rows with `rep_name IS NULL`;
  `get_rep_leaderboard` and `get_quarterly_yoy_totals` require
  `rep_name IS NOT NULL`. Currently 5 rows, all 2022–23, $2,109 total — the 2026
  leaderboard reconciles to the KPI card exactly. Latent, not active.
- `get_inv_top_clients` has `HAVING SUM(amount) > 0`, so a client whose refunds
  exceed their billing disappears from the list rather than showing negative.

---

## Latent hazards — correct today, no guard tomorrow

### `NOT IN (SELECT ...)` — a loaded gun, but the safety is on

**Corrected 2026-09-18.** This was written up as an open hazard on the strength of
the *data* (`excluded_clients` = 2 rows, `excluded_reps` = 1, no NULLs) without
checking the *constraints*. The schema settles it, and the answer is that the
scenario cannot occur:

```sql
excluded_clients.client_name  text NOT NULL
excluded_reps.rep_name        text NOT NULL
sales.client_name             text NOT NULL
invoices.client_name          text NOT NULL
```

34 occurrences across 6 files filter with
`client_name NOT IN (SELECT client_name FROM excluded_clients)` and the
`excluded_reps` equivalent. In SQL, a subquery returning **even one NULL** makes
the predicate NULL for every row, and every dashboard silently returns zero — not
an error, zero. That is a genuinely dangerous construct, and it is worth
recognising on sight. But here **both subqueries are NOT NULL at the column
level**, so they can never return one.

The mirror case — the *outer* column being NULL, since `NULL NOT IN (...)` is NULL
rather than true — is likewise closed for `client_name` on both tables. `rep_name`
IS nullable on `sales` and `invoices`, but every function either guards it
explicitly (`rep_name IS NULL OR ...`) or excludes it (`rep_name IS NOT NULL`).

**Do not spend a day converting 34 predicates to `NOT EXISTS`.** If you add a new
exclusion table, give its column `NOT NULL` and the same guarantee carries over.

### Two definitions of "which period" — also safe

**Corrected 2026-09-18**, same way as the entry above: checked against a sample
first, and the schema afterwards.

`get_sommaire` filters on the stored `sales.year` / `sales.month` columns while
`get_dashboard_kpis` uses `EXTRACT(... FROM sale_date)`. They cannot diverge,
because those columns are not stored values that something has to keep in sync —
they are generated:

```sql
month integer GENERATED ALWAYS AS ((EXTRACT(month FROM sale_date))::integer) STORED
year  integer GENERATED ALWAYS AS ((EXTRACT(year  FROM sale_date))::integer) STORED
```

Postgres maintains them from `sale_date` on every write. The two forms are the
same expression, so either is fine to use. (`EXTRACT` on the raw column is not
index-friendly — see the Performance rules in CLAUDE.md — but that is a speed
question, not a correctness one.)

---

## Security findings (found during this audit)

- **The `anon` role held `DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE,
  UPDATE` on all 38 objects in `public`** — not SELECT, everything. That is
  Supabase's default blanket grant, and `anon` is the role behind
  `VITE_SUPABASE_ANON_KEY`, which ships inside the built JS bundle.
  **Closed by `20260918140000_revoke_anon_access.sql`.**

  Seven tables had no RLS at all, so the grant was live and unguarded to any
  unauthenticated caller: `paye_entries` (payroll), `rep_objectives` (per-rep
  targets), `objectives_factures`, `excluded_clients`, `excluded_reps`,
  `paye_meta`, `sync_state`. The rest had RLS on but a permissive policy that let
  anon read regardless — 8,085 rows from `sales`, 103,170 from `webhook_log`.

  **RLS alone could never have finished this**, which is why the fix is a revoke:
  - 8 of the 13 views run with OWNER rights (no `security_invoker`), so base
    table RLS does not reach them. `invoices` correctly returned zero rows to
    anon while `v_inv_weekly_summary` handed over 4,270 rows of the same data —
    the 2026-09-03 invoices fix was bypassed from the day it shipped.
  - `zoho_service_labels` is a MATERIALIZED view. Those support no RLS at all.

  Worth knowing for anyone adding RLS here: the dashboard RPCs are SECURITY
  INVOKER and read `excluded_clients` / `excluded_reps` through `NOT IN` in 22
  places each. Enabling RLS on those two without a SELECT policy for
  `authenticated` raises no error — the subquery returns zero rows, `NOT IN ()`
  is true for everything, and every excluded client plus the internal rep
  silently reappears in every total. A security fix would have become a
  reporting defect.
- **Revenue RPCs are granted to `anon`**: `get_dashboard_kpis`,
  `get_rep_leaderboard`, `get_sommaire`, `get_sommaire_grand_total`,
  `get_top_clients`, `get_quarterly_yoy_totals`. All were called anonymously
  during this audit and returned real revenue and targets.
- **RLS makes a restricted dashboard read as zero, not as an error.**
  `get_inv_dashboard_kpis` is `SECURITY INVOKER`; called with no rights to
  `invoices` it returns `ytd_total: 0` alongside a real `annual_target:
  9,333,795.45` — a confident, wrong 0% rather than a failure.

---

## Rules for anyone adding or changing a statistic

1. **Before writing a ratio, prove the denominator population.** Run a
   `GROUP BY status` (or equivalent) on the source table and confirm every
   outcome you are dividing by is actually present. Losers are usually missing.
2. **Filter the numerator and the denominator on the same dimensions.** If the
   actuals narrow by office, rep or department, the target must narrow too — or
   the comparison must be removed, not displayed.
3. **A ratio needs one cohort.** "Created in period" and "closed in period" are
   different sets of rows. Pick one and stay in it.
4. **Count the same thing everywhere on a page.** If the KPI card excludes credit
   notes, the table under it must too.
5. **Any inner join to a dimension table (`fiscal_quarters`, `objectives`) is a
   filter.** Rows with no match disappear silently. Use `LEFT JOIN` plus an
   explicit "no data" state, or assert coverage.
6. **Never use `NOT IN` with a nullable subquery.** Use `NOT EXISTS`.
7. **Distinguish "zero" from "unknown".** Returning `0` for a period that was
   never queried is how defect #3 stayed invisible.
8. **Verify against the source of truth, not the mirror.** The Zoho Books API is
   the only authority on what a quote's status is. The database is a filtered
   copy, and the filter is the bug.

### How to verify quickly

```bash
KEY=$(grep VITE_SUPABASE_ANON_KEY frontend/.env | cut -d= -f2- | tr -d '"')
B=https://auyfucbskylougsmmrks.supabase.co/rest/v1

# population check — what is actually in the table
curl -s "$B/sales?select=status" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Prefer: count=exact" -H "Range: 0-0" -D - -o /dev/null

# does a filter move the target? (it must)
curl -s -X POST "$B/rpc/get_dashboard_kpis" -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"p_year":2026,"p_office":"QC"}'

# does the leaderboard reconcile to the KPI card? (it must)
curl -s -X POST "$B/rpc/get_rep_leaderboard" -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"p_year":2026}'
```

---

## Not defects — checked and sound

Recorded so nobody re-opens them:

- **Revenue totals.** Every revenue RPC consistently excludes `declined` and sums
  accepted+invoiced. The 2026 leaderboard reconciles to the KPI card to the cent
  (5,971,595.48, 1,690 deals, both).
- **Credit notes.** Stored negative (`* -1`,
  [zoho-invoice-sync:459](supabase/functions/zoho-invoice-sync/index.ts#L459)),
  so amount totals are correctly net of refunds. `get_creator_summary` counting
  invoices excluding avoirs while summing amounts including them looks wrong but
  is deliberate: count = documents issued, amount = net billed.
- **Invoices dropping `draft`/`void`.** Neither is revenue, and no ratio is built
  on the invoice table.
- **YoY weekly-rate normalisation.** Mathematically sound (see #3).
- **`fiscal_quarters` boundaries.** 8 quarters, no gaps, no overlaps.
- **Créé par not reconciling with rep leaderboards.** Deliberate and documented —
  it counts who keyed the document in, not who sold it. Vincent Fourcade's 5
  quotes against 1,491 invoices is the billing role, not corruption.
- **Leads.** `zoho-lead-sync` applies no status filter, so `conversion_rate` in
  `get_leads_kpis` is computed over a complete population.
- **`sales.year`/`month`.** Consistent with `sale_date` across 1,000 sampled rows.

- **A leaderboard that sums to slightly more than the KPI card above it.** Almost
  always a refetch, not a filter mismatch. `cachedRpc` holds a result for 60 s
  and the quotes sync runs every 5 min, so a card fetched on page load and a
  modal fetched on click can sit either side of a sync. Seen 2026-09-18: the
  leaderboard read 5,971,675.48 / 1,691 against a card showing
  5,971,595.48 / 1,690 — exactly one quote apart (`SOUMQC-028590`, $80.00,
  created 17:03:47Z between the two fetches).

  Tell the two apart before investigating: a genuine filter mismatch moves a
  *population* — `Vente interne` alone is $12,600 in 2026, and any excluded-row
  leak shows up in thousands, not in one row. A one-row, one-quote difference is
  the clock. Reload and open the modal inside the 60 s cache window; if they
  agree, there is nothing to fix.
