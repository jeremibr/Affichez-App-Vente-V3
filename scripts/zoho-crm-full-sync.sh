#!/usr/bin/env bash
# Full re-sync of Zoho CRM Accounts, then Leads + Contacts, into the Supabase mirror.
#
#   bash scripts/zoho-crm-full-sync.sh
#
# When to run it: after any change in Zoho that alters what the API returns without
# modifying the records themselves. The scheduled syncs are incremental on Modified
# Time, so they never see such a change. The usual case is a picklist label renamed
# in a Global Set: every record now reads differently, none of them was "modified".
#
# Zoho is only read. Each call runs for up to about two minutes and reports
# "done": false until the walk is complete, so the script repeats it. Accounts take
# two calls, Leads + Contacts three. Total about eight minutes.
#
# Needs only the anon key in frontend/.env. No secret is printed.
set -u
cd "$(dirname "$0")/.." || exit 1

ANON="$(grep -E '^VITE_SUPABASE_ANON_KEY=' frontend/.env | cut -d= -f2- | tr -d '\r"')"
[ -n "$ANON" ] || { echo "ERROR: VITE_SUPABASE_ANON_KEY not found in frontend/.env"; exit 1; }
FN="https://auyfucbskylougsmmrks.supabase.co/functions/v1"
MAX_SLICES=40

is_done() { grep -q -E '"done": ?true' <<<"$1"; }
stamp()   { date -u +"%Y-%m-%d %H:%M:%SZ"; }
# A reply with no "done" key is an error object: repeating the call would repeat it.
abort_if_error() {
  if ! grep -q '"done"' <<<"$1"; then
    echo "STOP: the function did not report progress. Reply was:"; echo "$1" | head -c 800; echo
    exit 2
  fi
}

# ── Accounts ─────────────────────────────────────────────────────────────────
# A walk interrupted earlier resumes from its saved cursor; a finished one restarts.
echo "== $(stamp) Accounts, slice 1"
resp="$(curl -s -m 175 -X POST -H "Authorization: Bearer $ANON" "$FN/zoho-account-sync?full=true")"
if grep -q 'already complete' <<<"$resp"; then
  resp="$(curl -s -m 175 -X POST -H "Authorization: Bearer $ANON" "$FN/zoho-account-sync?full=true&restart=true")"
fi
echo "$resp" | head -c 400; echo
abort_if_error "$resp"
n=1
until is_done "$resp"; do
  n=$((n+1)); [ $n -gt $MAX_SLICES ] && { echo "ERROR: Accounts did not finish in $MAX_SLICES slices"; exit 3; }
  echo "== $(stamp) Accounts, slice $n"
  resp="$(curl -s -m 175 -X POST -H "Authorization: Bearer $ANON" "$FN/zoho-account-sync?full=true")"
  echo "$resp" | head -c 400; echo
  abort_if_error "$resp"
done
echo "== $(stamp) Accounts done in $n slice(s)"

# ── Leads + Contacts ─────────────────────────────────────────────────────────
n=0; resp=""
until is_done "$resp"; do
  n=$((n+1)); [ $n -gt $MAX_SLICES ] && { echo "ERROR: Leads did not finish in $MAX_SLICES slices"; exit 3; }
  echo "== $(stamp) Leads + Contacts, slice $n"
  resp="$(curl -s -m 175 -X POST -H "Authorization: Bearer $ANON" -H "x-sync-source: manual" -H "x-full-sync: true" "$FN/zoho-lead-sync")"
  echo "$resp" | head -c 500; echo
  abort_if_error "$resp"
done
echo "== $(stamp) Leads + Contacts done in $n slice(s)"
echo "== $(stamp) finished"
