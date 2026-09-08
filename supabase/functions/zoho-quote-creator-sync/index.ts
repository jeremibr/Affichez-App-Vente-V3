// supabase/functions/zoho-quote-creator-sync/index.ts
//
// Fills in who CREATED each quote, as opposed to who sold it.
//
// Asked for on 2026-09-04: Dominic wants the quotes Morgane and Guillaume typed
// in, including the ones where somebody else is the salesperson. Invoices need
// none of this — zoho-invoice-sync gets `created_by` free on the list payload.
// Quotes are the expensive half, and that is what this function exists for.
//
// Measured against the live Books API on 2026-09-07:
//
//   GET /estimates              → no creator field of any kind
//   GET /estimates/{id}         → created_by_id, a numeric id with no name
//   GET /users                  → id → name + email (133 in QC, 17 in MTL)
//
// So: one extra API call per quote, plus a user lookup. 7,960 quotes against
// Zoho's 100-calls-per-minute-per-organisation ceiling is roughly 80 minutes of
// API budget, which cannot happen in one 150s invocation. Each run therefore
// takes a bounded slice, paces itself under the ceiling, and leaves the rest
// marked 'pending'. Re-run, or let the cron job run, until pending hits zero.
//
// Same shape as zoho-books-customer-link, which solves the identical problem for
// a different field — and separate from zoho-sync on purpose, so a long-running
// back-fill can never delay or break the 5-minute quote sync that the dashboards
// depend on.
//
// Usage:
//   curl -X POST .../zoho-quote-creator-sync                    # one slice
//   curl -X POST .../zoho-quote-creator-sync -H 'x-max: 50'     # smaller slice
//   curl -X POST .../zoho-quote-creator-sync -H 'x-retry-errors: true'
//   curl      .../zoho-quote-creator-sync -H 'x-status-only: true'   # just report

const ORGS = [
  { id: Deno.env.get('ZOHO_ORG_ID_QC') ?? '48244978', office: 'QC' },
  { id: Deno.env.get('ZOHO_ORG_ID_MTL') ?? '815683274', office: 'MTL' },
];

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// Requests are killed at 150s. Stop at 110s so results can still be written and
// reported rather than lost.
const BUDGET_MS = 110_000;
// Zoho's ceiling is 100/min/org; 80 leaves room for zoho-sync (every 5 min) and
// zoho-invoice-sync (every 5 min), which share the quota.
const CALLS_PER_MIN = 80;
// Ceiling per org per run, in case Zoho answers unusually fast and the daily
// quota is the tighter constraint.
const DEFAULT_MAX_PER_ORG = 150;

// ─── Zoho auth ────────────────────────────────────────────────────────────────
// Shares the 'books' token row with zoho-invoice-sync and zoho-sync: Zoho
// throttles the refresh endpoint per refresh token, and a token lasts an hour.

const TOKEN_CACHE_KEY = 'books';
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
  if (!res.ok) return null; // a cache miss must never break the run
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
  await writeCachedToken(data.access_token, Number(data.expires_in) || 3600);
  return data.access_token;
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
// A sliding one-minute window, so a burst at the start of a run cannot push the
// org over Zoho's ceiling half a minute later.

class Pacer {
  private stamps: number[] = [];
  constructor(private readonly perMinute: number) {}

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 60_000 - (now - this.stamps[0]) + 50));
    }
  }
}

// ─── Books users ──────────────────────────────────────────────────────────────

interface BooksUser {
  user_id: string;
  office: string;
  name: string | null;
  email: string | null;
  status: string | null;
  rep_name: string | null;
}

/** email (lowercased) → app rep_name, so a creator carries the same name here as
 *  on every other page. Same source as the CRM syncs. */
async function loadRepMap(): Promise<Record<string, string>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/allowed_users?select=email,rep_name&rep_name=not.is.null`,
    { headers: SB_HEADERS },
  );
  const map: Record<string, string> = {};
  if (res.ok) {
    const rows = await res.json() as Array<{ email: string; rep_name: string }>;
    for (const r of rows) if (r.email && r.rep_name) map[r.email.toLowerCase()] = r.rep_name;
  }
  return map;
}

/**
 * Refreshes zoho_books_users and returns id → display name.
 *
 * Two calls per run, once per org, and worth it every time: a user added in Zoho
 * between runs would otherwise leave every quote they created showing an id.
 *
 * Zoho's own `name` is unreliable in the QC org — three different people are all
 * called "Alexandre" — so the app's rep_name (matched on email) wins where there
 * is one, and Zoho's name is the fallback.
 */
async function syncUsers(token: string, errors: string[]): Promise<Record<string, string>> {
  const repMap = await loadRepMap();
  const rows: BooksUser[] = [];

  for (const org of ORGS) {
    const res = await fetch(
      `https://www.zohoapis.com/books/v3/users?organization_id=${org.id}&per_page=200`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    if (!res.ok) {
      errors.push(`users(${org.office}): ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const body = await res.json();
    for (const u of (body.users ?? []) as Record<string, unknown>[]) {
      const email = (u.email as string)?.trim()?.toLowerCase() || null;
      rows.push({
        user_id: String(u.user_id),
        office: org.office,
        name: (u.name as string)?.trim() || null,
        email,
        status: (u.status as string) ?? null,
        rep_name: (email && repMap[email]) ? repMap[email] : ((u.name as string)?.trim() || null),
      });
    }
  }

  if (rows.length > 0) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/zoho_books_users?on_conflict=user_id`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(rows.map((r) => ({ ...r, synced_at: new Date().toISOString() }))),
    });
    if (!res.ok) errors.push('users upsert: ' + (await res.text()).slice(0, 200));
  }

  const byId: Record<string, string> = {};
  for (const r of rows) if (r.rep_name) byId[r.user_id] = r.rep_name;
  return byId;
}

// ─── The queue ────────────────────────────────────────────────────────────────

interface QuoteRow {
  zoho_id: string;
  office: string;
  quote_number: string | null;
}

/**
 * Newest first. A back-fill that runs for hours should make this year useful
 * before it gets to 2022 — Dominic's question is about current workload, and the
 * page is worth opening long before the walk finishes.
 */
async function fetchQueue(office: string, limit: number, retryErrors: boolean): Promise<QuoteRow[]> {
  const statuses = retryErrors ? '(pending,error)' : '(pending)';
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sales` +
      `?select=zoho_id,office,quote_number` +
      `&office=eq.${office}&creator_link_status=in.${statuses}` +
      `&order=sale_date.desc&limit=${limit}`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) throw new Error('queue fetch failed: ' + await res.text());
  return await res.json() as QuoteRow[];
}

async function updateQuote(
  zohoId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sales?zoho_id=eq.${encodeURIComponent(zohoId)}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify(patch),
  });
}

async function logSync(action: string, statusCode: number, message?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_log`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({
      action, status_code: statusCode, zoho_id: null, error_message: message ?? null,
    }),
  });
}

// ─── Resolution ───────────────────────────────────────────────────────────────

interface OrgResult {
  office: string;
  examined: number;
  linked: number;
  unresolved: number;
  errors: number;
}

async function processOrg(
  org: { id: string; office: string },
  token: string,
  userById: Record<string, string>,
  pacer: Pacer,
  maxPerOrg: number,
  deadline: number,
  retryErrors: boolean,
  errors: string[],
): Promise<OrgResult> {
  const result: OrgResult = { office: org.office, examined: 0, linked: 0, unresolved: 0, errors: 0 };
  const queue = await fetchQueue(org.office, maxPerOrg, retryErrors);

  for (const row of queue) {
    if (Date.now() > deadline) break;
    await pacer.take();
    result.examined++;

    try {
      const res = await fetch(
        `https://www.zohoapis.com/books/v3/estimates/${encodeURIComponent(row.zoho_id)}` +
          `?organization_id=${org.id}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );

      // 404/1002 means the estimate is gone from Zoho. Marking it 'error' rather
      // than leaving it pending is what stops the queue retrying a dead record
      // at one API call per run, for ever.
      if (res.status === 404) {
        await updateQuote(row.zoho_id, {
          creator_link_status: 'error', creator_link_error: 'not found in Zoho',
        });
        result.errors++;
        continue;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        await updateQuote(row.zoho_id, {
          creator_link_status: 'error', creator_link_error: `HTTP ${res.status}: ${body}`,
        });
        result.errors++;
        errors.push(`${row.quote_number ?? row.zoho_id}: ${res.status}`);
        continue;
      }

      const body = await res.json();
      const est = (body.estimate ?? {}) as Record<string, unknown>;
      const createdById = est.created_by_id ? String(est.created_by_id) : null;

      if (!createdById) {
        // Zoho genuinely has no creator on this record. 'linked' with a null
        // name, not 'error': there is nothing to retry, and leaving it pending
        // would make the back-fill look permanently unfinished.
        await updateQuote(row.zoho_id, {
          creator_link_status: 'linked', created_by_id: null, created_by_name: null,
          creator_link_error: null,
        });
        result.unresolved++;
        continue;
      }

      // An id with no matching user still gets stored: knowing WHICH unknown id
      // created a run of quotes is what lets someone go and look it up. The name
      // falls back to the id so the page never shows a blank.
      const name = userById[createdById] ?? `Utilisateur ${createdById}`;
      await updateQuote(row.zoho_id, {
        creator_link_status: 'linked',
        created_by_id: createdById,
        created_by_name: name,
        creator_link_error: null,
      });
      result.linked++;
    } catch (e) {
      result.errors++;
      errors.push(`${row.quote_number ?? row.zoho_id}: ${String(e).slice(0, 120)}`);
    }
  }

  return result;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type, x-max, x-retry-errors, x-status-only',
    },
  });
}

async function readStatus(): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_quote_creator_link_status`, {
    method: 'POST', headers: SB_HEADERS, body: '{}',
  });
  return res.ok ? (await res.json())[0] : { error: await res.text() };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return json({}, 200);

  if (req.headers.get('x-status-only') === 'true') {
    return json(await readStatus());
  }

  const maxPerOrg = Number(req.headers.get('x-max')) || DEFAULT_MAX_PER_ORG;
  const retryErrors = req.headers.get('x-retry-errors') === 'true';
  const deadline = Date.now() + BUDGET_MS;
  const errors: string[] = [];

  try {
    const token = await getAccessToken();
    const userById = await syncUsers(token, errors);

    // A pacer PER ORG, not one shared. Zoho's 100/min ceiling is per
    // organisation, so a single shared pacer would hold the whole run to 80
    // calls a minute across both and halve the throughput for no reason.
    //
    // The deadline is sliced the same way. The first run of this function spent
    // its entire budget on QC and reached MTL with nothing left - which, with
    // 7,852 QC quotes still queued, meant MTL would never have been touched at
    // all. Org i now gets its own share, and an org that empties its queue early
    // hands the remainder to the next one.
    const started = Date.now();
    const slice = BUDGET_MS / ORGS.length;

    const results: OrgResult[] = [];
    for (let i = 0; i < ORGS.length; i++) {
      const orgDeadline = i === ORGS.length - 1
        ? deadline                                  // last org takes what is left
        : Math.min(deadline, started + slice * (i + 1));
      results.push(await processOrg(
        ORGS[i], token, userById, new Pacer(CALLS_PER_MIN), maxPerOrg,
        orgDeadline, retryErrors, errors,
      ));
    }

    const status = await readStatus() as Record<string, number>;
    const done = (status?.quotes_pending ?? 1) === 0;

    await logSync('quote_creator_link', errors.length ? 500 : 200,
                  errors.length ? errors.join(' | ').slice(0, 500) : undefined);

    return json({
      results,
      users_cached: Object.keys(userById).length,
      status,
      done,
      note: done
        ? 'every quote resolved'
        : `${status?.quotes_pending ?? '?'} quotes still pending - run again`,
      errors: errors.slice(0, 10),
    });
  } catch (e) {
    await logSync('quote_creator_link', 500, String(e));
    return json({ error: String(e) }, 500);
  }
});
