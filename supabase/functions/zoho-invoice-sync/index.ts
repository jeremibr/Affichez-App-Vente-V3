// supabase/functions/zoho-invoice-sync/index.ts
// Syncs Zoho Books invoices + credit notes → Supabase invoices table
// Triggered by: manual button in Settings UI, or daily pg_cron job

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
};

// Only these statuses are revenue — everything else is excluded from the sync
const REVENUE_STATUS_MAP: Record<string, string> = {
  paid:          'paid',
  partiallypaid: 'partial',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// ─── Zoho Auth ────────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get('ZOHO_CLIENT_ID')!;
  const clientSecret = Deno.env.get('ZOHO_CLIENT_SECRET')!;
  const refreshToken = Deno.env.get('ZOHO_REFRESH_TOKEN')!;

  const url = `https://accounts.zoho.com/oauth/v2/token` +
    `?refresh_token=${refreshToken}` +
    `&client_id=${clientId}` +
    `&client_secret=${clientSecret}` +
    `&grant_type=refresh_token`;

  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho token refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

// ─── Supabase Helpers ─────────────────────────────────────────────────────────

async function upsertBatch(batch: object[]): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/invoices?on_conflict=zoho_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error('Supabase upsert failed: ' + await res.text());
}


async function logSync(action: string, statusCode: number, message?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_log`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ action, status_code: statusCode, zoho_id: null, error_message: message ?? null }),
  });
}

// ─── Field Extraction ─────────────────────────────────────────────────────────

function extractDept(record: Record<string, unknown>): { label: string; mapped: string } | null {
  const raw = (record.cf_d_partement ?? record.department ?? '') as string;
  const label = raw?.trim() ?? '';
  const mapped = DEPT_MAP[label.toUpperCase()] ?? DEPT_MAP[label] ?? null;
  if (!mapped) return null;
  return { label, mapped };
}

// ─── Fetch Invoices ───────────────────────────────────────────────────────────

async function syncInvoices(
  org: { id: string; office: string },
  accessToken: string,
  dateStart: string | null,
): Promise<{ upserted: number; errors: string[] }> {
  // Only ever sync Paid and PartiallyPaid — sent/overdue/void are not revenue
  const statusFilters = ['Paid', 'PartiallyPaid'];
  let upserted = 0;
  const errors: string[] = [];

  for (const statusFilter of statusFilters) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const dateParam = dateStart ? `&date_start=${dateStart}` : '';
      const url = `https://www.zohoapis.com/books/v3/invoices` +
        `?organization_id=${org.id}&page=${page}&per_page=200&filter_by=Status.${statusFilter}${dateParam}`;

      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) {
        errors.push(`${org.office} invoices(${statusFilter}) p.${page}: ${await response.text()}`);
        break;
      }

      const data = await response.json();
      const invoices: Record<string, unknown>[] = data.invoices ?? [];
      if (invoices.length === 0) break;

      const toUpsert: object[] = [];

      for (const inv of invoices) {
        const rawStatus = ((inv.status as string) ?? '').toLowerCase().replace(/_/g, '');
        const mappedStatus = REVENUE_STATUS_MAP[rawStatus];
        if (!mappedStatus) continue; // safety guard

        const dept = extractDept(inv);
        if (!dept) continue;

        const amountHT = Math.round((Number(inv.total) / 1.14975) * 100) / 100;

        toUpsert.push({
          zoho_id: String(inv.invoice_id),
          invoice_number: inv.invoice_number,
          client_name: inv.customer_name,
          amount: amountHT,
          rep_name: (inv.salesperson_name as string)?.trim() || null,
          zoho_department_label: dept.label,
          department: dept.mapped,
          office: org.office,
          invoice_date: inv.date,
          status: mappedStatus,
          is_avoir: false,
        });
      }

      if (toUpsert.length > 0) { await upsertBatch(toUpsert); upserted += toUpsert.length; }

      hasMore = (data.page_context as Record<string, boolean>)?.has_more_page ?? false;
      page++;
    }
  }

  return { upserted, errors };
}

// ─── Fetch Credit Notes (Factures d'avoir) ────────────────────────────────────

async function syncCreditNotes(
  org: { id: string; office: string },
  accessToken: string,
  dateStart: string | null,
): Promise<{ upserted: number; errors: string[] }> {
  let page = 1;
  let hasMore = true;
  let upserted = 0;
  const errors: string[] = [];

  while (hasMore) {
    const dateParam = dateStart ? `&date_start=${dateStart}` : '';
    const url = `https://www.zohoapis.com/books/v3/creditnotes` +
      `?organization_id=${org.id}&page=${page}&per_page=200${dateParam}`;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      errors.push(`${org.office} creditnotes p.${page}: ${await response.text()}`);
      break;
    }

    const data = await response.json();
    const notes: Record<string, unknown>[] = data.creditnotes ?? [];
    if (notes.length === 0) break;

    const toUpsert: object[] = [];

    for (const note of notes) {
      const rawStatus = ((note.status as string) ?? '').toLowerCase();
      if (rawStatus === 'void') continue;

      const dept = extractDept(note);
      if (!dept) continue;

      // Negative amount — reduces net revenue automatically in SUM queries
      const amountHT = Math.round((Number(note.total) / 1.14975) * 100) / 100 * -1;

      toUpsert.push({
        zoho_id: String(note.creditnote_id),
        invoice_number: note.creditnote_number,
        client_name: note.customer_name,
        amount: amountHT,
        rep_name: (note.salesperson_name as string)?.trim() || null,
        zoho_department_label: dept.label,
        department: dept.mapped,
        office: org.office,
        invoice_date: note.date,
        status: 'avoir',
        is_avoir: true,
      });
    }

    if (toUpsert.length > 0) { await upsertBatch(toUpsert); upserted += toUpsert.length; }

    hasMore = (data.page_context as Record<string, boolean>)?.has_more_page ?? false;
    page++;
  }

  return { upserted, errors };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-sync-source, x-full-sync, content-type',
  };

  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  const isManual = req.headers.get('x-sync-source') !== 'cron';
  const isFullSync = req.headers.get('x-full-sync') === 'true';
  const action = isManual
    ? (isFullSync ? 'sync_invoices_manual_full' : 'sync_invoices_manual')
    : 'sync_invoices_auto';

  let totalUpserted = 0;
  const allErrors: string[] = [];

  try {
    const accessToken = await getAccessToken();
    const dateStart = isFullSync
      ? null
      : new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    for (const org of ORGS) {
      const invResult = await syncInvoices(org, accessToken, dateStart);
      totalUpserted += invResult.upserted;
      allErrors.push(...invResult.errors);

      const cnResult = await syncCreditNotes(org, accessToken, dateStart);
      totalUpserted += cnResult.upserted;
      allErrors.push(...cnResult.errors);
    }

    const durationMs = Date.now() - startTime;
    const result = { upserted: totalUpserted, errors: allErrors, duration_ms: durationMs };
    const logMsg = allErrors.length > 0 ? allErrors.join(' | ') : undefined;

    await logSync(action, 200, logMsg);

    return new Response(JSON.stringify(result), {
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
