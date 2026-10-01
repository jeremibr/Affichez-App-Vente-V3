#!/usr/bin/env bash
# Back-fill Google Ads spend for every configured Google ad account, one calendar
# year per call.
#
#   bash scripts/ads-google-backfill.sh            # 2020 to today
#   bash scripts/ads-google-backfill.sh 2023       # from 2023
#
# When to run it: after an ad account is added to GOOGLE_ADS_CUSTOMER_ID. The
# scheduled sync only re-reads the last 35 days, and the "Historique" walk in
# Paramètres is already marked complete for the accounts that existed before, so
# neither brings in the new account's past.
#
# Google only (x-platform: google), so Meta is not re-read and its rate limit is
# not touched. Upserts are idempotent: running it twice changes nothing.
#
# Needs only the anon key in frontend/.env. No secret is printed.
set -u
cd "$(dirname "$0")/.." || exit 1

ANON="$(grep -E '^VITE_SUPABASE_ANON_KEY=' frontend/.env | cut -d= -f2- | tr -d '\r"')"
[ -n "$ANON" ] || { echo "ERROR: VITE_SUPABASE_ANON_KEY not found in frontend/.env"; exit 1; }
FN="https://auyfucbskylougsmmrks.supabase.co/functions/v1/ads-spend-sync"

FIRST_YEAR="${1:-2020}"
THIS_YEAR="$(date +%Y)"
TODAY="$(date +%Y-%m-%d)"

for (( y = FIRST_YEAR; y <= THIS_YEAR; y++ )); do
  start="$y-01-01"
  end="$y-12-31"
  [ "$y" -eq "$THIS_YEAR" ] && end="$TODAY"
  echo "== $start .. $end"
  resp="$(curl -s -m 175 -X POST \
    -H "Authorization: Bearer $ANON" -H "x-sync-source: manual" -H "x-platform: google" \
    -H "x-date-start: $start" -H "x-date-end: $end" "$FN")"
  echo "$resp" | head -c 600; echo
  # A reply with no "upserted" key is an error object: stop rather than skip a year.
  if ! grep -q '"upserted"' <<<"$resp"; then
    echo "STOP: the function did not report an import for $y."; exit 2
  fi
  if ! grep -q '"errors": *\[\]' <<<"$resp"; then
    echo "STOP: $y finished with errors (see above). Fix them and run again from $y."; exit 3
  fi
done
echo "== finished"
