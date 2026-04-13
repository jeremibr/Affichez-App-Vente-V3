// supabase/functions/zoho-auth/index.ts
// Handles Zoho OAuth callback: exchanges code → gets email → checks allowlist → creates Supabase session

import { createClient } from 'jsr:@supabase/supabase-js@2';

const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_AUTH_CLIENT_ID')!;
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_AUTH_CLIENT_SECRET')!;
const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL            = Deno.env.get('APP_URL') ?? 'http://localhost:5173';
const REDIRECT_URI       = `${SUPABASE_URL}/functions/v1/zoho-auth`;

// Allowed redirect origins — includes localhost so local dev works without any config change
const ALLOWED_ORIGINS = new Set([
  APP_URL,
  'http://localhost:5173',
  'http://localhost:4173', // vite preview
]);

function resolveRedirectBase(state: string | null): string {
  if (!state) return APP_URL;
  try {
    const origin = new URL(state).origin;
    return ALLOWED_ORIGINS.has(origin) ? origin : APP_URL;
  } catch {
    return APP_URL;
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const redirectBase = resolveRedirectBase(url.searchParams.get('state'));

  // ─── Error from Zoho (user denied) ───────────────────────────────────────────
  if (url.searchParams.get('error')) {
    return Response.redirect(`${redirectBase}?auth_error=denied`, 302);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return Response.redirect(`${redirectBase}?auth_error=no_code`, 302);
  }

  try {
    // ─── 1. Exchange authorization code for Zoho access token ────────────────
    const tokenRes = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Token exchange failed:', JSON.stringify(tokenData));
      return Response.redirect(`${redirectBase}?auth_error=token_failed`, 302);
    }

    // ─── 2. Extract email from OIDC id_token (JWT) ───────────────────────────
    // Zoho returns an id_token JWT when openid scope is requested.
    // The /oauth/user/info endpoint requires AaaServer.profile.READ scope — skip it.
    let email = '';
    try {
      const idToken = tokenData.id_token as string;
      const payload = JSON.parse(atob(idToken.split('.')[1]));
      email = (payload.email ?? payload.Email ?? '').toLowerCase().trim();
      console.log('Zoho id_token claims:', JSON.stringify(payload));
    } catch (e) {
      console.error('Failed to decode id_token:', e);
    }

    if (!email) {
      console.error('No email in Zoho id_token');
      return Response.redirect(`${redirectBase}?auth_error=no_email`, 302);
    }

    // ─── 3. Access control ───────────────────────────────────────────────────
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // If allowed_users table has entries → enforce allowlist
    // If empty → fall back to @affichez.ca domain check
    const { count } = await admin
      .from('allowed_users')
      .select('*', { count: 'exact', head: true });

    let userRow: { role: string; can_access_factures: boolean; rep_name: string | null } | null = null;

    if (count && count > 0) {
      const { data: allowed } = await admin
        .from('allowed_users')
        .select('email, role, can_access_factures, rep_name')
        .eq('email', email)
        .maybeSingle();

      if (!allowed) {
        return Response.redirect(`${redirectBase}?auth_error=not_authorized`, 302);
      }
      userRow = allowed as typeof userRow;
    } else {
      // Domain fallback
      const domain = email.split('@')[1] ?? '';
      if (domain !== 'affichez.ca') {
        return Response.redirect(`${redirectBase}?auth_error=not_authorized`, 302);
      }
    }

    // ─── 4. Generate Supabase magic link (creates user account if needed) ────
    const userMeta = {
      role:                userRow?.role ?? 'member',
      can_access_factures: userRow?.can_access_factures ?? false,
      rep_name:            userRow?.rep_name ?? null,
    };

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: redirectBase, data: userMeta },
    });

    if (linkError || !linkData?.properties?.action_link) {
      console.error('generateLink failed:', linkError?.message);
      return Response.redirect(`${redirectBase}?auth_error=session_failed`, 302);
    }

    // ─── 4b. Also update metadata for existing users ──────────────────────────
    // generateLink `data` only sets metadata for new users — patch existing ones too.
    const userId = linkData.user?.id;
    if (userId) {
      await admin.auth.admin.updateUserById(userId, { user_metadata: userMeta });
    }

    // ─── 5. Redirect user → Supabase verifies token → redirects to redirectBase ──
    return Response.redirect(linkData.properties.action_link, 302);

  } catch (err) {
    console.error('zoho-auth error:', err);
    return Response.redirect(`${redirectBase}?auth_error=server_error`, 302);
  }
});
