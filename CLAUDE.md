# CLAUDE.md 

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Affichez-App-Vente** is an internal sales performance dashboard for Affichez, a Quebec-based advertising company. It visualizes sales data (revenue, deals, reps, departments) from a Supabase backend. The frontend is a React + TypeScript + Vite SPA inside the `frontend/` directory.

The frontend has no server of its own — it reads directly from Supabase via `@supabase/supabase-js`, using PostgreSQL RPC functions and direct table queries. Real-time updates are handled via Supabase Realtime channels subscribed to the `sales` table. Writes into Supabase come from the Deno edge functions in `supabase/functions/`, which pull from Zoho on a schedule (see **Zoho Sync** below).

## Development Commands

```bash
cd frontend

# Install dependencies
npm install

# Start development server (port 5173)
npm run dev

# Type-check and build for production
npm run build

# Lint
npm run lint

# Preview production build
npm run preview
```

## Environment Variables

Create `frontend/.env`:
```bash
VITE_SUPABASE_URL=       # Supabase project URL
VITE_SUPABASE_ANON_KEY=  # Supabase anonymous key
```

The app throws at startup if either variable is missing (see `src/lib/supabase.ts`).

## Architecture

### Data Layer
All data flows through `src/lib/supabase.ts` (the singleton Supabase client). Pages call either:
- **`cachedRpc('function_name', params)`** from `src/lib/rpcCache.ts` — for analytics (KPIs, summaries, leaderboards, YoY). **Not `supabase.rpc` directly**; see Performance below.
- `supabase.from('table').select(...)` — for CRUD in Settings (reps, objectives, quarters, webhook_log). Deliberately uncached: a stale row after a write is a bug, not a saving.

There is no service layer abstraction; Supabase calls are made directly inside page components using `useCallback`-wrapped async functions. Real-time subscriptions (Supabase Realtime) are set up in `useEffect` and cleaned up on unmount.

### Performance: four rules that are easy to undo by accident

Measured 2026-09-15. The Comptes RPCs averaged 1.2–2.7 s each and the page fires
seven of them; `get_tasks_weekly` averaged 2.6 s. None of it was data volume —
the largest table is 62k rows. After the fixes below the same queries run in
15–90 ms. Each rule is one line away from being reverted, and reverting it
fails silently.

**1. A `LANGUAGE sql` helper must not carry `SET search_path`.** Postgres
refuses to inline a SQL function whose `pg_proc.proconfig` is non-NULL, and an
un-inlined function is a `Function Scan`: the caller's predicates and indexes
cannot reach the table, so the whole table is read every time. That single
clause on `zoho_accounts_scoped` was costing 3× on every Comptes screen.

`SET search_path` protects SECURITY **DEFINER** functions, which run as their
owner. These are SECURITY INVOKER — they already run with the caller's
privileges, so a poisoned search_path gains the caller nothing. The bodies are
schema-qualified anyway. Keep the SET clause on SECURITY DEFINER functions
(`tasks_visible_reps`, `refresh_zoho_service_labels`); never add it back to the
invoker helpers. A guard query:

```sql
SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proconfig IS NOT NULL AND p.prosecdef = false
  AND p.proname LIKE ANY (ARRAY['zoho_%', 'ad_%']);   -- must return zero rows
```

**2. Filter dates with a RANGE, never `EXTRACT(... FROM col)`.** Wrapping the
column in a function makes the predicate unservable by any btree index on it.
`EXTRACT(YEAR FROM created_time AT TIME ZONE 'America/Toronto') = p_year` is
exactly `created_time >= make_timestamptz(p_year,1,1,0,0,0,'America/Toronto')
AND created_time < make_timestamptz(p_year+1,…)`, and only the second form uses
`zoho_accounts_created_idx`. Same for ISO years on `zoho_tasks`: ISO year Y is
`[date_trunc('week', make_date(Y,1,4)), date_trunc('week', make_date(Y+1,1,4)))`.

**3. `zoho_service_labels` is a MATERIALIZED view.** As a plain view it
seq-scanned `zoho_leads`, `zoho_accounts` and `invoices` — 30,208 rows sorted —
to produce **15**, at 354 ms a call, and four RPCs join it. `cron.schedule`
refreshes it every 10 minutes (`refresh-zoho-service-labels-10m`). The cost is
staleness: a service Zoho has never billed or quoted before shows its raw
spelling and is missing from the Service filter until the next refresh. If you
add a sync that can introduce a new service, call
`public.refresh_zoho_service_labels()` at the end of it.

**4. A refetch must invalidate the cache first.** `cachedRpc` holds results for
60 s (10 min for filter options and week lists) and de-duplicates in-flight
requests, which is what makes navigation instant — a round trip between two
dashboards issues **zero** network requests. It also means a Realtime handler
that calls `fetchData()` without `invalidateRpcCache()` is answered out of the
entry the event says is stale, and the page looks refreshed while showing old
numbers. Every Realtime handler, every "Actualiser" button, the post-sync status
read in Settings and `signOut` already call it — keep it that way when adding
more. `cachedRpc` deliberately never serves stale data: past the TTL it waits
for the real answer, because a revenue total that silently changes a second
after someone reads it is worse than one that took a second to arrive.

**Routes are lazy** (`React.lazy` in `App.tsx`), so first paint carries a 147 kB
gzip core plus a 2–8 kB screen instead of one 216 kB bundle. `src/lib/prefetch.ts`
warms both the chunk and the screen's first query on nav-link hover, so add new
routes to `ROUTE_CHUNKS` there when you add them to `App.tsx`.

**Where the time actually goes.** Per-request overhead to Supabase is ~25 ms
from Montreal and dominates the query itself for the fast screens —
`get_dashboard_kpis` runs in 0.6 ms. So *the number of requests matters more
than the cost of each*, which is why the cache and the prefetch are worth more
than further SQL tuning. The project is in **us-east-1**; anyone measuring from
elsewhere will see a much larger fixed cost that the Quebec users do not.

### Zoho Sync (Supabase Edge Functions)

`supabase/functions/` holds the Deno edge functions that pull from Zoho; the React
app only ever reads what they have written. Two different Zoho products are
involved and they do not share ids or credentials:

- **Zoho Books** (`zoho-sync`, `zoho-invoice-sync`, `zoho-quote-creator-sync`) —
  two organisations, QC and MTL, feeding `quotes` and `invoices`. Verified
  2026-09-07 against `GET /books/v3/organizations`: those two are **the only**
  orgs the token can see, so the Royer & Fils revenue below is not reachable
  through these credentials at all.
- **Zoho CRM** (`zoho-lead-sync`, `zoho-task-sync`, `zoho-account-sync`) — one
  org, feeding `zoho_leads`, `zoho_tasks` and `zoho_accounts`.

`zoho-account-sync` needs `ZohoCRM.modules.accounts.READ` on top of the leads,
contacts and users scopes the shared CRM refresh token was issued with. It was
missing at first; **verified present on 2026-09-07**. Without it every page 401s
and the walk upserts nothing while still reporting success, so re-check before
blaming anything else:

```
curl.exe -H "x-check-scope: true" https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-account-sync
```

### Who created a document, vs who sold it

Zoho Books stores two different people on a quote or invoice: the **salesperson**
(who owns the sale) and the **creator** (who typed it in). Everything in the app
reads the salesperson except `/createurs`, which reads the creator — asked for so
Morgane Owczarzak's and Guillaume Montambeault's admin work is visible even when
the sale is credited elsewhere.

The two modules give it away very differently (verified 2026-09-07):

- **Invoices** — `created_by` is a NAME on the list payload. Free.
- **Estimates** — no creator on the list at all; the detail endpoint has only
  `created_by_id`. One API call per quote, resolved through `zoho_books_users`
  (150 users). That is what `zoho-quote-creator-sync` is for: a paced, resumable
  back-fill over 7,961 quotes, cron every 3 min until `pending` hits zero.

`zoho-sync` deliberately omits `created_by_name` from its upsert. PostgREST's
merge-duplicates only touches columns present in the payload, so a routine quote
re-sync cannot wipe a name the back-fill paid an API call for.

**These figures never reconcile with the rep numbers, by design.** A quote created
by Morgane and sold by Dominic counts once under each. `/createurs` is admin-only
and says so on screen; never add its totals to a leaderboard.

### The syncs no longer discard records silently

`zoho-invoice-sync` and `zoho-sync` used to `continue` past any record whose
department wasn't in `DEPT_MAP` — no error, no log, nothing on screen. On
2026-09-07 that was changed to land the row with a NULL `department`, keeping
Zoho's raw label, surfaced by `get_unmapped_department_summary` in Settings.

It found sixteen months of missing money on the first run:

- **`ÉVÈNEMENT`** — a real seventh department Zoho Books had been billing under
  since 2025-05-29. 160 invoices, $142,918, none of which had ever reached the
  app. Now `EVENEMENT` in `department_enum`, `DEPT_MAP` and `DEPARTMENTS`.
  `objectives_factures` has no target rows for it yet.
- **92 credit notes, -$117,764** across 2025-26 whose department could not be
  resolved from `reference_number`. Dominic's diagnosis in the 2026-09-04
  meeting — *"on n'inclut pas les crédits, les avoirs"* — was correct.

A full sync with `x-date-start: 2021-01-01` also pulled in ~4,000 invoices from
2021-22 that the old window had never covered. They are kept; they carry no
department because Zoho has none on them.

Two Zoho API quirks are worth knowing before touching `zoho-invoice-sync`:

- Books list endpoints filter dates with `date_start` / `date_end`. The dotted
  form `date.start` is accepted and **silently ignored**.
- `date_start` and `filter_by` are mutually exclusive — send both and the date
  range is dropped without an error.

### Invoices on a lead or contact

An invoice belongs to a CRM **account**, never to a person, so every contact at a
company shows the same invoices. Zoho Books only links its customers at account
level (`zcrm_account_id`), so this is the real grain of the data, not a shortcut.

The chain, resolved right to left because that is the cheap direction — 14k
invoices name only ~3.1k customers, against ~20.6k CRM accounts:

```
zoho_leads.account_id ◀── Contacts.Account_Name.id   (zoho-lead-sync)
        ▲
        │ = invoices.crm_account_id
        │
zoho_books_customers.crm_account_id ◀── Books contact.zcrm_account_id
        ▲                                (zoho-books-customer-link)
        │ = invoices.books_customer_id ◀── Books invoice.customer_id
        │                                 (zoho-invoice-sync)
```

`zoho_books_customers` is a cache of the one hop that costs an API call, filled a
slice at a time under Zoho's 100-calls/minute/org limit by the
`zoho-books-customer-link` function (cron, every 30 min). Two triggers keep
`invoices.crm_account_id` in step in both directions, so neither sync needs to
know about the other. `get_lead_invoice_totals` / `get_lead_invoices` back the
Factures column and modal on the Leads page; `get_invoice_linkage_status` reports
back-fill coverage in Settings.

### Comptes: the account is the record

The **Comptes** module (`/comptes`, `/comptes/detail`) is the primary funnel view
and replaced the Leads pages on 2026-09-07. Its grain is the Zoho CRM **account**,
because that is the grain the business is run in: a company with three contacts
is one account, so its revenue is counted once with no dedupe layer.

The Leads pages and every `get_zoho_lead*` RPC are still there and still work —
only the routes and nav entries in `App.tsx` / `Layout.tsx` are commented out.
Uncomment them to compare a number against the old grain.

Three things about the Comptes module that are not obvious:

- **Revenue is windowed.** `p_window_months` (default 12) caps attributed revenue
  at N months from the account's creation. Without it a 2021 account beats a 2026
  one purely by having had five more years to buy, and no month-over-month or
  source-over-source comparison means anything. `NULL` lifts the cap.
- **`revenue_per_account` divides by accounts *created*, not accounts invoiced.**
  The accounts that bought nothing are what makes a bad source bad.
- **1,937 accounts are rated "Compte interne : Ne pas reprendre"** and 3
  "Fournisseur" — Affichez's own entities. Every RPC excludes them by default via
  `p_exclude_ratings`; the pages carry a "Statut" filter to switch them back on.
  The detail table filters `zoho_accounts_enriched.is_internal` instead, because
  PostgREST's `rating=not.in.(…)` is NULL — not TRUE — for the 977 unrated rows
  and would silently hide them.

**Royer & Fils / VotreLogo.ca is a different company's revenue.** Measured
2026-09-07: `SUM(Ventes_totales_2022_2026)` is $5,530,878.34 across all 20,645
accounts and $5,530,878.34 across just the 2,028 whose origin is "Client Royer &
Fils / VotreLogo.ca" — to the cent. That promo business is invoiced outside the
QC and MTL Books orgs, so it never appears in `invoices` (LUMEN: $1.5M in CRM,
zero invoice rows). It is synced into `zoho_accounts.ventes_*` and reported
*beside* the invoice figures, never added into `revenue_attributed` or
`revenue_lifetime`.

**Account sources must come from the data, never a picklist.** Accounts hold 26
distinct `origine_du_client` values against 21 live picklist entries. The orphans
include **"Publicité/Recherche Google" (108 accounts)** — the exact segment asked
about in the 2026-09-04 meeting. `get_zoho_account_filter_options` reads stored
values for this reason.

### Publicité: ad spend against revenue

The **Publicité** module (`/comptes/publicite`, admin-only) compares Google Ads and Meta Ads spend
with the revenue of the accounts attributed to each channel. Only those two channels. Setup and
credentials: **`docs/ADVERTISING.md`**.

- **`ad_spend_daily`** holds daily × campaign spend, written only by `ads-spend-sync` (cron every
  4 h). Each run **re-pulls the last 35 days** instead of walking a cursor, because both platforms
  restate recent spend; the PK `(platform, ad_account_id, campaign_id, spend_date)` makes that an
  idempotent upsert.
- **Admin-only at the row level** (`app_is_admin()` policy), not just hidden in the nav. The RPCs
  are SECURITY INVOKER, so a non-admin caller gets zero spend, not an error.
- **Channel ↔ source mapping is fixed** in `ad_channel_source_map()`:
  `Publicité/Recherche Google` → google, `Meta Ads` → meta. There is no `Google AdWords` value on
  Accounts (that one only exists on Leads).
- **Attribution is by channel and month of account creation, never per lead or per campaign** —
  the CRM stores no click identifiers. The campaign table therefore has no revenue column.
- **Origins only exist from a date** (`Publicité/Recherche Google` from 2026-02-16, `Meta Ads`
  regularly from 2024-08-21). `ad_source_first_used()` exposes it; `roas`/`net` are NULL when a
  period has no tagged accounts, and the page warns when a period starts before first use.
- **Campaign status comes from `ad_campaigns`**, refreshed from each platform's campaign list on
  every sync — never from `ad_spend_daily`, whose older rows are not re-synced.
- **Meta insights are requested one calendar month at a time**; a year of daily rows in one request
  fails with HTTP 500. Meta keeps 37 months of data; the API tier is `development_access`.
- **Open cohorts.** A month's revenue keeps accruing until its attribution window closes. Every
  RPC returns `window_ends_on`; `isCohortOpen()` in `components/advertising/channel.ts` marks those
  figures as provisional. Do not remove it — the most recent month is always open.

### Leads: which table is which

There are two lead tables, and picking the wrong one is the easiest mistake to
make here.

- **`zoho_leads`** — the real data, ~29k rows synced from Zoho CRM. `stage` says
  whether a row is a Lead or a Contact.
- **`leads`** — a legacy hand-entered archive: 192 rows, every one dated
  2026-01-01, untouched since May 2026. Nothing reads it any more. The
  `get_leads_*` RPCs still point at it and are equally dead; use the
  `get_zoho_lead*` ones.

Three things about `zoho_leads` that are not obvious from the schema:

- **`zoho_leads_unique` is for directories, not funnels.** It hides a converted
  lead behind the contact it became, so counting conversions through it gives
  ~99%. The dashboard reads the base table with `stage = 'lead'`.
- **Contacts are not leads.** Most were created directly in Zoho as clients and
  were never leads; including them inflates revenue several-fold.
- **Conversion needs two numbers.** Zoho marks 97% of leads converted, which says
  nothing. `leads_invoiced` — the lead's account actually being billed after the
  lead arrived — is the figure that moves. The two are nested: every invoiced
  lead is already flagged converted.

### Where a contact's source and service come from

Zoho's Contacts module has **no** `Lead_Source` and no service multiselect —
those fields exist only on Leads. So for a contact both are resolved elsewhere,
in `zoho_leads_unique`, and the answer differs per field:

| | billed (`has_invoices`) | not billed |
|---|---|---|
| **source** | the account's `Origine_du_client` | the lead's own source, else the account's |
| **service** | the distinct `invoices.department` values | the lead's own service, else the account's |

`source_origin` / `service_origin` say which branch won (`own`, `lead`,
`account`, `invoice`) and drive the `*` marker in the table.

**Use `source_resolved` / `service_resolved` for anything user-facing, and for
filtering.** The raw `lead_source` / `service_interest` columns stay exactly what
Zoho's Leads module said, which for most contacts is nothing — filter on those
and the dropdown offers values that match zero rows.

Invoice departments keep Zoho Books' own wording (`DIST. PUBLICITAIRE SOLO`,
`NUMERIQUE`), deliberately **not** translated into the CRM's eight-value service
picklist: six department values against eight services, with no honest mapping
for `MULTI-ANNONCEURS` or `APPLICATION`. The cost is that the detail page's
Service filter offers both vocabularies. `zoho_service_labels` therefore spans
leads, accounts and invoices — but its label is pinned to the *leads* spelling
wherever the service appears there, so widening it cannot rename a dashboard bar.

None of this touches the funnel: the dashboard reads `zoho_leads` with
`stage = 'lead'`, and every rule above applies only to contacts.

Revenue comes in two flavours, both summed once per account so that several leads
on one account do not double-count: `revenue_attributed` (invoices dated on or
after the lead arrived) and `revenue_lifetime` (the account's whole history).

**Dates are counted on Montreal's calendar, not the database's.** The session
runs in UTC, so a bare `EXTRACT(MONTH FROM created_time)` or `created_time::date`
puts a lead created 31 January at 21:00 EST into February. Everything funnel-side
goes through `AT TIME ZONE 'America/Toronto'` (`zoho_leads_scoped`) or
`zoho_lead_local_date()`. Use the helper rather than a fresh `::date`.

**Filter values must come from `get_zoho_lead_filter_options`, never a hardcoded
list — and pass `p_stage`.** The options are drawn from `zoho_leads_unique`,
which is leads *and* contacts, while every dashboard figure counts leads only.
The dashboard and rep portal therefore ask for `p_stage => 'lead'`; the detail
page passes null because it genuinely lists both. Get this wrong and the dropdown
offers a rep who owns only contacts, and picking them empties the page.

Zoho's service picklist holds the same service under several spellings
differing only in case or spacing ("Distribution publicitaire" /
"Distribution Publicitaire", 2,209 leads between them). The RPC folds them via
`zoho_service_key()` and returns `service_variants` so a query can match every
spelling at once — the stored array keeps Zoho's original casing, and normalising
the table would just be overwritten by the next sync.

### Pages and Routes

| Route | Page | Purpose |
|---|---|---|
| `/comptes` | `AccountsDashboard` | Account cohorts by source/rep/service/domaine, monthly evolution vs last year, revenue attribution window |
| `/createurs` | `Createurs` | Admin-only. Who *created* each quote/invoice, vs who sold it. Never reconciles with rep figures — by design |
| `/comptes/detail` | `AccountsDetail` | Searchable client directory; a row opens its billing history by department and year |
| `/comptes/publicite` | `Advertising` | Admin-only. Google Ads + Meta spend against the revenue of the accounts tagged to each. Channel-level and monthly, never per lead |
| `/` | `Dashboard` | YTD KPIs, rep leaderboard, top clients, monthly targets |
| `/weekly` | `WeeklyDetail` | Week-by-week sales breakdown (pivot + line items) |
| `/quarterly` | `QuarterlyAverages` | YoY quarterly average deal size per rep |
| `/settings` | `Settings` | Manage reps, monthly objectives, fiscal quarters, webhook logs |

All routes are children of `Layout`, which provides the sidebar navigation.

The sidebar is two levels deep: a **section** (Équipe Affichez, Mon Portail,
Administration — text only, no icon) holds **modules** (Devis, Factures,
Comptes, Commissions, Objectifs), each with its own icon and its screens
underneath; a module with a single screen is a plain link instead. Both levels
collapse, `getSectionKey` / `getGroupKey` in `Layout.tsx` open the one a
navigation lands in, and Devis is open on a cold start. When you add a route,
add it to the tree, to `getGroupKey` if it belongs to a module, and to
`ROUTE_CHUNKS` in `src/lib/prefetch.ts`.

### Key Shared Abstractions

- **`src/lib/utils.ts`**: `cn()` (Tailwind class merger), `formatCurrencyCAD()`, `formatShortDate()`, `formatLongDate()`, `formatPercentage()`
- **`src/lib/csv.ts`** + **`src/components/ExportButton.tsx`**: CSV export for any table. Semicolon-delimited with a UTF-8 BOM because these files are opened in a French-locale Excel; numbers use a decimal comma and stay unquoted so they arrive as numbers. On a paginated table, pass `rows` as an async function that refetches without the page limit — exporting the visible 100 rows would answer a different question from the one on screen.
- **`src/lib/constants.ts`**: `DEPARTMENTS`, `MONTHS`, `OFFICES`, `SALE_STATUSES` — used as filter option sources across all pages
- **`src/types/database.ts`**: TypeScript types mirroring Supabase view/RPC return shapes (`SommaireRow`, `ZoneA_SummaryRow`, `ZoneB_DetailRow`, `YoYRow`, etc.)
- **`src/components/FilterBar.tsx`**: `<FilterBar>` / `<FilterGroup>` composable filter bar used on every page
- **`src/components/Select.tsx`**: Reusable styled dropdown with an `accent` variant (brand orange)
- **`src/hooks/useSort.ts`**: Generic column sort hook used in data tables

### Styling

**Tailwind CSS 4**, CSS-first. There is no `tailwind.config.js` and no
`postcss.config.js` — the theme is CSS, compiled by `@tailwindcss/vite`.
`src/index.css` loads, in this order:

1. `tailwindcss`
2. `branding/tokens/tokens.css` — every brand value as `:root` custom properties
3. `branding/tokens/tailwind-v4.css` — those values as utilities, plus the brand base layer
4. the app's own additions, then `@layer components`

Fonts come from `index.html` (Inter, plus the 400 italic cut of Inria Serif).

App-level helpers in `src/index.css` `@layer components`: `.card`, `.badge`,
`.th`, `.td`, `.form-input`, `.link`, and `.btn` + `.btn-{xs,sm,md,lg}` +
`.btn-{primary,secondary,dark,ghost,danger,quiet}`. The brand kit adds
`.eyebrow`, `.label-caps`, `.accent-serif` and `.tnum`. Use `cn()` from
`src/lib/utils.ts` for conditional class merging (wraps `clsx` + `tailwind-merge`).

## Brand (2026 — affichez.ca)

Read `frontend/branding/brand-guide.md` before building or restyling any UI.
The essentials:

- **Orange `#F5570E`** = action (primary button, links, active accents, logo).
  **Black** = headings, primary text, and emphasis — including a table's TOTAL
  row, which is a full-width black band. Type on an orange fill is **white**.
  The retired 2025 brand — `#e38800` as a brand orange, deep green `#154633`,
  Poppins, the uppercase swoosh wordmark — must not appear anywhere. `#E38800`
  survives only as `--tone-warn`, the amber status colour.
- **Inter** everywhere. Headings and every uppercase label are **600**, never
  700; 700 is kept for figures — money, counts, totals — where it is data
  hierarchy rather than the heading voice. One accent word per display heading
  in **Inria Serif italic**: write `*word*` in the copy and render with
  `<Accented>` (`src/components/Accented.tsx`). Used on the login screen only.
- Buttons, inputs, selects and tabs are **10px radius** (`rounded-md`), never
  pills; cards are `rounded-xl` (16px); menus and popovers `rounded-lg` (12px).
  Pills are for chips, tags, avatars, badges and progress tracks only.
- Page ground is **sand**; app chrome (sidebar, headers) and cards are white.
  `shadow-card` already carries a 1px hairline ring — do not add a `border`
  beside it.
- **One orange thing per screen.** Orange never marks status, severity, or a
  value in a data column — pick a `--tone-*` for status and ink for emphasis.
- **No hex values in component code.** Everything comes from
  `branding/tokens/tokens.css`. No gradients, glows, or decorative blobs — the
  brand is flat colour and type.
- Logo only through `src/components/Logo.tsx`, which serves the real files from
  `public/brand/`. Heights: 22 dense toolbar, 24 sidebar, 28–30 page chrome.

### The data palette is not brand colour

`Tag`/`TagCell` colours ~45 picklist values (sources, services, departments) by
hashing the label, which needs more distinguishable fills than the brand owns.
Those ten tones are declared separately in `src/index.css` as
`--color-data-1..10` and are **deliberately not** brand or status colours. Use
them for anything categorical: module identity, department badges, payroll
columns. Never use a `--tone-*` for a category or a `--color-data-*` for a
status.

### Rep names always carry a face

Anywhere a rep name is shown — filter dropdowns, leaderboards, tables, pickers,
the View switcher, the signed-in user row — it goes through `RepAvatar` /
`RepName` (`src/components/RepAvatar.tsx`). Never render a bare `{rep_name}`.

`src/lib/reps.ts` resolves a name to one of four things, in order:

| | when |
|---|---|
| the portrait | one of the nine in `public/reps/` |
| a group glyph | "Tous les reps", "Interne" — a label standing for several people |
| a building glyph | "Vente interne", "Magasin Affichez", "Zoho Books" — not a person |
| initials on a stable colour | everyone else |

**The nine portraits are the whole View list**, so every name a filter offers has
a real face. The ~60 other names in the data — former staff, CRM task owners,
invoice creators — reach only the initials branch. That is deliberate: a single
stock silhouette repeated sixty times removes the one thing an avatar is for,
which is telling rows apart at a glance.

The initials colour comes from `dataToneIndex` in `src/lib/dataTone.ts`, the
same hash `TagCell` uses for service and source badges — one implementation, so
a rep without a photo is the same colour on every screen.

**It is a snapshot and it does not sync.** A rep added to `allowed_users`
appears in every dropdown immediately and silently falls back to initials. To
add a face: put the portrait in `assets/reps-source/` (outside `frontend/`, so
Vite neither serves nor bundles it), run `scratchpad/build_rep_photos.py` to cut
it square at 128x128, and add the name to `PHOTO_BY_NAME`. Do not serve the
768x768 originals — the whole nine-photo set is 23 KB at 128 and 574 KB at 768,
for something drawn between 20px and 48px.

Avatars are **not** lazy-loaded, on purpose: nine files totalling 23 KB are all
in cache after the first screen, and `loading="lazy"` only bought a visible
pop-in every time a dropdown opened.

### A rep off the sales team is "Interne", by name and by row

`src/lib/repTeam.ts` holds the one membership rule: the team is `allowed_users`
minus `INTERNAL_REP_NAMES`, and **every other name in the data is Interne** —
former staff, billing entities, CRM task owners. `useRepTeam()` exposes
`isInternal`, `display` (the name, or `Interne`) and `mergeInternalRows`, and
the list is fetched **once per session and shared** through
`useSyncExternalStore`, because table cells read it now and a per-component
fetch would be one request per avatar.

There used to be two definitions of "internal" and they disagreed on screen:
the rep filter's dynamic one, and a fixed six-name list each page grouped under
"Vente Interne" of its own accord. The Dashboard card also pinned that row as a
sixth entry numbered 6 while the "Voir tout" modal ranked it by amount — the
same group at two different ranks, with two reps missing from the card. Pages
now store the RPC's rows unchanged and merge in a `useMemo`:

```ts
const leaderboard = useMemo(() => mergeInternalRows(
    rawLeaderboard, repTeam, r => r.rep_name,
    r => ({ ...r, rep_name: INTERNAL_LABEL, office: '—' }),
    (acc, r) => ({ ...acc, total_amount: … , deal_count: … }),
).map(recomputeDerived).sort(…).map(rerank), [rawLeaderboard, repTeam]);
```

Merge the counts, **recompute** everything derived from them (`avg_deal`,
`completion_rate`, `revenue_per_account`, an average delay weighted by what
each row actually closed) — an average of averages is not the group's average —
then re-sort and re-rank, because one merged row lands in a different place.

`RepName` applies `display()` for you, so a name and its face can never
disagree; CSV exports map through `display()` too, since the file has to say
what the screen says.

**Three screens pass `literal` and name the person**: `/createurs` (its whole
subject is who typed a document, and most of those names are admin staff and
former employees — merging them would collapse the page into one line), Ma Paye
(a commission line belongs to one person and is keyed by that name), and the
signed-in user's own row and the rep pickers. Everywhere a rep's *numbers* are
reported, the merge applies.

### Component Patterns

Pages are self-contained — state, data fetching, filters, and rendering are colocated. Feature-specific sub-components live in `src/components/{feature}/` (e.g., `weekly/ZoneAPivotTable`, `dashboard/SommaireTable`).

The `Settings` page uses an internal tab system (`reps | objectives | quarters | logs`) with each section as a separate function component defined in the same file.

### No `any` Types
TypeScript's `no-any` rule is enforced. All Supabase RPC results must be typed against `src/types/database.ts`. Extend the types file when new RPC functions or views are added.
