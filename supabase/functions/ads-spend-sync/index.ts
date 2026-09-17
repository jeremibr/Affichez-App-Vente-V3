// supabase/functions/ads-spend-sync/index.ts
// Syncs daily per-campaign spend from Google Ads and Meta into ad_spend_daily,
// and each platform's current campaign list (name, status) into ad_campaigns.
//
// Modes:
//   (default)                    Rolling window: the last ADS_SYNC_ROLLING_DAYS days.
//   x-full-sync: true            Back-fill from ADS_SYNC_START_DATE, one month per
//                                call, resumable via sync_state. Repeat until done.
//   x-date-start / x-date-end    Explicit window.
//   x-check-scope: true          Probe both platforms' credentials; writes nothing.
//
// Spend is re-pulled on a rolling window rather than from a cursor because both
// platforms restate recent figures (invalid-click credits, late conversions).
// Upserts on the table's primary key make the re-pulls idempotent.
//
// Each platform is optional: a platform whose secrets are missing is skipped.

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

const GOOGLE_API_VERSION = Deno.env.get('GOOGLE_ADS_API_VERSION') ?? 'v25';
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_ADS_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_ADS_CLIENT_SECRET') ?? '';
const GOOGLE_REFRESH_TOKEN = Deno.env.get('GOOGLE_ADS_REFRESH_TOKEN') ?? '';
const GOOGLE_CUSTOMER_ID = digitsOnly(Deno.env.get('GOOGLE_ADS_CUSTOMER_ID') ?? '');
const GOOGLE_LOGIN_CUSTOMER_ID = digitsOnly(Deno.env.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID') ?? '');

const META_API_VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v25.0';
const META_ACCESS_TOKEN = Deno.env.get('META_ACCESS_TOKEN') ?? '';
const META_AD_ACCOUNT_ID = (Deno.env.get('META_AD_ACCOUNT_ID') ?? '').trim().replace(/^act_/i, '');

// 35 days covers Google's ~30-day invalid-click adjustment window.
const ROLLING_DAYS = Number(Deno.env.get('ADS_SYNC_ROLLING_DAYS') ?? '35');
// Meta keeps insights for 37 months; earlier dates return empty pages.
const FULL_SYNC_START = Deno.env.get('ADS_SYNC_START_DATE') ?? '2024-01-01';
const FULL_CURSOR_KEY = 'ads_spend_full';

function digitsOnly(v: string): string {
  return v.replace(/\D/g, '');
}

/** Today on Montreal's calendar; the UTC date is already tomorrow in the evening. */
function todayInMontreal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First day of the month `months` after the month of `iso`. */
function addMonths(iso: string, months: number): string {
  const [y, m] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Removes credentials from text that is returned to callers or written to
 * webhook_log. Fetch errors can include the request URL, and Meta request URLs
 * (including paging.next) carry access_token in the query string.
 */
function redact(text: string): string {
  let out = text.replace(/(access_token|refresh_token|client_secret)=[^&\s"')]+/gi, '$1=[redacted]');
  for (const secret of [META_ACCESS_TOKEN, GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_SECRET]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function errorText(e: unknown, max = 300): string {
  return redact(String(e)).slice(0, max);
}

// ─── Row shape ────────────────────────────────────────────────────────────────

interface SpendRow {
  platform: 'google' | 'meta';
  ad_account_id: string;
  campaign_id: string;
  campaign_name: string | null;
  campaign_status: string | null;
  spend_date: string;
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  leads: number;
  synced_at: string;
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

const BATCH = 500;

async function upsertSpend(rows: SpendRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ad_spend_daily?on_conflict=platform,ad_account_id,campaign_id,spend_date`,
      {
        method: 'POST',
        headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(rows.slice(i, i + BATCH)),
      },
    );
    if (!res.ok) throw new Error('ad_spend_daily upsert failed: ' + (await res.text()).slice(0, 400));
  }
  return rows.length;
}

type CampaignStatus = 'active' | 'paused' | 'removed' | 'unknown';

interface CampaignRow {
  platform: 'google' | 'meta';
  ad_account_id: string;
  campaign_id: string;
  campaign_name: string | null;
  status: CampaignStatus;
  platform_status: string | null;
  synced_at: string;
}

async function upsertCampaigns(rows: CampaignRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ad_campaigns?on_conflict=platform,ad_account_id,campaign_id`,
      {
        method: 'POST',
        headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(rows.slice(i, i + BATCH)),
      },
    );
    if (!res.ok) throw new Error('ad_campaigns upsert failed: ' + (await res.text()).slice(0, 400));
  }
  return rows.length;
}

/** Google ENABLED/PAUSED/REMOVED and Meta ACTIVE/PAUSED/DELETED/ARCHIVED to one vocabulary. */
function normalizeStatus(raw: string | null | undefined): CampaignStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'ENABLED':
    case 'ACTIVE':
      return 'active';
    case 'PAUSED':
      return 'paused';
    case 'REMOVED':
    case 'DELETED':
    case 'ARCHIVED':
      return 'removed';
    default:
      return 'unknown';
  }
}

async function logSync(action: string, statusCode: number, message?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_log`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ action, status_code: statusCode, zoho_id: null, error_message: message ?? null }),
  });
}

async function readCursor(key: string): Promise<string | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?key=eq.${key}&select=cursor_token`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return null;
  const rows = await res.json() as Array<{ cursor_token: string | null }>;
  return rows.length > 0 ? rows[0].cursor_token : null;
}

async function writeCursor(key: string, token: string | null): Promise<void> {
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

// ─── Google Ads ───────────────────────────────────────────────────────────────

const googleConfigured = () =>
  Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN && GOOGLE_CUSTOMER_ID);

let googleToken: { token: string; expiresAt: number } | null = null;

async function getGoogleToken(): Promise<string> {
  if (googleToken && Date.now() < googleToken.expiresAt - 60_000) return googleToken.token;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    // invalid_grant usually means the OAuth consent screen is still in "Testing",
    // where refresh tokens expire after 7 days.
    throw new Error('Google token refresh failed: ' + redact(JSON.stringify(data)).slice(0, 300));
  }
  googleToken = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return googleToken.token;
}

function googleHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  // No developer-token header: API access is granted to the Google Cloud project,
  // and the token is ignored by the API.
  // Only needed when the account is accessed through a manager (MCC) account.
  if (GOOGLE_LOGIN_CUSTOMER_ID) h['login-customer-id'] = GOOGLE_LOGIN_CUSTOMER_ID;
  return h;
}

async function googleSearch(query: string, token: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  let guard = 0;

  do {
    const res = await fetch(
      `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${GOOGLE_CUSTOMER_ID}/googleAds:search`,
      {
        method: 'POST',
        headers: googleHeaders(token),
        body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
      },
    );
    if (!res.ok) throw new Error(`Google: ${res.status} ${redact(await res.text()).slice(0, 400)}`);
    const data = await res.json();
    for (const r of (data.results ?? [])) out.push(r);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken && ++guard < 50);

  return out;
}

async function googleCurrency(token: string): Promise<string | null> {
  try {
    const rows = await googleSearch('SELECT customer.currency_code FROM customer LIMIT 1', token);
    return (rows[0]?.customer as { currencyCode?: string } | undefined)?.currencyCode ?? null;
  } catch {
    return null;
  }
}

/** REST responses use lowerCamelCase and encode int64 values as strings. */
async function syncGoogle(start: string, end: string, errors: string[]): Promise<SpendRow[]> {
  const rows: SpendRow[] = [];
  try {
    const token = await getGoogleToken();
    const currency = await googleCurrency(token);
    const now = new Date().toISOString();

    const results = await googleSearch(
      'SELECT campaign.id, campaign.name, campaign.status, segments.date, ' +
      'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions ' +
      `FROM campaign WHERE segments.date BETWEEN '${start}' AND '${end}'`,
      token,
    );

    for (const r of results) {
      const campaign = (r.campaign ?? {}) as { id?: string; name?: string; status?: string };
      const metrics = (r.metrics ?? {}) as Record<string, unknown>;
      const date = (r.segments as { date?: string } | undefined)?.date;
      if (!date || !campaign.id) continue;
      rows.push({
        platform: 'google',
        ad_account_id: GOOGLE_CUSTOMER_ID,
        campaign_id: String(campaign.id),
        campaign_name: campaign.name ?? null,
        campaign_status: campaign.status ?? null,
        spend_date: date,
        currency,
        // Unrounded: per-row rounding makes summed totals drift from Google's.
        spend: Number(metrics.costMicros ?? 0) / 1_000_000,
        impressions: Number(metrics.impressions ?? 0),
        clicks: Number(metrics.clicks ?? 0),
        conversions: Number(metrics.conversions ?? 0),
        leads: 0,
        synced_at: now,
      });
    }
  } catch (e) {
    errors.push(errorText(e));
  }
  return rows;
}

/** Every campaign in the account with its current status (no date segment). */
async function googleCampaigns(errors: string[]): Promise<CampaignRow[]> {
  try {
    const token = await getGoogleToken();
    const now = new Date().toISOString();
    const results = await googleSearch('SELECT campaign.id, campaign.name, campaign.status FROM campaign', token);
    const byId = new Map<string, CampaignRow>();
    for (const r of results) {
      const c = (r.campaign ?? {}) as { id?: string; name?: string; status?: string };
      if (!c.id) continue;
      byId.set(String(c.id), {
        platform: 'google',
        ad_account_id: GOOGLE_CUSTOMER_ID,
        campaign_id: String(c.id),
        campaign_name: c.name ?? null,
        status: normalizeStatus(c.status),
        platform_status: c.status ?? null,
        synced_at: now,
      });
    }
    return [...byId.values()];
  } catch (e) {
    errors.push(`campaigns: ${errorText(e)}`);
    return [];
  }
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

const metaConfigured = () => Boolean(META_ACCESS_TOKEN && META_AD_ACCOUNT_ID);

/** `lead` is Meta's roll-up of the specific lead action types; prefer it to avoid double counting. */
function metaLeadCount(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  const by = new Map<string, number>();
  for (const a of actions as Array<{ action_type?: string; value?: string }>) {
    if (a?.action_type) by.set(a.action_type, Number(a.value ?? 0) || 0);
  }
  if (by.has('lead')) return by.get('lead')!;
  return ['onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'leadgen_grouped']
    .reduce((n, t) => n + (by.get(t) ?? 0), 0);
}

function metaUrl(path: string, params: Record<string, string>): string {
  const qs = new URLSearchParams({ ...params, access_token: META_ACCESS_TOKEN });
  return `https://graph.facebook.com/${META_API_VERSION}/${path}?${qs}`;
}

async function metaCurrency(): Promise<string | null> {
  try {
    const res = await fetch(metaUrl(`act_${META_AD_ACCOUNT_ID}`, { fields: 'currency' }));
    if (!res.ok) return null;
    return (await res.json()).currency ?? null;
  } catch {
    return null;
  }
}

/** Meta rejects insights start dates older than 37 months (error 3018). */
const META_RETENTION_MONTHS = 37;

/** Oldest date Meta still answers for, with one day of margin. */
function metaEarliestDate(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - META_RETENTION_MONTHS);
  return addDays(d.toISOString().slice(0, 10), 1);
}

/**
 * Calendar-month sub-windows of [start, end]. A daily, campaign-level insights
 * query over a year times out on Meta's side (HTTP 500, code 1).
 */
function monthWindows(start: string, end: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let from = start;
  while (from <= end) {
    const to = minDate(addDays(addMonths(from, 1), -1), end);
    out.push([from, to]);
    from = addDays(to, 1);
  }
  return out;
}

class MetaApiError extends Error {
  rateLimited: boolean;
  constructor(message: string, rateLimited: boolean) {
    super(message);
    this.rateLimited = rateLimited;
  }
}

// Meta rate-limit error codes: application, user, page and ad-account level.
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80004]);
const META_RETRY_DELAYS_MS = [2_000, 8_000];

/** GET with a short retry on transient Meta errors (temporary 5xx, rate limits). */
async function metaGet(url: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return await res.json();

    const text = await res.text();
    let err: { code?: number; is_transient?: boolean } = {};
    try { err = JSON.parse(text)?.error ?? {}; } catch { /* non-JSON body */ }
    const rateLimited = META_RATE_LIMIT_CODES.has(err.code ?? -1);
    const transient = res.status >= 500 || rateLimited || Boolean(err.is_transient);

    if (transient && attempt < META_RETRY_DELAYS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, META_RETRY_DELAYS_MS[attempt]));
      continue;
    }
    throw new MetaApiError(`Meta: ${res.status} ${redact(text).slice(0, 400)}`, rateLimited);
  }
}

/**
 * Daily per-campaign insights (time_increment=1), one calendar month per request.
 * Dates older than Meta's retention are skipped: Meta has no data to return there.
 * A failed month is recorded and the rest continue, except on a rate limit, where
 * further requests would only fail the same way.
 */
async function syncMeta(start: string, end: string, errors: string[]): Promise<SpendRow[]> {
  const rows: SpendRow[] = [];
  const earliest = metaEarliestDate(todayInMontreal());
  const from = start < earliest ? earliest : start;
  if (from > end) return rows;

  const currency = await metaCurrency();
  const now = new Date().toISOString();

  for (const [since, until] of monthWindows(from, end)) {
    try {
      let url: string | null = metaUrl(`act_${META_AD_ACCOUNT_ID}/insights`, {
        level: 'campaign',
        fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions',
        time_range: JSON.stringify({ since, until }),
        time_increment: '1',
        limit: '500',
      });
      let guard = 0;

      while (url && guard++ < 200) {
        const data = await metaGet(url);
        for (const row of (data.data ?? []) as Array<Record<string, unknown>>) {
          const date = String(row.date_start ?? '');
          if (!date || !row.campaign_id) continue;
          const leads = metaLeadCount(row.actions);
          rows.push({
            platform: 'meta',
            ad_account_id: META_AD_ACCOUNT_ID,
            campaign_id: String(row.campaign_id),
            campaign_name: (row.campaign_name as string) ?? null,
            campaign_status: null,
            spend_date: date,
            currency,
            spend: Number(row.spend ?? 0),
            impressions: Number(row.impressions ?? 0),
            clicks: Number(row.clicks ?? 0),
            conversions: leads,
            leads,
            synced_at: now,
          });
        }
        // paging.next is a complete URL, access token and cursor included.
        url = ((data.paging as { next?: string } | undefined)?.next) ?? null;
      }
    } catch (e) {
      errors.push(`${since}..${until}: ${errorText(e)}`);
      if (e instanceof MetaApiError && e.rateLimited) break;
    }
  }
  return rows;
}

/**
 * Every campaign in the ad account with its configured status. The effective_status
 * filter is passed explicitly so archived campaigns, which can still carry
 * historical spend, are included. DELETED cannot be requested on this endpoint.
 */
async function metaCampaigns(errors: string[]): Promise<CampaignRow[]> {
  const rows: CampaignRow[] = [];
  try {
    const now = new Date().toISOString();
    let url: string | null = metaUrl(`act_${META_AD_ACCOUNT_ID}/campaigns`, {
      fields: 'id,name,status,effective_status',
      effective_status: JSON.stringify(['ACTIVE', 'PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES']),
      limit: '500',
    });
    let guard = 0;
    while (url && guard++ < 50) {
      const data = await metaGet(url);
      for (const c of (data.data ?? []) as Array<{ id?: string; name?: string; status?: string }>) {
        if (!c.id) continue;
        rows.push({
          platform: 'meta',
          ad_account_id: META_AD_ACCOUNT_ID,
          campaign_id: String(c.id),
          campaign_name: c.name ?? null,
          status: normalizeStatus(c.status),
          platform_status: c.status ?? null,
          synced_at: now,
        });
      }
      url = ((data.paging as { next?: string } | undefined)?.next) ?? null;
    }
  } catch (e) {
    errors.push(`campaigns: ${errorText(e)}`);
  }
  return rows;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

// The Settings page calls this function from the browser, so every response
// needs CORS headers and the preflight must be answered before any work starts.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, x-client-info, x-sync-source, x-full-sync, x-check-scope, x-date-start, x-date-end',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function checkScope(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    google: { configured: googleConfigured() },
    meta: { configured: metaConfigured() },
  };

  if (googleConfigured()) {
    try {
      const token = await getGoogleToken();
      const res = await fetch(
        `https://googleads.googleapis.com/${GOOGLE_API_VERSION}/customers/${GOOGLE_CUSTOMER_ID}/googleAds:search`,
        {
          method: 'POST',
          headers: googleHeaders(token),
          body: JSON.stringify({ query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1' }),
        },
      );
      out.google = {
        configured: true,
        api_version: GOOGLE_API_VERSION,
        status: res.status,
        ok: res.ok,
        detail: redact(await res.text()).slice(0, 500),
      };
    } catch (e) {
      out.google = { configured: true, ok: false, detail: errorText(e, 500) };
    }
  }

  if (metaConfigured()) {
    try {
      const res = await fetch(metaUrl(`act_${META_AD_ACCOUNT_ID}`, { fields: 'name,currency,account_status' }));
      out.meta = {
        configured: true,
        api_version: META_API_VERSION,
        status: res.status,
        ok: res.ok,
        detail: redact(await res.text()).slice(0, 500),
      };
    } catch (e) {
      out.meta = { configured: true, ok: false, detail: errorText(e, 500) };
    }
  }

  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  const url = new URL(req.url);

  if (req.headers.get('x-check-scope') === 'true') {
    try {
      return json(await checkScope());
    } catch (e) {
      return json({ error: errorText(e, 500) }, 500);
    }
  }

  if (!googleConfigured() && !metaConfigured()) {
    return json({ mode: 'unconfigured', google: false, meta: false, upserted: 0, errors: [] });
  }

  const startedAt = Date.now();
  const errors: string[] = [];
  const today = todayInMontreal();
  const isFull = req.headers.get('x-full-sync') === 'true';
  const headerStart = req.headers.get('x-date-start');

  try {
    let mode: 'explicit' | 'full' | 'rolling';
    let start: string;
    let end: string;

    if (headerStart) {
      mode = 'explicit';
      start = headerStart;
      end = req.headers.get('x-date-end') ?? today;
      if (!ISO_DATE.test(start) || !ISO_DATE.test(end) || start > end) {
        return json({ error: 'x-date-start / x-date-end must be YYYY-MM-DD with start <= end' }, 400);
      }
    } else if (isFull) {
      mode = 'full';
      const restart = url.searchParams.get('restart') === 'true';
      if (restart) await writeCursor(FULL_CURSOR_KEY, null);
      const cursor = restart ? null : await readCursor(FULL_CURSOR_KEY);
      if (cursor === 'DONE') {
        return json({ mode, done: true, note: 'already complete; ?restart=true to walk again' });
      }
      start = cursor ?? FULL_SYNC_START;
      end = minDate(addDays(addMonths(start, 1), -1), today);
    } else {
      mode = 'rolling';
      start = addDays(today, -ROLLING_DAYS);
      end = today;
    }

    const rows: SpendRow[] = [];
    if (googleConfigured()) rows.push(...await syncGoogle(start, end, errors));
    if (metaConfigured()) rows.push(...await syncMeta(start, end, errors));
    const upserted = await upsertSpend(rows);

    const campaignRows: CampaignRow[] = [];
    if (googleConfigured()) campaignRows.push(...await googleCampaigns(errors));
    if (metaConfigured()) campaignRows.push(...await metaCampaigns(errors));
    const campaigns = await upsertCampaigns(campaignRows);

    let done = true;
    if (mode === 'full') {
      // Advance only after a clean month, so a failure is retried rather than skipped.
      if (errors.length === 0) {
        const next = addMonths(start, 1);
        done = next > today;
        await writeCursor(FULL_CURSOR_KEY, done ? 'DONE' : next);
      } else {
        done = false;
      }
    }

    await logSync(
      `ads_spend_${mode}`,
      errors.length ? 500 : 200,
      errors.length ? errors.join(' | ').slice(0, 500) : undefined,
    );

    return json({
      mode,
      window: { start, end },
      done,
      upserted,
      campaigns,
      google: googleConfigured(),
      meta: metaConfigured(),
      duration_ms: Date.now() - startedAt,
      errors,
    });
  } catch (e) {
    await logSync('ads_spend_error', 500, errorText(e, 500));
    return json({ error: errorText(e, 500) }, 500);
  }
});
