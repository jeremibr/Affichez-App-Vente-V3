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
- `supabase.rpc('function_name', params)` — for analytics (KPIs, summaries, leaderboards, YoY)
- `supabase.from('table').select(...)` — for CRUD in Settings (reps, objectives, quarters, webhook_log)

There is no service layer abstraction; Supabase calls are made directly inside page components using `useCallback`-wrapped async functions. Real-time subscriptions (Supabase Realtime) are set up in `useEffect` and cleaned up on unmount.

### Zoho Sync (Supabase Edge Functions)

`supabase/functions/` holds the Deno edge functions that pull from Zoho; the React
app only ever reads what they have written. Two different Zoho products are
involved and they do not share ids or credentials:

- **Zoho Books** (`zoho-sync`, `zoho-invoice-sync`) — two organisations, QC and
  MTL, feeding `quotes` and `invoices`.
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
| `/comptes` | `AccountsDashboard` | Account cohorts by source/rep/service/domaine, with the revenue attribution window |
| `/comptes/detail` | `AccountsDetail` | Searchable client directory; a row opens its billing history by department and year |
| `/` | `Dashboard` | YTD KPIs, rep leaderboard, top clients, monthly targets |
| `/weekly` | `WeeklyDetail` | Week-by-week sales breakdown (pivot + line items) |
| `/quarterly` | `QuarterlyAverages` | YoY quarterly average deal size per rep |
| `/settings` | `Settings` | Manage reps, monthly objectives, fiscal quarters, webhook logs |

All routes are children of `Layout`, which provides the sidebar navigation.

### Key Shared Abstractions

- **`src/lib/utils.ts`**: `cn()` (Tailwind class merger), `formatCurrencyCAD()`, `formatShortDate()`, `formatLongDate()`, `formatPercentage()`
- **`src/lib/csv.ts`** + **`src/components/ExportButton.tsx`**: CSV export for any table. Semicolon-delimited with a UTF-8 BOM because these files are opened in a French-locale Excel; numbers use a decimal comma and stay unquoted so they arrive as numbers. On a paginated table, pass `rows` as an async function that refetches without the page limit — exporting the visible 100 rows would answer a different question from the one on screen.
- **`src/lib/constants.ts`**: `DEPARTMENTS`, `MONTHS`, `OFFICES`, `SALE_STATUSES` — used as filter option sources across all pages
- **`src/types/database.ts`**: TypeScript types mirroring Supabase view/RPC return shapes (`SommaireRow`, `ZoneA_SummaryRow`, `ZoneB_DetailRow`, `YoYRow`, etc.)
- **`src/components/FilterBar.tsx`**: `<FilterBar>` / `<FilterGroup>` composable filter bar used on every page
- **`src/components/Select.tsx`**: Reusable styled dropdown with an `accent` variant (brand orange)
- **`src/hooks/useSort.ts`**: Generic column sort hook used in data tables

### Styling

- **Tailwind CSS** with a custom brand palette in `tailwind.config.js`:
  - `brand-main` = `#e38800` (orange) — primary accent, CTA buttons, active nav items
  - `brand-dark` = `#0f172a` — deep dark backgrounds
  - Font: `Inter` (not Poppins as in older docs — the `index.css` imports Inter)
  - Shadows: `shadow-card`, `shadow-card-hover`
- Global utility classes defined in `src/index.css` `@layer components`: `.card`, `.badge`, `.th`, `.td`
- Use `cn()` from `src/lib/utils.ts` for conditional class merging (wraps `clsx` + `tailwind-merge`)

### Branding Rules (from `docs/BRANDING.md` and `tailwind.config.js`)
- **Never** use default Tailwind color names (e.g., `text-blue-500`) for primary UI — use brand tokens
- `brand-main` (#e38800) for CTAs, active states, highlights
- All UI must feel premium: generous whitespace, smooth transitions, micro-interactions
- Long logo (`/logo-long.png`) in sidebar desktop; square logo (`/logo-square.jpg`) for mobile/favicons

### Component Patterns

Pages are self-contained — state, data fetching, filters, and rendering are colocated. Feature-specific sub-components live in `src/components/{feature}/` (e.g., `weekly/ZoneAPivotTable`, `dashboard/SommaireTable`).

The `Settings` page uses an internal tab system (`reps | objectives | quarters | logs`) with each section as a separate function component defined in the same file.

### No `any` Types
TypeScript's `no-any` rule is enforced. All Supabase RPC results must be typed against `src/types/database.ts`. Extend the types file when new RPC functions or views are added.
