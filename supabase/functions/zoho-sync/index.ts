// supabase/functions/zoho-sync/index.ts
// Syncs Zoho Books estimates → Supabase sales table
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

// Injected automatically by Supabase runtime
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

  if (!data.access_token) {
    throw new Error('Zoho token refresh failed: ' + JSON.stringify(data));
  }
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

// Updates status to 'declined' for existing rows only — never inserts new rows.
// Safe to call even if some zoho_ids don't exist in the DB (PATCH is a no-op for missing rows).
async function declineBatch(zohoIds: string[]): Promise<void> {
  if (zohoIds.length === 0) return;
  const param = zohoIds.join(',');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?zoho_id=in.(${param})`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ status: 'declined' }),
  });
  if (!res.ok) throw new Error('Supabase decline patch failed: ' + await res.text());
}

async function deleteBatch(zohoIds: string[]): Promise<void> {
  if (zohoIds.length === 0) return;
  const param = zohoIds.join(',');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?zoho_id=in.(${param})`, {
    method: 'DELETE',
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error('Supabase delete failed: ' + await res.text());
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

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-sync-source, x-full-sync, x-debug-id, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const debugId = req.headers.get('x-debug-id');
  const debugOrg = req.headers.get('x-debug-org'); // optional: 'QC' or 'MTL'
  if (debugId) {
    try {
      const accessToken = await getAccessToken();
      const org = debugOrg ? (ORGS.find(o => o.office === debugOrg) ?? ORGS[0]) : ORGS[0];
      const res = await fetch(
        `https://www.zohoapis.com/books/v3/estimates/${debugId}?organization_id=${org.id}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
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

  const startTime = Date.now();
  const isManual = req.headers.get('x-sync-source') !== 'cron';
  const action = isManual ? 'sync_manual' : 'sync_auto';

  let totalUpserted = 0;
  let totalDeleted = 0;
  const errors: string[] = [];

  try {
    const accessToken = await getAccessToken();

    // Full sync mode: no date filter, fetches all historical estimates
    const isFullSync = req.headers.get('x-full-sync') === 'true';
    const dateStart = isFullSync
      ? null
      : new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Track every zoho_id Zoho returns — used to detect hard-deleted quotes
    const seenZohoIds = new Set<string>();

    // Full sync: loop over statuses to skip drafts/declined (faster, no date filter)
    // Regular sync: no filter_by (Zoho ignores date_start when combined with filter_by),
    //               filter by status in code after fetching
    const statusFilters = isFullSync ? ['Accepted', 'Invoiced'] : [null];

    for (const org of ORGS) {
      for (const statusFilter of statusFilters) {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const dateParam = dateStart ? `&date_start=${dateStart}` : '';
        const statusParam = statusFilter ? `&filter_by=Status.${statusFilter}` : '';
        const url = `https://www.zohoapis.com/books/v3/estimates` +
          `?organization_id=${org.id}&page=${page}&per_page=200${statusParam}${dateParam}`;

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

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
            const repName = (est.salesperson_name as string)?.trim() || null;
            const deptLabel = (est.cf_d_partement ?? est.department) as string;
            const department = DEPT_MAP[deptLabel];
            const saleDate = (est.cf_date_acceptation_unformatted as string) || (est.accepted_date as string) || (est.date as string);
            const amountHT = Math.round((Number(est.total) / 1.14975) * 100) / 100;
            const status = rawStatus === 'accepted' ? 'accepted' : 'invoiced';
            if (department) {
              toUpsert.push({
                zoho_id: zohoId,
                sale_date: saleDate,
                client_name: est.customer_name,
                amount: amountHT,
                quote_number: est.estimate_number,
                rep_name: repName,
                zoho_department_label: String(deptLabel),
                department,
                office: org.office,
                status,
              });
            }
          } else if (rawStatus === 'declined' || rawStatus === 'void') {
            // Only update existing rows — PATCH never inserts, so quotes that were
            // declined before ever being accepted won't be created in the DB.
            toDecline.push(zohoId);
          }
        }

        if (toUpsert.length > 0) {
          await upsertBatch(toUpsert);
          totalUpserted += toUpsert.length;
        }

        if (toDecline.length > 0) {
          await declineBatch(toDecline);
        }

        hasMore = (data.page_context as Record<string, boolean>)?.has_more_page ?? false;
        page++;
      }
      } // end statusFilter loop
    }

    // Orphan detection: only safe on full sync because regular syncs use a date window
    // (Zoho filters by estimate date, Supabase by acceptance date — windows don't align,
    // causing valid quotes to be falsely deleted on regular syncs).
    if (isFullSync) {
      const existingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/sales?select=zoho_id`,
        { headers: SB_HEADERS }
      );
      if (existingRes.ok) {
        const existing: { zoho_id: string }[] = await existingRes.json();
        const orphanIds = existing.map(r => r.zoho_id).filter(id => !seenZohoIds.has(id));
        if (orphanIds.length > 0) {
          await deleteBatch(orphanIds);
          totalDeleted += orphanIds.length;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const result = { upserted: totalUpserted, deleted: totalDeleted, errors, duration_ms: durationMs };
    const logMsg = errors.length > 0 ? errors.join(' | ') : undefined;

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
