// supabase/functions/get-zoho-users/index.ts
// Returns the list of active users from Zoho Books (both orgs), deduplicated by email.
// Used by the admin Utilisateurs panel to pre-configure access before first login.

const ORGS = [
  { id: Deno.env.get('ZOHO_ORG_ID_QC')  ?? '48244978',  office: 'QC'  },
  { id: Deno.env.get('ZOHO_ORG_ID_MTL') ?? '815683274', office: 'MTL' },
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

async function getAccessToken(): Promise<string> {
  const clientId     = Deno.env.get('ZOHO_CLIENT_ID')!;
  const clientSecret = Deno.env.get('ZOHO_CLIENT_SECRET')!;
  const refreshToken = Deno.env.get('ZOHO_REFRESH_TOKEN')!;
  const url = `https://accounts.zoho.com/oauth/v2/token` +
    `?refresh_token=${refreshToken}&client_id=${clientId}` +
    `&client_secret=${clientSecret}&grant_type=refresh_token`;
  const res  = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho token refresh failed: ' + JSON.stringify(data));
  return data.access_token as string;
}

interface ZohoUser { name: string; email: string; }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const token = await getAccessToken();
    const seen  = new Set<string>();
    const users: ZohoUser[] = [];

    for (const org of ORGS) {
      let page = 1;
      while (true) {
        const res = await fetch(
          `https://www.zohoapis.com/books/v3/users?organization_id=${org.id}&page=${page}&per_page=200`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
        );
        if (!res.ok) {
          console.warn(`Zoho users fetch failed for org ${org.id}: HTTP ${res.status}`);
          break;
        }
        const data = await res.json();
        const batch = (data.users ?? []) as { name: string; email: string; status?: string; is_current_user?: boolean }[];
        if (batch.length === 0) break;

        for (const u of batch) {
          const email = (u.email ?? '').toLowerCase().trim();
          if (!email || seen.has(email)) continue;
          seen.add(email);
          users.push({ name: u.name?.trim() ?? '', email });
        }

        // Zoho paginates; stop if fewer than page size returned
        if (batch.length < 200) break;
        page++;
      }
    }

    users.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

    return new Response(JSON.stringify({ users }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('get-zoho-users error:', err);
    return new Response(JSON.stringify({ error: String(err), users: [] }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
