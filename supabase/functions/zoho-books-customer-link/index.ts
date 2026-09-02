// supabase/functions/zoho-books-customer-link/index.ts
//
// Resolves Zoho Books customers to the Zoho CRM accounts they belong to, which is
// what lets the Leads page show a contact's invoices.
//
//   invoice.customer_id ──▶ Books customer ──zcrm_account_id──▶ CRM account
//                                                                    ▲
//                                                      Contacts.Account_Name.id
//
// Only this middle hop needs an API call, and only once per customer: the id is
// cached in zoho_books_customers, and two DB triggers keep invoices.crm_account_id
// in step in both directions. So this function writes to the bridge table and
// nothing else.
//
// Why per customer rather than per account: 14,010 invoices name only ~3,100
// distinct customers, against 20,617 CRM accounts. Same answer, an order of
// magnitude fewer calls.
//
// Rate limits shape the whole design. Zoho Books allows 100 calls per minute per
// organization and, depending on plan, 1,000-10,000 per day — so the initial
// back-fill cannot finish in one run. Each invocation therefore takes a bounded
// slice, paces itself under the per-minute ceiling, and leaves the rest queued.
// Re-run (or let the cron job run) until `pending` reaches zero.
//
// Usage:
//   curl -X POST .../zoho-books-customer-link                 # one slice
//   curl -X POST .../zoho-books-customer-link -H 'x-retry-errors: true'
//   curl -X POST .../zoho-books-customer-link -H 'x-max: 50'  # smaller slice
//   curl      .../zoho-books-customer-link -H 'x-status-only: true'   # just report

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

// Requests are killed at 150s. Stop at 110s so the results can still be written
// and reported rather than lost.
const BUDGET_MS = 110_000;
// Zoho's ceiling is 100/min/org; 85 leaves room for zoho-invoice-sync, which
// shares the quota and may be running on its own 5-minute schedule.
const CALLS_PER_MIN = 85;
// Ceiling per org per run. The time budget usually bites first; this caps the
// damage if Zoho starts answering unusually fast and the daily quota is tight.
const DEFAULT_MAX_PER_ORG = 200;

// ─── Zoho auth ────────────────────────────────────────────────────────────────
// Shares the 'books' token row with zoho-invoice-sync: Zoho throttles the refresh
// endpoint per refresh token, and an access token is good for an hour.

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

// ─── Supabase helpers ─────────────────────────────────────────────────────────

interface QueueRow {
  books_customer_id: string;
  office: string;
  customer_name: string | null;
  link_status: string;
}

/** Adds any customer named by an invoice but not yet in the bridge table. */
async function enqueueFromInvoices(): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/enqueue_books_customers`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: '{}',
  });
  if (!res.ok) throw new Error('enqueue_books_customers failed: ' + await res.text());
  return Number(await res.json()) || 0;
}

async function fetchQueue(office: string, limit: number, retryErrors: boolean): Promise<QueueRow[]> {
  const statuses = retryErrors ? '(pending,error)' : '(pending)';
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/zoho_books_customers` +
      `?select=books_customer_id,office,customer_name,link_status` +
      `&office=eq.${office}&link_status=in.${statuses}` +
      // Oldest first so a run never re-reads the same head of the queue.
      `&order=synced_at.asc&limit=${limit}`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) throw new Error('queue fetch failed: ' + await res.text());
  return await res.json() as QueueRow[];
}

/**
 * One row shape for every outcome. PostgREST builds a single INSERT for a bulk
 * body and rejects it with PGRST102 ("All object keys must match") if the objects
 * differ in their keys — so a resolved row and an errored row must not be built
 * from different key sets. Nulls carry the difference instead.
 *
 * Overwriting crm_account_id with null on an error is safe: only 'pending' and
 * 'error' rows are ever queued, and neither has an account id to lose.
 */
function bridgeRow(fields: {
  books_customer_id: string;
  office: string;
  customer_name: string | null;
  crm_account_id?: string | null;
  crm_contact_id?: string | null;
  link_status: string;
  last_error?: string | null;
  resolved_at?: string | null;
}): object {
  return {
    books_customer_id: fields.books_customer_id,
    office: fields.office,
    customer_name: fields.customer_name,
    crm_account_id: fields.crm_account_id ?? null,
    crm_contact_id: fields.crm_contact_id ?? null,
    link_status: fields.link_status,
    last_error: fields.last_error ?? null,
    resolved_at: fields.resolved_at ?? null,
    synced_at: new Date().toISOString(),
  };
}

/**
 * Upsert, not patch: one request per 100 resolved customers instead of one per
 * customer. The SET list includes crm_account_id, so the propagation trigger
 * fires and the matching invoices are updated in the same statement.
 */
async function writeResolved(rows: object[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/zoho_books_customers?on_conflict=books_customer_id`,
      {
        method: 'POST',
        headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(chunk),
      },
    );
    if (!res.ok) throw new Error('bridge upsert failed: ' + await res.text());
  }
}

async function readLinkageStatus(): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_invoice_linkage_status`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: '{}',
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}

async function logSync(action: string, statusCode: number, message?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_log`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({
      action,
      status_code: statusCode,
      zoho_id: null,
      error_message: message ?? null,
    }),
  });
}

// ─── Pacing ───────────────────────────────────────────────────────────────────

/** Sliding window over the last minute, so we approach Zoho's ceiling without crossing it. */
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

// ─── Resolution ───────────────────────────────────────────────────────────────

interface OrgResult {
  office: string;
  examined: number;
  linked: number;
  unlinked: number;
  errors: number;
  rate_limited: boolean;
  stopped_on: 'queue_empty' | 'budget' | 'max' | 'rate_limit';
  error_samples: string[];
}

async function resolveOrg(
  org: { id: string; office: string },
  token: string,
  deadline: number,
  maxPerRun: number,
  retryErrors: boolean,
): Promise<OrgResult> {
  const result: OrgResult = {
    office: org.office,
    examined: 0,
    linked: 0,
    unlinked: 0,
    errors: 0,
    rate_limited: false,
    stopped_on: 'queue_empty',
    error_samples: [],
  };

  const queue = await fetchQueue(org.office, maxPerRun, retryErrors);
  if (queue.length === 0) return result;

  const pacer = new Pacer(CALLS_PER_MIN);
  const resolved: object[] = [];
  const now = () => new Date().toISOString();

  for (const row of queue) {
    if (Date.now() > deadline) { result.stopped_on = 'budget'; break; }
    if (result.examined >= maxPerRun) { result.stopped_on = 'max'; break; }

    await pacer.take();
    if (Date.now() > deadline) { result.stopped_on = 'budget'; break; }

    let res: Response;
    try {
      res = await fetch(
        `https://www.zohoapis.com/books/v3/contacts/${row.books_customer_id}` +
          `?organization_id=${org.id}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );
    } catch (err) {
      result.examined++;
      result.errors++;
      if (result.error_samples.length < 5) {
        result.error_samples.push(`${row.books_customer_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      resolved.push(bridgeRow({
        books_customer_id: row.books_customer_id,
        office: row.office,
        customer_name: row.customer_name,
        link_status: 'error',
        last_error: err instanceof Error ? err.message : String(err),
      }));
      continue;
    }

    result.examined++;

    // 429 is the per-minute or per-day ceiling. Stop this org entirely — every
    // further call would fail too — and leave the rest of the queue untouched so
    // the next run picks up exactly where this one left off.
    if (res.status === 429) {
      await res.body?.cancel();
      result.examined--;
      result.rate_limited = true;
      result.stopped_on = 'rate_limit';
      break;
    }

    const body = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body); } catch { /* non-JSON error body */ }

    if (res.status === 404 || Number(parsed.code) === 1002) {
      // Deleted in Zoho. Retrying will never help, so this is terminal.
      result.unlinked++;
      resolved.push(bridgeRow({
        books_customer_id: row.books_customer_id,
        office: row.office,
        customer_name: row.customer_name,
        link_status: 'unlinked',
        last_error: 'customer not found in Zoho Books',
        resolved_at: now(),
      }));
      continue;
    }

    if (!res.ok) {
      result.errors++;
      const msg = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      if (result.error_samples.length < 5) {
        result.error_samples.push(`${row.books_customer_id}: ${msg}`);
      }
      resolved.push(bridgeRow({
        books_customer_id: row.books_customer_id,
        office: row.office,
        customer_name: row.customer_name,
        link_status: 'error',
        last_error: msg,
      }));
      continue;
    }

    const contact = (parsed.contact ?? {}) as Record<string, unknown>;
    // Zoho sends "" rather than null for an unset id.
    const accountId = String(contact.zcrm_account_id ?? '').trim() || null;
    const contactId = String(contact.zcrm_contact_id ?? '').trim() || null;

    if (accountId) result.linked++; else result.unlinked++;
    resolved.push(bridgeRow({
      books_customer_id: row.books_customer_id,
      office: row.office,
      customer_name: (contact.contact_name as string) ?? row.customer_name,
      crm_account_id: accountId,
      crm_contact_id: contactId,
      link_status: accountId ? 'linked' : 'unlinked',
      resolved_at: now(),
    }));
  }

  if (resolved.length > 0) await writeResolved(resolved);
  return result;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-sync-source, x-max, x-retry-errors, x-status-only, x-org, content-type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  const isManual = req.headers.get('x-sync-source') !== 'cron';
  const statusOnly = req.headers.get('x-status-only') === 'true';
  const retryErrors = req.headers.get('x-retry-errors') === 'true';
  const orgFilter = req.headers.get('x-org')?.toUpperCase() ?? null;
  const maxPerOrg = Math.max(
    1,
    Math.min(1000, Number(req.headers.get('x-max')) || DEFAULT_MAX_PER_ORG),
  );
  const action = isManual ? 'link_books_customers_manual' : 'link_books_customers_auto';

  try {
    if (statusOnly) {
      return new Response(JSON.stringify({ status: await readLinkageStatus() }, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const discovered = await enqueueFromInvoices();
    const token = await getAccessToken();
    const deadline = startTime + BUDGET_MS;

    // The per-minute ceiling is per organization, so the two orgs are independent
    // and run together — halving the wall clock of the initial back-fill.
    const orgs = orgFilter ? ORGS.filter((o) => o.office === orgFilter) : ORGS;
    const results = await Promise.all(
      orgs.map((org) => resolveOrg(org, token, deadline, maxPerOrg, retryErrors)),
    );

    const status = await readLinkageStatus() as { customers_pending?: number } | null;
    const pending = status?.customers_pending ?? 0;

    const payload = {
      discovered,
      orgs: results,
      // The caller's cue to run again. The back-fill needs many passes.
      done: pending === 0,
      remaining: pending,
      status,
      duration_ms: Date.now() - startTime,
    };

    const notes = results
      .filter((r) => r.errors > 0 || r.rate_limited)
      .map((r) => `${r.office}: ${r.errors} errors${r.rate_limited ? ' (rate limited)' : ''}` +
        (r.error_samples.length ? ` — ${r.error_samples.join(' | ')}` : ''));
    await logSync(
      action,
      200,
      [`discovered=${discovered}`, `remaining=${pending}`, ...notes].join(' | '),
    );

    return new Response(JSON.stringify(payload, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync(action, 500, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
