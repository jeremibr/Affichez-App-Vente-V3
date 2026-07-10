# Rapport hebdomadaire — Mandats signés

Team-wide "signed mandates" email, sent **right after** the sales report every
Friday at 17:00 (same n8n workflow). Unlike the sales report (which goes to the
sales reps), this one goes to the **entire team**, so it leads with collective
wins — clients signed, new clients, departments activated — and **hides per-client
dollar amounts**.

**Flow:** the shared n8n workflow chains
`Schedule (Fri 17h) → sales HTTP → sales Gmail (reps) → mandates HTTP → mandates Gmail (whole team)`.
See `../weekly-sales-report/n8n-workflow.json`.

## Endpoint

```
https://auyfucbskylougsmmrks.supabase.co/functions/v1/weekly-mandates-report
```

- `GET /` → JSON `{ subject, html, week_start, week_end, week_range, total_clients, new_clients, week_total }`
- `GET /?preview=1` → raw HTML
- `GET /?week_start=YYYY-MM-DD` → a specific week (defaults to the latest, same week as the sales email)

## What it shows

- **Hero:** number of clients who signed this week + week range + aggregate total, new-client count, departments activated, vs previous week.
- **Départements activés:** colored cards, one per department, with # of clients (QC + MTL combined).
- **🏆 Mandat vedette:** the biggest mandate (client + department chips, no dollar figure).
- **Client list:** every client once, with colored **department chip(s)** (multi-department clients get several) and a **Nouveau** badge for first-ever clients.

## Data

Backed by the `get_weekly_mandates(p_week_start)` RPC (`get_weekly_mandates.sql`,
applied via migration `add_get_weekly_mandates`). "Signed" = won = `accepted` OR
`invoiced` (declined excluded), no office filter (QC + MTL combined), excluding
`excluded_clients` / `excluded_reps`. `is_new` = the client has no prior non-declined
sale before this week.

## Configuration

Same as the sales report — reuses the `REPORT_SECRET` and `APP_URL` function secrets.
The whole-team recipient is set on the Gmail node in n8n (`REPLACE_WITH_WHOLE_TEAM_EMAIL`).

## Deploy

```bash
supabase functions deploy weekly-mandates-report --no-verify-jwt
```
