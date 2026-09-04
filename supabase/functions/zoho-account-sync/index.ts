// supabase/functions/zoho-account-sync/index.ts
// Syncs Zoho CRM Accounts → the Supabase zoho_accounts table.
//
// Only two fields matter here, and only because a Contact does not carry them:
// "Origine du client" and the service multiselect. Everything else about an
// account already reaches the app through invoices.
//
// Three ways in, matching zoho-lead-sync:
//   1. Webhook   — Zoho workflow rule POSTs {id} to this function.
//                  Requires the x-webhook-secret header. Syncs that one account.
//   2. Full sync — header `x-full-sync: true`. Walks the whole module in slices.
//   3. Incremental — default. If-Modified-Since since the last cursor.
//
// SEPARATE from zoho-lead-sync on purpose. That function is 740 lines of
// two-module walk, conversion handling and orphan reconciliation, and it carries
// a scar from deleting 39 live contacts; Accounts write to a different table with
// a different shape, so folding them in would mean threading a target table
// through mapRecord, upsertBatch, deleteBatch and reconcileStaleRows for no
// shared behaviour. Same shape, separate blast radius.
//
// SCOPE WARNING: the shared CRM refresh token is scoped to
// ZohoCRM.modules.leads.READ + ZohoCRM.modules.contacts.READ + ZohoCRM.users.READ.
// Reading Accounts additionally needs ZohoCRM.modules.accounts.READ. Check it
// with `x-check-scope: true` BEFORE scheduling this — a token without the scope
// returns 401 OAUTH_SCOPE_MISMATCH on every page and the walk silently does
// nothing.
//
// Unlike zoho-lead-sync this never deletes. An account removed in Zoho leaves a
// row nothing points at any more: zoho_leads_unique reaches it by
// account_id, so a dangling row contributes to no contact and costs one dead
// entry. That is a far better failure than the reverse, which is what cost those
// 39 contacts.

const CRM_ORG_ID = Deno.env.get('ZOHO_CRM_ORG_ID') ?? '48245615';
const WEBHOOK_SECRET = Deno.env.get('ZOHO_WEBHOOK_SECRET') ?? '';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// Zoho mangles the accents in "Intérêt pour quel service initialement" into
// underscores. Identical api_name on Leads and on Accounts, and — verified
// value-by-value on 2026-09-03 — an identical set of eight picklist values, so
// the two can share a column without translation.
const SERVICE_FIELD = 'Int_r_t_pour_quel_service_initialement';

const ACCOUNT_FIELDS = [
  'id', 'Account_Name', 'Origine_du_client', SERVICE_FIELD, 'Modified_Time',
].join(',');

// ~20.6k accounts at 200 a page is ~104 requests, comfortably inside one
// invocation. The slicing below is kept anyway: it costs nothing when the walk
// finishes first time and is the difference between a resumable sync and one
// that restarts forever if the org grows.
const FULL_SYNC_BUDGET_MS = 110_000;
const FULL_CURSOR_KEY = 'crm_accounts_full';
const INCREMENTAL_KEY = 'crm_accounts_incremental';
/** Stored in sync_state.cursor_token once the full walk has finished. */
const DONE_MARKER = 'DONE';

/** Zoho CRM expects ISO 8601 with an explicit offset, e.g. 2026-07-10T00:00:00+00:00 */
function toZohoCrmTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// ─── Zoho Auth ────────────────────────────────────────────────────────────────
// Shares the zoho_oauth_token cache (key 'crm') with zoho-lead-sync and
// zoho-task-sync: Zoho throttles the refresh endpoint per refresh token, and
// access tokens last an hour.

const TOKEN_CACHE_KEY = 'crm';
const TOKEN_SKEW_MS = 5 * 60 * 1000;

let memoToken: { token: string; expiresAt: number } | null = null;

function tokenIsFresh(expiresAt: number): boolean {
  return Date.now() < expiresAt - TOKEN_SKEW_MS;
}

async function readCachedToken(): Promise<string | null> {
  if (memoToken && tokenIsFresh(memoToken.expiresAt)) return memoToken.token;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/zoho_oauth_token?key=eq.${TOKEN_CACHE_KEY}` +
      `&select=access_token,expires_at`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return null; // a cache miss must never break the sync
  const rows = await res.json() as Array<{ access_token: string; expires_at: string }>;
  if (rows.length === 0) return null;
  const expiresAt = new Date(rows[0].expires_at).getTime();
  if (!tokenIsFresh(expiresAt)) return null;
  memoToken = { token: rows[0].access_token, expiresAt };
  return rows[0].access_token;
}

async function writeCachedToken(token: string, expiresInSec: number): Promise<void> {
  const expiresAt = new Date(Date.now() + expiresInSec * 1000);
  memoToken = { token, expiresAt: expiresAt.getTime() };
  await fetch(`${SUPABASE_URL}/rest/v1/zoho_oauth_token?on_conflict=key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      key: TOKEN_CACHE_KEY,
      access_token: token,
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

async function getAccessToken(): Promise<string> {
  const cached = await readCachedToken();
  if (cached) return cached;

  const clientId = Deno.env.get('ZOHO_CRM_CLIENT_ID') ?? Deno.env.get('ZOHO_CLIENT_ID')!;
  const clientSecret = Deno.env.get('ZOHO_CRM_CLIENT_SECRET') ?? Deno.env.get('ZOHO_CLIENT_SECRET')!;
  const refreshToken = Deno.env.get('ZOHO_CRM_REFRESH_TOKEN') ?? Deno.env.get('ZOHO_REFRESH_TOKEN')!;
  const url = `https://accounts.zoho.com/oauth/v2/token` +
    `?refresh_token=${refreshToken}&client_id=${clientId}` +
    `&client_secret=${clientSecret}&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho CRM token refresh failed: ' + JSON.stringify(data));
  await writeCachedToken(data.access_token, Number(data.expires_in) || 3600);
  return data.access_token;
}

// ─── Supabase writes ──────────────────────────────────────────────────────────

async function upsertBatch(batch: object[]): Promise<void> {
  if (batch.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/zoho_accounts?on_conflict=zoho_account_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error('Supabase upsert failed: ' + await res.text());
}

async function logSync(action: string, statusCode: number, zohoId?: string, message?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_log`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({
      action,
      status_code: statusCode,
      zoho_id: zohoId ?? null,
      error_message: message ?? null,
    }),
  });
}

// ─── Sync state ───────────────────────────────────────────────────────────────

async function readSyncState(key: string): Promise<Date> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?key=eq.${key}&select=last_modified_time`,
    { headers: SB_HEADERS },
  );
  if (res.ok) {
    const rows = await res.json() as Array<{ last_modified_time: string }>;
    if (rows.length > 0) return new Date(rows[0].last_modified_time);
  }
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

async function writeSyncState(key: string, ts: Date): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sync_state?on_conflict=key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, last_modified_time: ts.toISOString(), updated_at: new Date().toISOString() }),
  });
}

/** Position of an in-progress paginated walk, so a sliced full sync can resume it. */
async function readCursorToken(key: string): Promise<string | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?key=eq.${key}&select=cursor_token`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return null;
  const rows = await res.json() as Array<{ cursor_token: string | null }>;
  return rows.length > 0 ? rows[0].cursor_token : null;
}

async function writeCursorToken(key: string, token: string | null): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sync_state?on_conflict=key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      key,
      cursor_token: token,
      last_modified_time: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

// ─── Field mapping ────────────────────────────────────────────────────────────

interface ZohoLookup { name?: string; id?: string }

/** Zoho returns multiselects as string[], but a single value can arrive as a string. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}

/**
 * '-None-' is what Zoho stores in a picklist that was never set. Left as NULL so
 * a caller can COALESCE past it rather than having to know the sentinel — the
 * filter-options RPC already strips it defensively on the leads side.
 */
function pickOrNull(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s === '-None-') return null;
  return s;
}

function mapAccount(rec: Record<string, unknown>): object {
  // Account_Name is plain text on Accounts, unlike on Contacts where it is the
  // lookup pointing here.
  const name = rec.Account_Name;
  return {
    zoho_account_id: String(rec.id),
    account_name: typeof name === 'string'
      ? name
      : ((name as ZohoLookup | null)?.name ?? null),
    origine_du_client: pickOrNull(rec.Origine_du_client),
    service_interest: toStringArray(rec[SERVICE_FIELD]),
    modified_time: (rec.Modified_Time as string) || null,
    synced_at: new Date().toISOString(),
  };
}

// ─── Zoho fetching ────────────────────────────────────────────────────────────

async function fetchOne(id: string, token: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `https://www.zohoapis.com/crm/v8/Accounts/${id}` +
      `?fields=${encodeURIComponent(ACCOUNT_FIELDS)}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  );
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Zoho Accounts/${id} → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data?.[0] ?? null;
}

/**
 * Walks Accounts from `since` forward, upserting as it goes, and stops when the
 * module is exhausted or `deadline` passes — whichever comes first.
 *
 * Ordered by Modified_Time ascending with the page_token persisted after every
 * page, so a run cut short by the platform's 150s limit resumes where it stopped.
 * Tokens rather than timestamps because a page whose records share one
 * Modified_Time gives a timestamp cursor no way to advance without skipping.
 */
async function syncAccounts(
  token: string,
  since: Date | null,
  errors: string[],
  opts: { deadline?: number; cursorKey?: string } = {},
): Promise<{ upserted: number; complete: boolean }> {
  const { deadline, cursorKey } = opts;
  let upserted = 0;
  let hasMore = true;
  let complete = false;
  let page = 1;
  const MAX_PAGES = 400;

  let pageToken: string | null = cursorKey ? await readCursorToken(cursorKey) : null;
  if (pageToken === DONE_MARKER) pageToken = null;

  // Held constant for the whole walk — changing it would invalidate the token.
  const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${token}` };
  if (since) headers['If-Modified-Since'] = toZohoCrmTimestamp(since);

  while (hasMore && page <= MAX_PAGES) {
    if (deadline && Date.now() > deadline) break; // resume on the next invocation

    const pageParam = pageToken
      ? `&page_token=${encodeURIComponent(pageToken)}`
      : `&page=${page}`;
    const url = `https://www.zohoapis.com/crm/v8/Accounts` +
      `?fields=${encodeURIComponent(ACCOUNT_FIELDS)}` +
      `&per_page=200&sort_by=Modified_Time&sort_order=asc${pageParam}`;

    const res = await fetch(url, { headers });
    if (res.status === 304 || res.status === 204) { complete = true; break; }
    if (!res.ok) {
      const body = await res.text();
      // A stored token can be rejected if the query behind it changed. Restarting
      // the walk costs time but never loses records — the upserts are idempotent.
      if (pageToken && body.includes('TOKEN_BOUND_DATA_MISMATCH')) {
        pageToken = null;
        page = 1;
        if (cursorKey) await writeCursorToken(cursorKey, null);
        continue;
      }
      errors.push(`Accounts p.${page}: ${body.slice(0, 300)}`);
      break;
    }

    const data = await res.json();
    const records: Record<string, unknown>[] = data.data ?? [];
    if (records.length === 0) { complete = true; break; }

    await upsertBatch(records.map(mapAccount));
    upserted += records.length;

    const info = (data.info ?? {}) as Record<string, unknown>;
    hasMore = Boolean(info.more_records);
    pageToken = (info.next_page_token as string) ?? null;
    if (!pageToken) page++;

    if (cursorKey) await writeCursorToken(cursorKey, pageToken);

    if (!hasMore) { complete = true; break; }
    // Guard: more_records true but no token and a short page → stop rather than loop.
    if (hasMore && !pageToken && records.length < 200) break;
  }

  return { upserted, complete };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // `x-check-scope: true` answers the one question that decides whether any of
  // this works: does the shared CRM refresh token carry
  // ZohoCRM.modules.accounts.READ? It was issued for leads + contacts + users, so
  // the honest default assumption is no. Run this before scheduling the cron.
  if (req.headers.get('x-check-scope') === 'true') {
    try {
      const token = await getAccessToken();
      const res = await fetch(
        `https://www.zohoapis.com/crm/v8/Accounts?fields=Account_Name&per_page=1`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );
      const body = await res.text();
      return json({
        module: 'Accounts',
        status: res.status,
        readable: res.ok || res.status === 204,
        // 401 OAUTH_SCOPE_MISMATCH here means the refresh token must be reissued
        // with ZohoCRM.modules.accounts.READ added to the existing scopes.
        detail: body.slice(0, 400),
      }, 200);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── Webhook: one account by id ──
  // Zoho hits …/zoho-account-sync with the record id in the body.
  const recordId = await (async () => {
    if (req.method !== 'POST') return null;
    try {
      const body = await req.json();
      return (body?.id ?? body?.account_id ?? null) as string | null;
    } catch {
      return null;
    }
  })();

  if (recordId) {
    if (WEBHOOK_SECRET && req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
      await logSync('webhook_accounts', 401, recordId, 'bad secret');
      return json({ error: 'Unauthorized' }, 401);
    }
    try {
      const token = await getAccessToken();
      const rec = await fetchOne(recordId, token);
      if (!rec) {
        // Deliberately not a delete — see the header note. A vanished account is
        // left in place because nothing reads a row no contact points at.
        await logSync('webhook_accounts', 200, recordId, 'not found in Zoho; left as is');
        return json({ id: recordId, action: 'absent' });
      }
      await upsertBatch([mapAccount(rec)]);
      await logSync('webhook_accounts', 200, recordId);
      return json({ id: recordId, action: 'upserted' });
    } catch (e) {
      await logSync('webhook_accounts', 500, recordId, String(e));
      return json({ error: String(e) }, 500);
    }
  }

  // ── Full sync, in slices ──
  const isFull = req.headers.get('x-full-sync') === 'true'
    || url.searchParams.get('full') === 'true';
  const errors: string[] = [];
  const deadline = Date.now() + FULL_SYNC_BUDGET_MS;

  try {
    const token = await getAccessToken();

    if (isFull) {
      const done = await readCursorToken(FULL_CURSOR_KEY);
      if (done === DONE_MARKER && url.searchParams.get('restart') !== 'true') {
        return json({ mode: 'full', done: true, note: 'already complete; ?restart=true to walk again' });
      }
      if (url.searchParams.get('restart') === 'true') {
        await writeCursorToken(FULL_CURSOR_KEY, null);
      }

      // No If-Modified-Since: a full pass walks the entire module.
      const r = await syncAccounts(token, null, errors, { deadline, cursorKey: FULL_CURSOR_KEY });
      if (r.complete) {
        await writeCursorToken(FULL_CURSOR_KEY, DONE_MARKER);
        await writeSyncState(INCREMENTAL_KEY, new Date());
      }
      await logSync('accounts_full', errors.length ? 500 : 200, undefined,
                    errors.length ? errors.join(' | ').slice(0, 500) : undefined);
      return json({ mode: 'full', upserted: r.upserted, done: r.complete, errors });
    }

    // ── Incremental ──
    const since = await readSyncState(INCREMENTAL_KEY);
    const startedAt = new Date();
    const r = await syncAccounts(token, since, errors, { deadline });
    // Only advance the cursor on a clean pass; otherwise the next run re-covers
    // the same window rather than stepping over whatever failed.
    if (errors.length === 0) await writeSyncState(INCREMENTAL_KEY, startedAt);
    await logSync('accounts_incremental', errors.length ? 500 : 200, undefined,
                  errors.length ? errors.join(' | ').slice(0, 500) : undefined);
    return json({
      mode: 'incremental',
      since: since.toISOString(),
      upserted: r.upserted,
      org: CRM_ORG_ID,
      errors,
    });
  } catch (e) {
    await logSync('accounts_sync', 500, undefined, String(e));
    return json({ error: String(e) }, 500);
  }
});
