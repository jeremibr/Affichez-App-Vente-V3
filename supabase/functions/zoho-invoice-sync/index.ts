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

async function deleteBatch(zohoIds: string[]): Promise<void> {
  for (let i = 0; i < zohoIds.length; i += 50) {
    const chunk = zohoIds.slice(i, i + 50).map(encodeURIComponent).join(',');
    const res = await fetch(`${SUPABASE_URL}/rest/v1/invoices?zoho_id=in.(${chunk})`, {
      method: 'DELETE',
      headers: SB_HEADERS,
    });
    if (!res.ok) throw new Error('Supabase delete failed: ' + await res.text());
  }
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

/**
 * Zoho credit notes store reference_number as e.g. "MTL-01892" (5-digit) while our DB
 * stores invoice_number as "MTL-001892" (6-digit zero-padded). Normalize before lookup.
 */
function normalizeInvoiceRef(ref: string): string {
  const match = ref.match(/^([A-Z]+-?)(\d+)$/);
  if (!match) return ref;
  const [, prefix, num] = match;
  return prefix + num.padStart(6, '0');
}

/** Batch-lookup dept from invoices table using credit note reference_number → invoice_number */
async function lookupDeptByInvoiceNumber(
  invoiceNumbers: string[],
  office: string,
): Promise<Map<string, { label: string; mapped: string }>> {
  if (invoiceNumbers.length === 0) return new Map();
  const normalized = invoiceNumbers.map(normalizeInvoiceRef);
  const nums = normalized.map((n) => encodeURIComponent(n)).join(',');
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
  touched: Set<string>,
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
        touched.add(String(inv.invoice_number));
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
  touched: Set<string>,
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
        const normalizedRef = ref ? normalizeInvoiceRef(ref) : null;
        if (normalizedRef && deptByInv.has(normalizedRef)) p.dept = deptByInv.get(normalizedRef)!;
      }
    }

    const toUpsert: object[] = [];
    for (const { note, dept } of pending) {
      if (!dept) continue;
      touched.add(String(note.creditnote_number));
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

// ─── Duplicate Reaper ─────────────────────────────────────────────────────────
// When the payer entity changes, accounting deletes the invoice in Zoho and re-issues
// it with the SAME number under the new customer account. We only ever upsert on
// zoho_id and never delete, so the dead row survived here and its amount was counted
// twice. Zoho is the source of truth: a zoho_id that 404s no longer exists — drop it.

const ORG_BY_OFFICE: Record<string, string> = Object.fromEntries(ORGS.map((o) => [o.office, o.id]));

interface DupRow {
  zoho_id: string;
  invoice_number: string;
  office: string | null;
  is_avoir: boolean;
  amount: number;
  client_name: string;
}

const DUP_COLS = 'zoho_id,invoice_number,office,is_avoir,amount,client_name';

/** Every invoice row, paged — a bare select is capped at PostgREST's max_rows (1000). */
async function fetchAllInvoiceRows(): Promise<DupRow[]> {
  const rows: DupRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/invoices` +
        `?select=${DUP_COLS}&order=zoho_id.asc&limit=${pageSize}&offset=${offset}`,
      { headers: SB_HEADERS },
    );
    if (!res.ok) throw new Error('Invoice scan failed: ' + await res.text());
    const page = await res.json() as DupRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** Rows carrying one of the given invoice numbers. */
async function fetchRowsByNumber(numbers: string[]): Promise<DupRow[]> {
  const rows: DupRow[] = [];
  for (let i = 0; i < numbers.length; i += 100) {
    const list = numbers.slice(i, i + 100)
      .map((num) => `"${num.replace(/"/g, '\\"')}"`)
      .map(encodeURIComponent)
      .join(',');
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/invoices?select=${DUP_COLS}&invoice_number=in.(${list})`,
      { headers: SB_HEADERS },
    );
    if (!res.ok) throw new Error('Invoice lookup failed: ' + await res.text());
    rows.push(...await res.json() as DupRow[]);
  }
  return rows;
}

/** Group by (invoice_number, office), keeping only the collisions. */
function duplicateGroups(rows: DupRow[]): Map<string, DupRow[]> {
  const groups = new Map<string, DupRow[]>();
  for (const row of rows) {
    if (!row.invoice_number) continue;
    const key = `${row.invoice_number}|${row.office ?? ''}`;
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) groups.delete(key);
  }
  return groups;
}

type Existence = 'alive' | 'deleted' | 'unknown';

/** Ask Zoho whether one record still exists. Anything inconclusive stays 'unknown'. */
async function checkZohoExistence(row: DupRow, accessToken: string): Promise<Existence> {
  const orgId = row.office ? ORG_BY_OFFICE[row.office] : undefined;
  if (!orgId) return 'unknown';
  const resource = row.is_avoir ? 'creditnotes' : 'invoices';
  const url = `https://www.zohoapis.com/books/v3/${resource}/${row.zoho_id}` +
    `?organization_id=${orgId}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.ok) { await res.body?.cancel(); return 'alive'; }

  let code: number | null = null;
  try { code = Number((await res.json())?.code ?? NaN); } catch { /* non-JSON error body */ }
  // 1002 = "the requested resource could not be found or accessed" — deleted in Zoho.
  if (res.status === 404 || code === 1002) return 'deleted';
  return 'unknown'; // 401/429/500 etc. — never delete on an answer we can't trust
}

/**
 * Resolve every duplicate group against Zoho and delete the rows Zoho no longer has.
 * Deliberately conservative — a group is left untouched unless every one of its rows
 * gave an unambiguous answer and at least one of them survives.
 *
 * `touched` limits the search to the numbers this run just upserted, which is all an
 * incremental sync needs: a collision can only appear when a new row lands. Pass null
 * to sweep the whole table (full sync, or a one-off x-prune-only run).
 */
async function pruneDeletedDuplicates(
  accessToken: string,
  dryRun: boolean,
  touched: Set<string> | null,
): Promise<{ deleted: string[]; skipped: string[] }> {
  const deleted: string[] = [];
  const skipped: string[] = [];

  const rows = touched
    ? (touched.size === 0 ? [] : await fetchRowsByNumber([...touched]))
    : await fetchAllInvoiceRows();

  for (const [key, group] of duplicateGroups(rows)) {
    const verdicts = await Promise.all(group.map((r) => checkZohoExistence(r, accessToken)));

    if (verdicts.includes('unknown')) {
      skipped.push(`${key}: Zoho lookup inconclusive`);
      continue;
    }
    const dead = group.filter((_, i) => verdicts[i] === 'deleted');
    if (dead.length === 0) {
      skipped.push(`${key}: all ${group.length} rows still exist in Zoho — number reused, review manually`);
      continue;
    }
    if (dead.length === group.length) {
      skipped.push(`${key}: all ${group.length} rows gone from Zoho — review manually`);
      continue;
    }

    if (!dryRun) await deleteBatch(dead.map((r) => r.zoho_id));
    for (const r of dead) {
      deleted.push(`${key} id=${r.zoho_id} ${r.amount} ${r.client_name}`);
    }
  }

  return { deleted, skipped };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-sync-source, x-full-sync, x-org, x-status, x-prune, x-prune-only, x-dry-run, content-type',
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
  // Duplicate reaper: runs after every sync. x-prune: false opts out,
  // x-prune-only: true skips the sync, x-dry-run: true reports without deleting.
  const isPruneOnly = req.headers.get('x-prune-only') === 'true';
  const skipPrune = req.headers.get('x-prune') === 'false';
  const isDryRun = req.headers.get('x-dry-run') === 'true';
  const action = isPruneOnly
    ? 'prune_invoice_duplicates'
    : isManual
    ? (isFullSync ? 'sync_invoices_manual_full' : 'sync_invoices_manual')
    : 'sync_invoices_auto';

  let totalUpserted = 0;
  let pruneResult: { deleted: string[]; skipped: string[] } = { deleted: [], skipped: [] };
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

    const touched = new Set<string>();

    if (!isPruneOnly) {
      for (const org of orgsToProcess) {
        const invResult = await syncInvoices(org, accessToken, lastModified, touched, statusOverride);
        totalUpserted += invResult.upserted;
        allErrors.push(...invResult.errors);

        const cnResult = await syncCreditNotes(org, accessToken, lastModified, touched);
        totalUpserted += cnResult.upserted;
        allErrors.push(...cnResult.errors);
      }
    }

    // Reap rows for invoices that were deleted in Zoho and re-issued under the same
    // number. An incremental run only has to look at what it just touched; a prune-only
    // or full run sweeps the whole table. Isolated from the sync result — a reaper
    // failure must not fail the sync.
    if (!skipPrune) {
      try {
        const scope = (isPruneOnly || isFullSync) ? null : touched;
        pruneResult = await pruneDeletedDuplicates(accessToken, isDryRun, scope);
      } catch (err) {
        allErrors.push('prune: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    // Persist timestamp. Skip on full sync so we don't overwrite the incremental pointer.
    if (!isFullSync && !isPruneOnly) {
      await writeSyncState('invoices', syncStart);
    }

    const durationMs = Date.now() - startTime;
    const result = {
      upserted: totalUpserted,
      pruned: isDryRun ? 0 : pruneResult.deleted.length,
      prune_dry_run: isDryRun,
      prune_deleted: pruneResult.deleted,
      prune_skipped: pruneResult.skipped,
      errors: allErrors,
      duration_ms: durationMs,
    };
    const notes = [
      ...pruneResult.deleted.map((d) => `pruned: ${d}`),
      ...pruneResult.skipped.map((s) => `prune skipped: ${s}`),
      ...allErrors,
    ];
    await logSync(action, 200, notes.length > 0 ? notes.join(' | ') : undefined);
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
