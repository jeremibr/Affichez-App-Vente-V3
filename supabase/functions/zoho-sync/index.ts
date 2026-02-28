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

async function getReps(): Promise<Record<string, string>> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/reps?select=id,name`, {
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error('Failed to fetch reps: ' + await res.text());
  const reps: { id: string; name: string }[] = await res.json();
  return Object.fromEntries(reps.map(r => [r.name.trim(), r.id]));
}

async function upsertBatch(batch: object[]): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?on_conflict=zoho_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error('Supabase upsert failed: ' + await res.text());
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
    'Access-Control-Allow-Headers': 'authorization, x-sync-source, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const isManual = req.headers.get('x-sync-source') !== 'cron';
  const action = isManual ? 'sync_manual' : 'sync_auto';

  let totalUpserted = 0;
  let totalDeleted = 0;
  const errors: string[] = [];

  try {
    const accessToken = await getAccessToken();
    const repMap = await getReps();

    for (const org of ORGS) {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const url = `https://www.zohoapis.com/books/v3/estimates` +
          `?organization_id=${org.id}&page=${page}&per_page=200`;

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
        const toDelete: string[] = [];

        for (const est of estimates) {
          const year = new Date(est.date as string).getFullYear();
          if (year !== 2025 && year !== 2026) continue;

          const rawStatus = ((est.status as string) ?? '').toLowerCase();
          const zohoId = String(est.estimate_id);

          if (rawStatus.includes('invoiced') || rawStatus.includes('paid')) {
            const repId = repMap[(est.salesperson_name as string)?.trim()];
            const deptLabel = (est.cf_d_partement ?? est.department) as string;
            const department = DEPT_MAP[deptLabel];
            if (repId && department) {
              toUpsert.push({
                zoho_id: zohoId,
                sale_date: est.date,
                client_name: est.customer_name,
                amount: est.total,
                quote_number: est.estimate_number,
                rep_id: repId,
                zoho_department_label: String(deptLabel),
                department,
                office: org.office,
                status: 'invoiced',
              });
            }
          } else if (rawStatus === 'accepted') {
            const repId = repMap[(est.salesperson_name as string)?.trim()];
            const deptLabel = (est.cf_d_partement ?? est.department) as string;
            const department = DEPT_MAP[deptLabel];
            if (repId && department) {
              toUpsert.push({
                zoho_id: zohoId,
                sale_date: est.date,
                client_name: est.customer_name,
                amount: est.total,
                quote_number: est.estimate_number,
                rep_id: repId,
                zoho_department_label: String(deptLabel),
                department,
                office: org.office,
                status: 'accepted',
              });
            }
          } else {
            // declined / draft / sent / expired → remove from sales if it exists
            toDelete.push(zohoId);
          }
        }

        if (toUpsert.length > 0) {
          await upsertBatch(toUpsert);
          totalUpserted += toUpsert.length;
        }

        if (toDelete.length > 0) {
          await deleteBatch(toDelete);
          totalDeleted += toDelete.length;
        }

        // Early stop: entire page is before 2025
        const first = estimates[0];
        const last = estimates[estimates.length - 1];
        if (
          first && new Date(first.date as string).getFullYear() < 2025 &&
          last && new Date(last.date as string).getFullYear() < 2025
        ) {
          hasMore = false;
        } else {
          hasMore = (data.page_context as Record<string, boolean>)?.has_more_page ?? false;
        }
        page++;
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
