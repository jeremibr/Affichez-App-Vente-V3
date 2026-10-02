// supabase/functions/get-zoho-users/index.ts
// Returns the list of active users from Zoho Books (both orgs), deduplicated by email.
// Used by the admin Utilisateurs panel to pre-configure access before first login.
//
// Admins only. The gateway accepts any token signed for the project, and the
// anon key shipped in the frontend bundle is one, so the check has to happen
// here: the caller's own session token is asked whether it is an admin.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// Only identifies the project to the API gateway; the role comes from the
// caller's Authorization header.
const API_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ORGS = [
  { id: Deno.env.get('ZOHO_ORG_ID_QC')  ?? '48244978',  office: 'QC'  },
  { id: Deno.env.get('ZOHO_ORG_ID_MTL') ?? '815683274', office: 'MTL' },
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
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

/**
 * app_is_admin() is the definition every policy uses: listed in allowed_users,
 * role admin, session opened through the Zoho sign-in. Calling it with the
 * caller's token keeps one definition instead of a second one here. Anything
 * but a clean `true` is a refusal, including a failed lookup.
 */
async function callerIsAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+/i.test(auth)) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/app_is_admin`, {
      method: 'POST',
      headers: { apikey: API_KEY, Authorization: auth, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch (err) {
    console.error('get-zoho-users admin check failed:', err);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!(await callerIsAdmin(req))) {
    return new Response(JSON.stringify({ error: 'forbidden', users: [] }), {
      status: 403,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
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
