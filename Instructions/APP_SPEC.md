# APP SPECIFICATION — Rapport des Devis Signés (Signed Quotes Report)

## Table of Contents

1. What This App Is
2. What It Replaces
3. Data Architecture
4. Zoho Books Integration
5. Database Schema Reference
6. Department System
7. Sales Rep System
8. UI Pages & Views
9. Data Aggregation Logic
10. Locale & Formatting Rules
11. Supabase Client Queries
12. Real-Time Subscriptions
13. Authentication
14. Edge Cases & Business Rules

---

## 1. What This App Is

A **sales reporting dashboard** for a Quebec-based advertising/media company. It tracks signed quotes (devis signés) from Zoho Books, broken down by sales rep, department, week, month, quarter, and year. It compares actuals against monthly objectives and provides year-over-year quarterly performance per rep.

The app is used internally by management to monitor sales team performance in real time.

**Language:** The UI is in **French (Quebec)**. All labels, months, currency formats are French-Canadian.

---

## 2. What It Replaces

A **Google Sheets workbook** with the following structure:

- **SOMMAIRE sheet** — Annual dashboard showing monthly revenue vs objectives, both as a grand total and broken down by 6 departments. Includes 2025 (last year) and 2026 (current year) columns for comparison.
- **Moyennes sheet** — Quarterly averages per sales rep, comparing current year vs prior year with a delta (RÉSULTAT).
- **52 weekly sheets** (one per week) — Each contains:
  - **Zone A (top):** A pivot summary table with rows = reps, columns = departments, values = sum of amounts for that week.
  - **Zone B (bottom):** Raw line-item data: date, client name, pre-tax amount, quote number, sales rep, department. **This was manually entered. The web app replaces this with automated Zoho Books sync.**

---

## 3. Data Architecture

```
Zoho Books
    │ Estimate accepted → webhook POST
    │ Estimate declined → webhook POST (delete)
    ▼
Supabase Edge Function (zoho-sync)
    │ Validates, maps department, resolves rep
    │ Upserts or deletes from sales table
    ▼
Supabase PostgreSQL
    │ DB trigger auto-computes week_start/week_end
    │ Generated columns: month, year
    │ Views auto-aggregate all data
    ▼
Web App (frontend)
    │ Reads from views & RPC functions
    │ Real-time subscriptions on sales table
    ▼
Dashboard UI
```

**The database is the single source of truth.** All aggregation is done via PostgreSQL views. The frontend does NOT compute totals — it reads pre-computed data from views and RPC functions.

---

## 4. Zoho Books Integration

The integration is already built (Edge Function + webhook setup). Here's what the frontend needs to know:

- **New sales records appear automatically** when quotes are accepted in Zoho Books.
- **Records disappear automatically** when quotes are declined.
- The `webhook_log` table tracks every webhook event for debugging.
- The Zoho custom field API name for department is `cf_d_partement`.
- Quote numbers follow the format: `SOUMQC-XXXXXX` (Quebec office) or `SOUMMTL-XXXXXX` (Montreal office).

**The frontend does NOT call Zoho APIs directly.** Everything flows through Supabase.

---

## 5. Database Schema Reference

### Tables

**`sales`** — Core data table. One row per signed quote.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| zoho_id | TEXT | Unique. Zoho estimate ID for dedup |
| sale_date | DATE | Date of the signed quote |
| client_name | TEXT | Company/client name |
| amount | NUMERIC(12,2) | Pre-tax amount in CAD |
| quote_number | TEXT | e.g. SOUMQC-025742 |
| rep_id | UUID | FK → reps.id |
| zoho_department_label | TEXT | Raw label from Zoho |
| department | department_enum | Resolved internal department |
| week_start | DATE | Auto-computed: Monday of that week |
| week_end | DATE | Auto-computed: Sunday of that week |
| month | INTEGER | Generated column from sale_date |
| year | INTEGER | Generated column from sale_date |

**`reps`** — Sales representatives.
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| name | TEXT | Unique. Must match Zoho exactly |
| office | office_enum | 'QC' or 'MTL' |
| is_active | BOOLEAN | Filter for current reps |

**`objectives`** — Monthly targets per department.
| Column | Type | Notes |
|--------|------|-------|
| year | INTEGER | |
| month | INTEGER | 1–12 |
| department | department_enum | |
| target_amount | NUMERIC(12,2) | Monthly objective in CAD |
| | | UNIQUE(year, month, department) |

**`department_mappings`** — Zoho label → internal enum mapping.

**`fiscal_quarters`** — Custom 13-week quarter boundaries.
| Column | Type | Notes |
|--------|------|-------|
| year | INTEGER | |
| quarter | INTEGER | 1–4 |
| start_date | DATE | First day of quarter |
| end_date | DATE | Last day of quarter |
| num_weeks | INTEGER | Always 13 |

**`webhook_log`** — Every Zoho webhook event.

### Views (all read-only, auto-computed)

| View | Replaces | Used For |
|------|----------|----------|
| `v_weekly_summary` | Zone A of weekly sheets | Weekly page: per rep per department per week |
| `v_weekly_dept_totals` | Totaux row of weekly sheets | Weekly page: department column totals |
| `v_weekly_grand_totals` | Weekly grand total | Weekly page: total for the entire week |
| `v_monthly_dept_totals` | SOMMAIRE Section B | Dashboard: monthly revenue per department |
| `v_monthly_grand_totals` | SOMMAIRE Section A | Dashboard: monthly grand total |
| `v_monthly_rep_totals` | (new) | Rep drill-down: monthly per rep per department |
| `v_sommaire` | SOMMAIRE with % atteint | Dashboard: monthly per dept with objective + % |
| `v_sommaire_grand_total` | SOMMAIRE total row | Dashboard: monthly grand total with objective + % |
| `v_quarterly_rep_averages` | Moyennes sheet | Quarterly page: average weekly per rep per quarter |
| `v_quarterly_yoy` | Moyennes YoY comparison | Quarterly page: current vs prior year + delta |

### RPC Functions (call via supabase.rpc())

| Function | Parameters | Returns | Used For |
|----------|-----------|---------|----------|
| `get_weekly_detail(p_week_start)` | DATE | Raw sales rows for that week | Weekly detail table (Zone B) |
| `get_available_weeks(p_year)` | INTEGER (optional) | List of weeks with totals | Week selector/navigator |
| `get_sommaire(p_year)` | INTEGER | Monthly dept data with objectives | Dashboard main grid |
| `get_sommaire_grand_total(p_year)` | INTEGER | Monthly totals across all depts | Dashboard total row |
| `get_quarterly_yoy(p_year)` | INTEGER | Rep quarterly averages with YoY | Quarterly comparison page |

---

## 6. Department System

There are exactly **6 departments**. This is the canonical list:

| Internal Enum Value | Display Name (FR) | Zoho Labels That Map To It |
|--------------------|--------------------|---------------------------|
| `MULTI-ANNONCEURS` | Multi-annonceurs | "MÉDIA MULTI-ANNONCEURS", "MULTI-ANNONCEURS" |
| `PROMOTIONNEL` | Promotionnel | "PROMOTIONNEL" |
| `DIST. PUBLICITAIRE SOLO` | Dist. publicitaire solo | "DIST. PUBLICITAIRE SOLO" |
| `NUMERIQUE` | Numérique | "AGENCE PUB", "NUMÉRIQUE" |
| `APPLICATION` | Application | "APPLICATION" |
| `SERVICES IA` | Services IA | "SERVICES IA" |

**Critical mapping:** "AGENCE PUB" in Zoho maps to "NUMERIQUE" internally. This is not a bug — the department was renamed but old quotes still carry the legacy label.

**Display order:** Always display departments in the order listed above. This matches the original Google Sheet column order.

---

## 7. Sales Rep System

### Current active reps:

| Name | Office | Quote Prefix |
|------|--------|-------------|
| Dominic Letendre | QC | SOUMQC- |
| Kim Foster Cunningham | QC | SOUMQC- |
| Paul Ayoub | MTL | SOUMMTL- |
| Simon Fortin Massé | QC | SOUMQC- |
| Sylvain Desrosiers | QC | SOUMQC- |
| Richard Courville | MTL | SOUMMTL- |
| Guillaume Montambeault | QC | SOUMQC- |
| Morgane Owczarzak | QC | SOUMQC- |

Rep names in the database must match Zoho salesperson names **exactly** (including accents, capitalization, spaces).

---

## 8. UI Pages & Views

The app needs **3 main pages** corresponding to the 3 Google Sheet sections:

### Page 1: SOMMAIRE (Dashboard) — Main landing page

**Top section: Annual grand total**
- A table with one row per month (Janvier → Décembre) + a Total row
- Columns: `Période | 2025 (reference) | 2026 (actual) | Objectif | % atteint`
- 2025 data is static reference data (can be stored in objectives or hardcoded for now)
- 2026 actual comes from `get_sommaire_grand_total(2026)`
- Color code % atteint: green ≥ 90%, yellow 50–89%, red < 50%

**Bottom section: Department breakdown**
- 6 sub-tables (one per department), same structure:
- Columns: `Période | 2025 | 2026 | Objectif | % atteint`
- Data comes from `get_sommaire(2026)`
- Each department table has its own Total row

**Key UX notes:**
- Year selector at the top (default: current year)
- All amounts in CAD, formatted Quebec-style (see Section 10)
- The SOMMAIRE should feel like a high-level executive dashboard
- Consider collapsible department sections or tabs

### Page 2: Weekly Detail — One view per week

**Top: Week selector**
- Dropdown or calendar-style navigator showing available weeks
- Data from `get_available_weeks(year)` — shows week range + total for quick scanning
- Format: "Semaine du 16 février au 22 février" (French date format)

**Middle: Zone A — Weekly summary pivot table**
- Rows: Each sales rep
- Columns: `Totaux | Multi-annonceurs | Promotionnel | Dist. publicitaire solo | Numérique | Application | Services IA`
- Values: Sum of amounts for that rep + department in the selected week
- Final row: Column totals across all reps
- Data from `v_weekly_summary` filtered by week_start

**Bottom: Zone B — Raw line items**
- Columns: `Date | Client | Total (avant taxes) | # Devis | Représentant | Département`
- Data from `get_weekly_detail(week_start)`
- Sorted by date, then rep name
- This is the detailed view showing every individual signed quote

**Key UX notes:**
- The week view should mirror the Google Sheet layout closely — users are familiar with it
- Zone A is the quick glance, Zone B is the drill-down
- Allow sorting/filtering on Zone B columns
- Print-friendly layout (management prints weekly reports)

### Page 3: Quarterly Averages (Moyennes) — Performance tracking

**Structure: 4 quarter blocks**
- Each quarter shows a table with:
  - Rows: Each active sales rep + a Totaux row
  - Columns: `Rep name | Current year avg | Previous year avg | Résultat (delta)`
- Data from `get_quarterly_yoy(year)`
- Résultat = current_avg - previous_avg
- Color code: green if positive (improvement), red if negative

**Key UX notes:**
- Year selector at top
- Quarters are custom 13-week periods (dates shown from fiscal_quarters table)
- Quarter labels should show date ranges: "Trimestre #1: 29 déc. 2025 au 29 mars 2026"

### Optional: Admin Page

- Edit monthly objectives per department
- Manage sales reps (add/deactivate)
- View webhook_log for debugging
- Trigger a manual Zoho re-sync if needed later

---

## 9. Data Aggregation Logic

**All aggregation is done by PostgreSQL views.** The frontend should NEVER manually sum or compute percentages. Here's the logic for reference/validation:

### Monthly totals
```
Month total for department X = SUM(amount) FROM sales WHERE year=Y AND month=M AND department=X
```

### Weekly summary (Zone A)
```
Cell value = SUM(amount) FROM sales WHERE week_start=W AND rep_id=R AND department=D
```

### % Atteint (achievement percentage)
```
% = (actual_amount / target_amount) * 100
If target = 0 → show 0%
```

### Quarterly weekly average
```
Rep quarterly avg = SUM(amount for all sales in quarter date range) / 13 (num_weeks)
```

### YoY comparison
```
Résultat = current_year_quarterly_avg - previous_year_quarterly_avg
```

### Week boundaries
```
week_start = Monday of the ISO week containing sale_date
week_end = week_start + 6 days (Sunday)
```

---

## 10. Locale & Formatting Rules

**The entire UI is in French (Quebec).** Apply these rules everywhere:

### Currency
- Format: `XXX XXX,XX $` (space as thousands separator, comma for decimals, $ after)
- Examples: `230 561,21 $` , `1 287 016,80 $` , `0,00 $`
- Negative amounts: `-1 421,82 $`
- All amounts are CAD (Canadian dollars), pre-tax (avant taxes)

### Percentages
- Format: `XX,XX %` (comma for decimals)
- Examples: `89,04 %` , `0,00 %`

### Dates
- Long format: `16 février 2026` (day month year, lowercase month)
- Short format: `16 févr. 2026`
- Week ranges: `Semaine du 16 février au 22 février`
- **Never** use English date formats (no "Feb 16, 2026")

### Month names (FR)
```
Janvier, Février, Mars, Avril, Mai, Juin,
Juillet, Août, Septembre, Octobre, Novembre, Décembre
```

### Quarter labels
```
Trimestre #1, Trimestre #2, Trimestre #3, Trimestre #4
```

---

## 11. Supabase Client Queries

Here's exactly how to query each view/function from the frontend:

### Dashboard (SOMMAIRE)
```typescript
// Monthly per department with objectives
const { data } = await supabase.rpc('get_sommaire', { p_year: 2026 });

// Monthly grand total with objectives
const { data } = await supabase.rpc('get_sommaire_grand_total', { p_year: 2026 });
```

### Weekly page
```typescript
// Get list of available weeks for navigator
const { data: weeks } = await supabase.rpc('get_available_weeks', { p_year: 2026 });

// Get Zone A summary for a specific week
const { data: summary } = await supabase
  .from('v_weekly_summary')
  .select('*')
  .eq('week_start', '2026-02-16');

// Get Zone A department totals
const { data: deptTotals } = await supabase
  .from('v_weekly_dept_totals')
  .select('*')
  .eq('week_start', '2026-02-16');

// Get Zone B raw line items
const { data: detail } = await supabase.rpc('get_weekly_detail', { p_week_start: '2026-02-16' });
```

### Quarterly page
```typescript
// Get YoY quarterly comparison
const { data } = await supabase.rpc('get_quarterly_yoy', { p_year: 2026 });

// Get quarter date ranges for labels
const { data: quarters } = await supabase
  .from('fiscal_quarters')
  .select('*')
  .eq('year', 2026)
  .order('quarter');
```

### Rep list
```typescript
const { data: reps } = await supabase
  .from('reps')
  .select('*')
  .eq('is_active', true)
  .order('name');
```

---

## 12. Real-Time Subscriptions

To make the dashboard update live when new quotes come in from Zoho:

```typescript
// Subscribe to sales table changes
const channel = supabase
  .channel('sales-changes')
  .on('postgres_changes', {
    event: '*',        // INSERT, UPDATE, DELETE
    schema: 'public',
    table: 'sales',
  }, (payload) => {
    // Refetch the relevant view data
    // The views auto-recompute, just re-query them
    refreshDashboard();
    refreshWeeklyView();
  })
  .subscribe();
```

**Important:** Real-time subscriptions require that Supabase Realtime is enabled on the `sales` table. This is configured in Supabase Dashboard → Database → Replication → enable `sales` table.

---

## 13. Authentication

- Use **Supabase Auth** for login
- All tables have RLS enabled: authenticated users can SELECT, only service_role can write
- The Edge Function uses service_role key (bypasses RLS)
- Frontend uses the anon key + user session
- Consider role-based access later: admin (edit objectives) vs viewer (read-only)

---

## 14. Edge Cases & Business Rules

1. **Negative amounts are valid.** A refund or credit note can result in a negative amount (e.g., -1 421,82 $). Display them normally with a minus sign.

2. **$0 weeks for a rep.** A rep may have zero sales in a given week. They should still appear in the quarterly averages with 0,00 $.

3. **New rep added mid-year.** Insert into `reps` table. They'll automatically appear in views with $0 for prior periods. No data migration needed.

4. **Department not found.** If a Zoho webhook sends an unknown department label, the Edge Function returns 400 and logs it to webhook_log. The frontend should surface webhook_log errors to admins.

5. **Duplicate webhook.** Zoho may fire the same webhook twice. The upsert on zoho_id handles this — no duplicates possible.

6. **Quote number format.** SOUMQC-XXXXXX = Quebec office, SOUMMTL-XXXXXX = Montreal office. This is informational only — the office is determined by the rep's office field, not the quote prefix.

7. **Fiscal quarters don't align with calendar months.** Q1 2026 starts Dec 29, 2025. The quarterly views use fiscal_quarters.start_date/end_date, not calendar quarters.

8. **All amounts are pre-tax (avant taxes).** Never apply tax calculations in the frontend.

9. **The year selector should support at minimum 2025 and 2026.** 2025 data is needed for YoY comparison. Future years will be added as objectives are set.

10. **Objectives are set once per year.** They rarely change. An admin page to edit them is nice-to-have but not critical for v1.

---

## File Inventory

| File | Purpose |
|------|---------|
| `supabase_migration_v2.sql` | Full database schema. Run in Supabase SQL Editor to create everything. |
| `zoho-sync-edge-function-v2.ts` | Supabase Edge Function. Receives Zoho webhooks, upserts/deletes sales. |
| `ZOHO_SUPABASE_SETUP_GUIDE.md` | Step-by-step to deploy Edge Function + configure Zoho workflow rules. |
| `APP_SPEC.md` (this file) | Complete app specification for building the frontend. |

---

## Summary for the AI Agent

You are building a **French-language sales dashboard** that reads from Supabase PostgreSQL. The database is already set up with all tables, views, and RPC functions. Data flows in automatically from Zoho Books via webhooks. Your job is to build the **frontend only**:

1. **Dashboard page** — Monthly revenue vs objectives grid, per department and grand total
2. **Weekly detail page** — Week selector + summary pivot table + raw line items table
3. **Quarterly page** — Per-rep weekly averages with YoY comparison across 4 quarters

All data comes from Supabase views and RPC functions. You do NOT compute aggregations. You format everything in Quebec French (currency, dates, percentages). The app should support real-time updates via Supabase subscriptions on the sales table.
