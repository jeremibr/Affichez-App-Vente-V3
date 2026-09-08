// supabase/functions/zoho-sync/index.ts
// Syncs Zoho Books estimates → Supabase sales table
// Incremental: pg_cron every 5 min, uses last_modified_time filter (fast, 0-10 records)
// Full sync:   manual button in Settings with x-full-sync: true header

const ORGS = [
  { id: Deno.env.get('ZOHO_ORG_ID_QC') ?? '48244978', office: 'QC' },
  { id: Deno.env.get('ZOHO_ORG_ID_MTL') ?? '815683274', office: 'MTL' },
];

const DEPT_MAP: Record<string, string> = {
  'MÉDIA MULTI-ANNONCEURS': 'MULTI-ANNONCEURS',
  'MULTI-ANNONCEURS': 'MULTI-ANNONCEURS',
  'PROMOTIONNEL': 'PROMOTIONNEL',
  'DIST. PUBLICITAIRE SOLO': 'DIST. PUBLICITAIRE SOLO',
  'AGENCE PUB': 'NUMERIQUE',
  'NUMÉRIQUE': 'NUMERIQUE',
  'NUMERIQUE': 'NUMERIQUE',
  'AGENCE WEB': 'APPLICATION',
  'APPLICATION': 'APPLICATION',
  'SERVICES IA': 'SERVICES IA',
  // Added 2026-09-07, mirroring zoho-invoice-sync. Found only because the
  // syncs stopped discarding records whose department they did not know:
  // Zoho Books has been billing under EVENEMENT since May 2025.
  'ÉVÈNEMENT': 'EVENEMENT',
  'ÉVÉNEMENT': 'EVENEMENT',
  'EVENEMENT': 'EVENEMENT',
  'ÉVENEMENT': 'EVENEMENT',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

/** Format a Date as Zoho's expected last_modified_time string: "2026-04-13T10:30:45+0000" */
function toZohoTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

// ─── Zoho Auth ────────────────────────────────────────────────────────────────

// Zoho throttles the OAuth refresh endpoint per refresh token, and every sync
// function shares one. Access tokens are valid an hour, so they are cached in
// zoho_oauth_token and reused across functions and invocations — only a miss
// costs a refresh. Renewed early so a token can never expire mid-run.
const TOKEN_CACHE_KEY = 'books';
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

  const clientId = Deno.env.get('ZOHO_CLIENT_ID')!;
  const clientSecret = Deno.env.get('ZOHO_CLIENT_SECRET')!;
  const refreshToken = Deno.env.get('ZOHO_REFRESH_TOKEN')!;
  const url = `https://accounts.zoho.com/oauth/v2/token` +
    `?refresh_token=${refreshToken}&client_id=${clientId}` +
    `&client_secret=${clientSecret}&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho token refresh failed: ' + JSON.stringify(data));
  // Zoho reports expires_in in seconds; default to the documented one hour.
  await writeCachedToken(data.access_token, Number(data.expires_in) || 3600);
  return data.access_token;
}

// ─── Supabase Helpers ─────────────────────────────────────────────────────────

async function upsertBatch(batch: object[]): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?on_conflict=zoho_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error('Supabase upsert failed: ' + await res.text());
}

async function declineBatch(zohoIds: string[]): Promise<void> {
  if (zohoIds.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?zoho_id=in.(${zohoIds.join(',')})`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ status: 'declined' }),
  });
  if (!res.ok) throw new Error('Supabase decline patch failed: ' + await res.text());
}

async function deleteBatch(zohoIds: string[]): Promise<void> {
  for (let i = 0; i < zohoIds.length; i += 50) {
    const chunk = zohoIds.slice(i, i + 50).map(encodeURIComponent).join(',');
    const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?zoho_id=in.(${chunk})`, {
      method: 'DELETE',
      headers: SB_HEADERS,
    });
    if (!res.ok) throw new Error('Supabase delete failed: ' + await res.text());
  }
}

/**
 * Ids of every sale a full sync is expected to see again, paged (a bare select is
 * capped at PostgREST's max_rows). Restricted to accepted/invoiced because a full sync
 * filters Zoho by those two statuses — declined rows are never returned and would
 * otherwise read as orphans and be deleted on every full sync.
 */
async function fetchOrphanCandidateIds(): Promise<string[]> {
  const ids: string[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/sales?select=zoho_id&status=in.(accepted,invoiced)` +
        `&order=zoho_id.asc&limit=${pageSize}&offset=${offset}`,
      { headers: SB_HEADERS },
    );
    if (!res.ok) throw new Error('Sale id lookup failed: ' + await res.text());
    const rows = await res.json() as Array<{ zoho_id: string }>;
    ids.push(...rows.map((r) => r.zoho_id));
    if (rows.length < pageSize) return ids;
  }
}

/**
 * Ask Zoho whether one estimate still exists, and with what status.
 * exists === null means the answer was inconclusive (401/429/500) — never act on it.
 */
async function checkEstimateExists(
  zohoId: string,
  accessToken: string,
): Promise<{ exists: boolean | null; status: string | null }> {
  for (const org of ORGS) {
    const res = await fetch(
      `https://www.zohoapis.com/books/v3/estimates/${zohoId}?organization_id=${org.id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.ok) {
      const data = await res.json();
      return { exists: true, status: String((data.estimate ?? {}).status ?? '') };
    }
    let code: number | null = null;
    try { code = Number((await res.json())?.code ?? NaN); } catch { /* non-JSON body */ }
    // 1002 = resource not found. Try the other org before concluding it is gone.
    if (res.status !== 404 && code !== 1002) return { exists: null, status: null };
  }
  return { exists: false, status: null };
}

async function logSync(action: string, statusCode: number, message?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_log`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ action, status_code: statusCode, zoho_id: null, error_message: message ?? null }),
  });
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
  // Fallback if table row missing for some reason
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

async function writeSyncState(key: string, ts: Date): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sync_state?on_conflict=key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, last_modified_time: ts.toISOString(), updated_at: new Date().toISOString() }),
  });
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-sync-source, x-full-sync, x-debug-id, x-dry-run, content-type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // ─ Debug single-record mode ─────────────────────────────────────────────────
  const debugId = req.headers.get('x-debug-id');
  if (debugId) {
    const debugOrg = req.headers.get('x-debug-org');
    try {
      const accessToken = await getAccessToken();
      const org = debugOrg ? (ORGS.find(o => o.office === debugOrg) ?? ORGS[0]) : ORGS[0];
      const res = await fetch(
        `https://www.zohoapis.com/books/v3/estimates/${debugId}?organization_id=${org.id}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const data = await res.json();
      return new Response(JSON.stringify(data.estimate ?? data, null, 2), {
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
  // Report which quotes orphan detection would remove, without removing them.
  const isDryRun = req.headers.get('x-dry-run') === 'true';
  const action = isManual
    ? (isFullSync ? 'sync_manual_full' : 'sync_manual')
    : 'sync_auto';

  let totalUpserted = 0;
  let totalDeleted = 0;
  let totalDeclined = 0;
  const errors: string[] = [];

  try {
    const accessToken = await getAccessToken();

    // Record sync start BEFORE calling Zoho so anything modified during this run
    // is picked up by the next run (no gap between runs).
    const syncStart = new Date();

    // Incremental: read last_modified_time from sync_state, pass to Zoho filter.
    // Full sync:   no time filter, Zoho returns all records, status filters applied.
    const lastModified = isFullSync ? null : await readSyncState('devis');

    const seenZohoIds = new Set<string>();

    // Full sync: filter by status to skip drafts/expired (much fewer pages).
    // Incremental: no status filter — last_modified_time catches all status changes.
    const statusFilters = isFullSync ? ['Accepted', 'Invoiced'] : [null];

    for (const org of ORGS) {
      for (const statusFilter of statusFilters) {
        let page = 1;
        let hasMore = true;

        while (hasMore) {
          const lastModParam = lastModified
            ? `&last_modified_time=${encodeURIComponent(toZohoTimestamp(lastModified))}`
            : '';
          const statusParam = statusFilter ? `&filter_by=Status.${statusFilter}` : '';
          const url = `https://www.zohoapis.com/books/v3/estimates` +
            `?organization_id=${org.id}&page=${page}&per_page=200${statusParam}${lastModParam}`;

          const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!response.ok) {
            errors.push(`${org.office} p.${page}: ${await response.text()}`);
            break;
          }

          const data = await response.json();
          const estimates: Record<string, unknown>[] = data.estimates ?? [];
          if (estimates.length === 0) break;

          const toUpsert: object[] = [];
          const toDecline: string[] = [];

          for (const est of estimates) {
            const rawStatus = ((est.status as string) ?? '').toLowerCase();
            const zohoId = String(est.estimate_id);
            seenZohoIds.add(zohoId);

            if (rawStatus === 'accepted' || rawStatus.includes('invoiced') || rawStatus.includes('paid')) {
              // An unrecognised department no longer throws the quote away.
              // The old `if (department)` meant an estimate whose department
              // Zoho reports under a name DEPT_MAP does not know vanished with
              // no error and no log. It now lands with a null department,
              // keeping Zoho's raw label, and is reported by
              // get_unmapped_department_summary so the mapping can be fixed.
              const deptLabel = (est.cf_d_partement ?? est.department) as string;
              const department = DEPT_MAP[deptLabel] ?? null;
              toUpsert.push({
                zoho_id: zohoId,
                sale_date: (est.cf_date_acceptation_unformatted as string) || (est.accepted_date as string) || (est.date as string),
                client_name: est.customer_name,
                amount: Math.round((Number(est.total) / 1.14975) * 100) / 100,
                quote_number: est.estimate_number,
                rep_name: (est.salesperson_name as string)?.trim() || null,
                zoho_department_label: deptLabel ? String(deptLabel) : null,
                department,
                office: org.office,
                status: rawStatus === 'accepted' ? 'accepted' : 'invoiced',
                // Deliberately NOT set here. The estimates list carries no
                // creator at all - only the detail endpoint does, and only as an
                // id - so filling it costs one API call per quote. That runs in
                // zoho-quote-creator-sync at its own pace; leaving the column
                // out of this upsert is what stops a re-sync wiping a name the
                // back-fill already paid for.
              });
            } else if (rawStatus === 'declined' || rawStatus === 'void') {
              toDecline.push(zohoId);
            }
          }

          if (toUpsert.length > 0) { await upsertBatch(toUpsert); totalUpserted += toUpsert.length; }
          if (toDecline.length > 0) { await declineBatch(toDecline); }

          hasMore = (data.page_context as Record<string, boolean>)?.has_more_page ?? false;
          page++;
        }
      }
    }

    // Orphan detection: only safe on a full sync that walked every Zoho page cleanly.
    // A mid-run Zoho error leaves seenZohoIds short, which reads as mass deletion —
    // bail out instead. Same guard for an implausibly large orphan set.
    if (isFullSync) {
      if (errors.length > 0) {
        errors.push('orphan detection skipped: Zoho paging was incomplete');
      } else {
        const existingIds = await fetchOrphanCandidateIds();
        const orphanIds = existingIds.filter(id => !seenZohoIds.has(id));
        const maxOrphans = Math.max(50, Math.floor(existingIds.length * 0.05));
        if (orphanIds.length > maxOrphans) {
          errors.push(
            `orphan detection skipped: ${orphanIds.length} of ${existingIds.length} rows unseen ` +
            `(limit ${maxOrphans}) — investigate before deleting`,
          );
        } else if (orphanIds.length > 0) {
          // "Unseen" is not the same as "gone". A full sync filters Zoho by Accepted
          // and Invoiced, so a quote that has since been declined or expired is absent
          // from seenZohoIds while still existing — deleting it loses the row for good,
          // because a later full sync will not fetch it back either. Ask Zoho about each
          // candidate and only delete what Zoho genuinely no longer has.
          for (const id of orphanIds) {
            const { exists, status } = await checkEstimateExists(id, accessToken);
            if (exists === null) {
              errors.push(`orphan check inconclusive for ${id} — left untouched`);
            } else if (exists === false) {
              if (!isDryRun) await deleteBatch([id]);
              totalDeleted++;
            } else if (status === 'declined' || status === 'void') {
              if (!isDryRun) await declineBatch([id]);
              totalDeclined++;
            } else {
              errors.push(`${id} still exists in Zoho as "${status}" — kept`);
            }
          }
        }
      }
    }

    // Persist the timestamp we used at the start of this run.
    // Skip on full sync so we don't overwrite the incremental pointer.
    if (!isFullSync) {
      await writeSyncState('devis', syncStart);
    }

    const durationMs = Date.now() - startTime;
    const result = {
      upserted: totalUpserted,
      deleted: isDryRun ? 0 : totalDeleted,
      declined: totalDeclined,
      orphans_found: totalDeleted,
      dry_run: isDryRun,
      errors,
      duration_ms: durationMs,
    };
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
