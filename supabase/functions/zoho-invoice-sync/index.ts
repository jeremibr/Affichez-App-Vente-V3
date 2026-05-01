// supabase/functions/zoho-invoice-sync/index.ts
// Syncs Zoho Books invoices + credit notes → Supabase invoices table
// Incremental: pg_cron every 5 min, uses last_modified_time filter (fast, 0-10 records)
// Full sync:   manual button in Settings with x-full-sync: true header
//              Uses date.start=2025-01-01 so only 2025+ data is fetched (fits in 150s)

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

const STATUS_MAP: Record<string, string> = {
  paid:          'paid',
  partiallypaid: 'partial',
  sent:          'sent',
  overdue:       'overdue',
};

// Full sync window: 2025-01-01 — covers all app data, keeps the request well within 150s
const FULL_SYNC_DATE_START = '2025-01-01';

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

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get('ZOHO_CLIENT_ID')!;
  const clientSecret = Deno.env.get('ZOHO_CLIENT_SECRET')!;
  const refreshToken = Deno.env.get('ZOHO_REFRESH_TOKEN')!;
  const url = `https://accounts.zoho.com/oauth/v2/token` +
    `?refresh_token=${refreshToken}&client_id=${clientId}` +
    `&client_secret=${clientSecret}&grant_type=refresh_token`;
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

// ─── Field Extraction ─────────────────────────────────────────────────────────

function extractDept(record: Record<string, unknown>): { label: string; mapped: string } | null {
  // Try flat field first (invoices list returns cf_xxx inline)
  let raw = (record.cf_d_partement ?? record.department ?? '') as string;
  // Fallback: custom_fields array (credit notes use this format)
  if (!raw) {
    const fields = record.custom_fields as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(fields)) {
      const f = fields.find(
        (x) => x.api_name === 'cf_d_partement' || x.api_name === 'cf_departement' || x.label === 'Département',
      );
      raw = ((f?.value ?? f?.string_value ?? '') as string);
    }
  }
  const label = raw?.trim() ?? '';
  const mapped = DEPT_MAP[label.toUpperCase()] ?? DEPT_MAP[label] ?? null;
  if (!mapped) return null;
  return { label, mapped };
}

/** Batch-lookup dept from invoices table using credit note reference_number → invoice_number */
async function lookupDeptByInvoiceNumber(
  invoiceNumbers: string[],
  office: string,
): Promise<Map<string, { label: string; mapped: string }>> {
  if (invoiceNumbers.length === 0) return new Map();
  const nums = invoiceNumbers.map((n) => encodeURIComponent(n)).join(',');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/invoices?select=invoice_number,department,zoho_department_label&office=eq.${office}&invoice_number=in.(${nums})`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return new Map();
  const rows = await res.json() as Array<{ invoice_number: string; department: string; zoho_department_label: string }>;
  return new Map(rows.map((r) => [r.invoice_number, { label: r.zoho_department_label, mapped: r.department }]));
}

// ─── Sync Invoices ────────────────────────────────────────────────────────────

async function syncInvoices(
  org: { id: string; office: string },
  accessToken: string,
  lastModified: Date | null,
  statusOverride: string | null = null,
): Promise<{ upserted: number; errors: string[] }> {
  let upserted = 0;
  const errors: string[] = [];

  // Full sync: one Zoho request per status + date.start to stay within 150s limit.
  //   statusOverride → only that one status (use for targeted back-fills without re-fetching paid).
  // Incremental: no status filter — last_modified_time window is narrow; STATUS_MAP guards upsert.
  const statusFilters = lastModified === null
    ? (statusOverride ? [statusOverride] : ['Paid', 'PartiallyPaid', 'Sent', 'OverDue'])
    : [null];

  for (const statusFilter of statusFilters) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const lastModParam = lastModified
        ? `&last_modified_time=${encodeURIComponent(toZohoTimestamp(lastModified))}`
        : '';
      const statusParam = statusFilter ? `&filter_by=Status.${statusFilter}` : '';
      // Full sync: anchor to 2025-01-01 so we don't pull years of old invoices
      const dateParam = lastModified === null ? `&date.start=${FULL_SYNC_DATE_START}` : '';
      const url = `https://www.zohoapis.com/books/v3/invoices` +
        `?organization_id=${org.id}&page=${page}&per_page=200${statusParam}${lastModParam}${dateParam}`;

      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) {
        errors.push(`${org.office} invoices(${statusFilter ?? 'all'}) p.${page}: ${await response.text()}`);
        break;
      }

      const data = await response.json();
      const invoices: Record<string, unknown>[] = data.invoices ?? [];
      if (invoices.length === 0) break;

      const toUpsert: object[] = [];
      for (const inv of invoices) {
        const rawStatus = ((inv.status as string) ?? '').toLowerCase().replace(/_/g, '');
        const mappedStatus = STATUS_MAP[rawStatus];
        if (!mappedStatus) continue;
        const dept = extractDept(inv);
        if (!dept) continue;
        toUpsert.push({
          zoho_id: String(inv.invoice_id),
          invoice_number: inv.invoice_number,
          client_name: inv.customer_name,
          amount: Math.round((Number(inv.total) / 1.14975) * 100) / 100,
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

// ─── Sync Credit Notes ────────────────────────────────────────────────────────

async function syncCreditNotes(
  org: { id: string; office: string },
  accessToken: string,
  lastModified: Date | null,
): Promise<{ upserted: number; errors: string[] }> {
  let page = 1;
  let hasMore = true;
  let upserted = 0;
  const errors: string[] = [];

  while (hasMore) {
    const lastModParam = lastModified
      ? `&last_modified_time=${encodeURIComponent(toZohoTimestamp(lastModified))}`
      : '';
    // Full sync: anchor to 2025-01-01
    const dateParam = lastModified === null ? `&date.start=${FULL_SYNC_DATE_START}` : '';
    const url = `https://www.zohoapis.com/books/v3/creditnotes` +
      `?organization_id=${org.id}&page=${page}&per_page=200${lastModParam}${dateParam}`;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      errors.push(`${org.office} creditnotes p.${page}: ${await response.text()}`);
      break;
    }

    const data = await response.json();
    const notes: Record<string, unknown>[] = data.creditnotes ?? [];
    if (notes.length === 0) break;

    type Pending = { note: Record<string, unknown>; dept: { label: string; mapped: string } | null };
    const pending: Pending[] = [];
    for (const note of notes) {
      const rawStatus = ((note.status as string) ?? '').toLowerCase();
      if (rawStatus === 'void') continue;
      pending.push({ note, dept: extractDept(note) });
    }

    // Batch-lookup dept for notes that had no inline dept field
    const needsLookup = pending.filter((p) => p.dept === null);
    if (needsLookup.length > 0) {
      const refNums = [...new Set(
        needsLookup.map((p) => (p.note.reference_number as string)?.trim()).filter(Boolean),
      )];
      const deptByInv = await lookupDeptByInvoiceNumber(refNums, org.office);
      for (const p of needsLookup) {
        const ref = (p.note.reference_number as string)?.trim();
        if (ref && deptByInv.has(ref)) p.dept = deptByInv.get(ref)!;
      }
    }

    const toUpsert: object[] = [];
    for (const { note, dept } of pending) {
      if (!dept) continue;
      toUpsert.push({
        zoho_id: String(note.creditnote_id),
        invoice_number: note.creditnote_number,
        client_name: note.customer_name,
        amount: Math.round((Number(note.total) / 1.14975) * 100) / 100 * -1,
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
    'Access-Control-Allow-Headers': 'authorization, x-sync-source, x-full-sync, x-org, x-status, content-type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  const isManual = req.headers.get('x-sync-source') !== 'cron';
  const isFullSync = req.headers.get('x-full-sync') === 'true';
  // x-org: optional — restrict to a single office (QC or MTL).
  const orgFilter = req.headers.get('x-org')?.toUpperCase() ?? null;
  // x-status: optional — restrict full sync to a single Zoho status (e.g. "Sent", "Overdue").
  // Use this to back-fill a single status without re-fetching all paid/partial records.
  const statusOverride = req.headers.get('x-status') ?? null;
  const action = isManual
    ? (isFullSync ? 'sync_invoices_manual_full' : 'sync_invoices_manual')
    : 'sync_invoices_auto';

  let totalUpserted = 0;
  const allErrors: string[] = [];

  const orgsToProcess = orgFilter ? ORGS.filter(o => o.office === orgFilter) : ORGS;

  try {
    const accessToken = await getAccessToken();

    // Record sync start BEFORE calling Zoho so anything modified during this run
    // is picked up by the next run (no gap between runs).
    const syncStart = new Date();

    // Full sync: no time filter (fetch 2025-01-01 → today with status filter).
    // Incremental: read last_modified_time from sync_state.
    const lastModified = isFullSync ? null : await readSyncState('invoices');

    for (const org of orgsToProcess) {
      const invResult = await syncInvoices(org, accessToken, lastModified, statusOverride);
      totalUpserted += invResult.upserted;
      allErrors.push(...invResult.errors);

      const cnResult = await syncCreditNotes(org, accessToken, lastModified);
      totalUpserted += cnResult.upserted;
      allErrors.push(...cnResult.errors);
    }

    // Persist timestamp. Skip on full sync so we don't overwrite the incremental pointer.
    if (!isFullSync) {
      await writeSyncState('invoices', syncStart);
    }

    const durationMs = Date.now() - startTime;
    const result = { upserted: totalUpserted, errors: allErrors, duration_ms: durationMs };
    await logSync(action, 200, allErrors.length > 0 ? allErrors.join(' | ') : undefined);
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
