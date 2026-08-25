// supabase/functions/zoho-task-sync/index.ts
// Syncs Zoho CRM Tasks → Supabase zoho_tasks table
// Incremental: pg_cron (~every 20 min), uses If-Modified-Since header (fast, few records)
// Full sync:   manual button with x-full-sync: true header (walks every task)
//
// NOTE: this hits Zoho *CRM* (zohoapis.com/crm/v8), a different product than the
// Zoho *Books* syncs (zoho-sync / zoho-invoice-sync).
// Credentials: it prefers CRM-specific secrets (ZOHO_CRM_CLIENT_ID / _SECRET /
// _REFRESH_TOKEN) but falls back to the existing Books secrets (ZOHO_CLIENT_ID /
// _SECRET / _REFRESH_TOKEN) when those aren't set — so you can reuse the Books
// OAuth credentials as long as the refresh token was granted a CRM read scope
// (ZohoCRM.modules.tasks.READ + ZohoCRM.users.READ). Verify with the x-check-scope
// header before relying on it (see handler below).

const CRM_ORG_ID = Deno.env.get('ZOHO_CRM_ORG_ID') ?? '48245615';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// Only these fields are pulled from Zoho (keeps the payload small).
const TASK_FIELDS = [
  'Subject', 'Status', 'Priority', 'Due_Date',
  'Created_Time', 'Modified_Time', 'Closed_Time',
  'Owner', 'What_Id', 'Who_Id', '$se_module',
].join(',');

/** Zoho CRM expects ISO 8601 with an explicit offset, e.g. 2026-07-10T00:00:00+00:00 */
function toZohoCrmTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// ─── Zoho Auth ────────────────────────────────────────────────────────────────

// Zoho throttles the OAuth refresh endpoint per refresh token, and every sync
// function shares one. Access tokens are valid an hour, so they are cached in
// zoho_oauth_token and reused across functions and invocations — only a miss
// costs a refresh. Renewed early so a token can never expire mid-run.
// Cached under its own key: the CRM secrets below may be a different refresh
// token, with a different scope, from the Books one the other syncs use.
const TOKEN_CACHE_KEY = 'crm';
const TOKEN_SKEW_MS = 5 * 60 * 1000;

/** Per-isolate copy, so a warm isolate skips even the PostgREST round trip. */
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
  // A cache miss must never break the sync — fall through to a live refresh.
  if (!res.ok) return null;
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

  // Prefer CRM-specific secrets; fall back to the Books secrets so the same
  // OAuth credentials can be reused when the refresh token carries CRM scope.
  const clientId = Deno.env.get('ZOHO_CRM_CLIENT_ID') ?? Deno.env.get('ZOHO_CLIENT_ID')!;
  const clientSecret = Deno.env.get('ZOHO_CRM_CLIENT_SECRET') ?? Deno.env.get('ZOHO_CLIENT_SECRET')!;
  const refreshToken = Deno.env.get('ZOHO_CRM_REFRESH_TOKEN') ?? Deno.env.get('ZOHO_REFRESH_TOKEN')!;
  const url = `https://accounts.zoho.com/oauth/v2/token` +
    `?refresh_token=${refreshToken}&client_id=${clientId}` +
    `&client_secret=${clientSecret}&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho CRM token refresh failed: ' + JSON.stringify(data));
  // Zoho reports expires_in in seconds; default to the documented one hour.
  await writeCachedToken(data.access_token, Number(data.expires_in) || 3600);
  return data.access_token;
}

// ─── Supabase Helpers ─────────────────────────────────────────────────────────

async function upsertBatch(batch: object[]): Promise<void> {
  if (batch.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/zoho_tasks?on_conflict=zoho_task_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error('Supabase upsert failed: ' + await res.text());
}

async function deleteBatch(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/zoho_tasks?zoho_task_id=in.(${taskIds.join(',')})`,
    { method: 'DELETE', headers: SB_HEADERS },
  );
  if (!res.ok) throw new Error('Supabase delete failed: ' + await res.text());
}

async function logSync(action: string, statusCode: number, message?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_log`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ action, status_code: statusCode, zoho_id: null, error_message: message ?? null }),
  });
}

/** email (lowercased) → app rep_name, so tasks line up with the rest of the app. */
async function loadRepMap(): Promise<Record<string, string>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/allowed_users?select=email,rep_name&rep_name=not.is.null`,
    { headers: SB_HEADERS },
  );
  const map: Record<string, string> = {};
  if (res.ok) {
    const rows = await res.json() as Array<{ email: string; rep_name: string }>;
    for (const r of rows) {
      if (r.email && r.rep_name) map[r.email.toLowerCase()] = r.rep_name;
    }
  }
  return map;
}

// ─── Sync State ───────────────────────────────────────────────────────────────

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

// ─── Field mapping ────────────────────────────────────────────────────────────

interface ZohoLookup { name?: string; id?: string; email?: string }

function mapTask(rec: Record<string, unknown>, repMap: Record<string, string>): object {
  const owner = (rec.Owner ?? {}) as ZohoLookup;
  const what = (rec.What_Id ?? rec.Who_Id ?? {}) as ZohoLookup;
  const email = (owner.email ?? '').toLowerCase();
  const repName = (email && repMap[email]) ? repMap[email] : (owner.name ?? null);
  const id = String(rec.id);

  return {
    zoho_task_id: id,
    subject: (rec.Subject as string) ?? null,
    rep_name: repName,
    rep_email: owner.email ?? null,
    status: (rec.Status as string) ?? null,
    priority: (rec.Priority as string) ?? null,
    due_date: (rec.Due_Date as string) || null,
    created_time: (rec.Created_Time as string) || null,
    modified_time: (rec.Modified_Time as string) || null,
    closed_time: (rec.Closed_Time as string) || null,
    related_module: (rec.$se_module as string) ?? null,
    related_name: what.name ?? null,
    zoho_crm_url: `https://crm.zoho.com/crm/org${CRM_ORG_ID}/tab/Tasks/${id}`,
    office: null,
  };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-sync-source, x-full-sync, x-debug-id, x-check-scope, content-type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // ─ Scope check ──────────────────────────────────────────────────────────────
  // Send header `x-check-scope: true` to verify the resolved credentials can read
  // CRM Tasks WITHOUT touching Supabase. Returns which credential set was used,
  // the HTTP status, and Zoho's raw body (e.g. OAUTH_SCOPE_MISMATCH if not scoped).
  if (req.headers.get('x-check-scope')) {
    const usingCrmSecrets = Boolean(Deno.env.get('ZOHO_CRM_REFRESH_TOKEN'));
    try {
      const token = await getAccessToken();
      const res = await fetch(
        `https://www.zohoapis.com/crm/v8/Tasks?fields=Subject&per_page=1`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );
      const body = await res.text();
      return new Response(JSON.stringify({
        credentials: usingCrmSecrets ? 'ZOHO_CRM_*' : 'ZOHO_* (Books, reused)',
        crm_status: res.status,
        crm_ok: res.ok,
        crm_access: res.ok || res.status === 204,
        body: body.slice(0, 800),
      }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({
        credentials: usingCrmSecrets ? 'ZOHO_CRM_*' : 'ZOHO_* (Books, reused)',
        error: String(err),
      }, null, 2), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  // ─ Debug single-record mode ─────────────────────────────────────────────────
  const debugId = req.headers.get('x-debug-id');
  if (debugId) {
    try {
      const accessToken = await getAccessToken();
      const res = await fetch(
        `https://www.zohoapis.com/crm/v8/Tasks/${debugId}?fields=${encodeURIComponent(TASK_FIELDS)}`,
        { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
      );
      const data = await res.json();
      return new Response(JSON.stringify(data.data?.[0] ?? data, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // ─ Normal sync ──────────────────────────────────────────────────────────────
  const startTime = Date.now();
  const isManual = req.headers.get('x-sync-source') !== 'cron';
  const isFullSync = req.headers.get('x-full-sync') === 'true';
  const action = isManual
    ? (isFullSync ? 'sync_tasks_manual_full' : 'sync_tasks_manual')
    : 'sync_tasks_auto';

  let totalUpserted = 0;
  let totalDeleted = 0;
  const errors: string[] = [];

  try {
    const accessToken = await getAccessToken();
    const repMap = await loadRepMap();

    // Record sync start BEFORE calling Zoho so records modified during this run
    // are picked up next time (no gap between runs).
    const syncStart = new Date();
    const lastModified = isFullSync ? null : await readSyncState('crm_tasks');

    const seenIds = new Set<string>();
    let pageToken: string | null = null;
    let page = 1;
    let hasMore = true;
    const MAX_PAGES = 200; // safety backstop (200 pages * 200 = 40k tasks)

    const baseHeaders: Record<string, string> = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    };
    // Incremental: only records modified since the cursor.
    if (lastModified) baseHeaders['If-Modified-Since'] = toZohoCrmTimestamp(lastModified);

    while (hasMore && page <= MAX_PAGES) {
      const pageParam = pageToken
        ? `&page_token=${encodeURIComponent(pageToken)}`
        : `&page=${page}`;
      const url = `https://www.zohoapis.com/crm/v8/Tasks` +
        `?fields=${encodeURIComponent(TASK_FIELDS)}` +
        `&per_page=200&sort_by=Modified_Time&sort_order=asc${pageParam}`;

      const response = await fetch(url, { headers: baseHeaders });

      // 304/204 = nothing modified since the cursor → done.
      if (response.status === 304 || response.status === 204) break;
      if (!response.ok) {
        errors.push(`p.${page}: ${await response.text()}`);
        break;
      }

      const data = await response.json();
      const records: Record<string, unknown>[] = data.data ?? [];
      if (records.length === 0) break;

      const toUpsert: object[] = [];
      for (const rec of records) {
        seenIds.add(String(rec.id));
        toUpsert.push(mapTask(rec, repMap));
      }
      await upsertBatch(toUpsert);
      totalUpserted += toUpsert.length;

      const info = (data.info ?? {}) as Record<string, unknown>;
      hasMore = Boolean(info.more_records);
      pageToken = (info.next_page_token as string) ?? null;
      if (!pageToken) page++;
      // Guard: more_records true but no token and a short page → stop rather than loop.
      if (hasMore && !pageToken && records.length < 200) break;
    }

    // Orphan detection: only safe on a full sync (we saw every task).
    if (isFullSync) {
      const existingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/zoho_tasks?select=zoho_task_id`, { headers: SB_HEADERS },
      );
      if (existingRes.ok) {
        const existing: { zoho_task_id: string }[] = await existingRes.json();
        const orphans = existing.map(r => r.zoho_task_id).filter(id => !seenIds.has(id));
        // Chunk deletes to keep the URL length sane.
        for (let i = 0; i < orphans.length; i += 100) {
          await deleteBatch(orphans.slice(i, i + 100));
        }
        totalDeleted += orphans.length;
      }
    }

    // Advance the incremental cursor to this run's start (skip on full sync).
    if (!isFullSync) await writeSyncState('crm_tasks', syncStart);

    const result = { upserted: totalUpserted, deleted: totalDeleted, errors, duration_ms: Date.now() - startTime };
    await logSync(action, 200, errors.length > 0 ? errors.join(' | ') : undefined);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync(action, 500, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
