# Rapport des ventes hebdomadaire

Weekly sales recap email, sent every Friday at 17:00 via n8n.

**Flow:** n8n Schedule (Fri 17h) → HTTP GET this function → the function returns
`{ subject, html }` → n8n Gmail node sends it from your address.

## Endpoint

```
https://auyfucbskylougsmmrks.supabase.co/functions/v1/weekly-sales-report
```

- `GET /` → JSON `{ subject, html, week_start, week_end, week_range, total, deals, previous_total, leaderboard }`
- `GET /?preview=1` → the raw HTML email (open in a browser to eyeball the design)
- `GET /?week_start=YYYY-MM-DD` → report a specific week instead of the latest

It reports the **most recent week** (Monday–Sunday) returned by `get_available_weeks`,
aggregates `v_weekly_summary` per rep, groups the internal reps into a single
**Vente Interne** line (same list as the app), and compares the week total to the
previous week. Reps at/over **25 000 $** get a highlight + the "Semaine à plus de 25 000 $" callout.

## Configuration (Supabase → Edge Functions → weekly-sales-report → Secrets)

| Secret | Required | Purpose |
|---|---|---|
| `REPORT_SECRET` | Recommended | If set, callers must send header `x-report-secret: <value>`. If unset, the endpoint is **open**. |
| `APP_URL` | Recommended | The URL the "Voir le rapport complet" button points to (your deployed app). Defaults to `https://app.affichez.ca`. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## n8n setup

1. Import `n8n-workflow.json` (Workflows → ⋯ → Import from File).
2. **Générer le rapport** node → replace `PASTE_YOUR_REPORT_SECRET_HERE` with the same
   value you set for `REPORT_SECRET`.
3. **Envoyer via Gmail** node → select your Gmail OAuth2 credential, and set the
   recipients in `sendTo` (pre-filled with `representants@affichez.ca`).
4. Activate the workflow. Cron `0 17 * * 5` = Fridays at 17:00 (n8n instance timezone).

## Deploy

```bash
supabase functions deploy weekly-sales-report --no-verify-jwt
```

(`--no-verify-jwt` because auth is handled by the `x-report-secret` header.)
