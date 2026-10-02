#!/usr/bin/env bash
# Back-fill Meta Ads spend for every configured Meta ad account, one calendar
# year per call.
#
#   bash scripts/ads-meta-backfill.sh            # the last 37 months
#   bash scripts/ads-meta-backfill.sh 2025       # from 2025
#
# From PowerShell, `bash` is WSL; use Git Bash:
#   & "C:\Program Files\Git\bin\bash.exe" scripts/ads-meta-backfill.sh
#
# When to run it: after an ad account is added to META_AD_ACCOUNT_ID. The
# scheduled sync only re-reads the last 35 days, and the "Historique" walk in
# Paramètres is already marked complete for the accounts that existed before, so
# neither brings in the new account's past.
#
# Meta keeps 37 months of insights. The function skips anything older, so the
# first year is simply clipped to what Meta still has.
#
# Meta only (x-platform: meta), so Google is not re-read. Upserts are
# idempotent: running it twice changes nothing.
#
# Needs only the anon key in frontend/.env. No secret is printed.
set -u
cd "$(dirname "$0")/.." || exit 1

ANON="$(grep -E '^VITE_SUPABASE_ANON_KEY=' frontend/.env | cut -d= -f2- | tr -d '\r"')"
[ -n "$ANON" ] || { echo "ERROR: VITE_SUPABASE_ANON_KEY not found in frontend/.env"; exit 1; }
FN="https://auyfucbskylougsmmrks.supabase.co/functions/v1/ads-spend-sync"

THIS_YEAR="$(date +%Y)"
FIRST_YEAR="${1:-$(( THIS_YEAR - 4 ))}"
TODAY="$(date +%Y-%m-%d)"

for (( y = FIRST_YEAR; y <= THIS_YEAR; y++ )); do
  start="$y-01-01"
  end="$y-12-31"
  [ "$y" -eq "$THIS_YEAR" ] && end="$TODAY"
  echo "== $start .. $end"
  resp="$(curl -s -m 175 -X POST \
    -H "Authorization: Bearer $ANON" -H "x-sync-source: manual" -H "x-platform: meta" \
    -H "x-date-start: $start" -H "x-date-end: $end" "$FN")"
  echo "$resp" | head -c 600; echo
  # A reply with no "upserted" key is an error object: stop rather than skip a year.
  if ! grep -q '"upserted"' <<<"$resp"; then
    echo "STOP: the function did not report an import for $y."; exit 2
  fi
  if ! grep -q '"errors": *\[\]' <<<"$resp"; then
    echo "STOP: $y finished with errors (see above). Fix them and run again from $y."; exit 3
  fi
  # Both accounts must be in the reply: one id means the secret was not updated,
  # or the function running is the one from before it could read a list.
  if ! grep -q '"meta_accounts": *\[[^]]*,' <<<"$resp"; then
    echo "NOTE: the function reports a single Meta ad account."
  fi
done
echo "== finished"
