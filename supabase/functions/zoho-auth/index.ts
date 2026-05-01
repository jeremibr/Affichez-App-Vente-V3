// supabase/functions/zoho-auth/index.ts
// Handles Zoho OAuth callback: exchanges code → gets email → checks allowlist → creates Supabase session

import { createClient } from 'jsr:@supabase/supabase-js@2';

const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_AUTH_CLIENT_ID')!;
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_AUTH_CLIENT_SECRET')!;
const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL            = Deno.env.get('APP_URL') ?? 'http://localhost:5173';
const REDIRECT_URI       = `${SUPABASE_URL}/functions/v1/zoho-auth`;

function resolveRedirectBase(state: string | null): string {
  if (!state) return APP_URL;
  try {
    const parsed = new URL(state);
    // Allow any localhost port for local development
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return parsed.origin;
    }
    // In production only allow the configured APP_URL origin
    return parsed.origin === new URL(APP_URL).origin ? parsed.origin : APP_URL;
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

    // ─── 2. Extract email + name from OIDC id_token (JWT) ───────────────────
    // Zoho returns an id_token JWT when openid scope is requested.
    // The /oauth/user/info endpoint requires AaaServer.profile.READ scope — skip it.
    let email = '';
    let displayName = '';
    try {
      const idToken = tokenData.id_token as string;
      const payload = JSON.parse(atob(idToken.split('.')[1]));
      email = (payload.email ?? payload.Email ?? '').toLowerCase().trim();
      displayName = payload.name ?? payload.given_name ?? '';
      console.log('Zoho id_token claims:', JSON.stringify(payload));
    } catch (e) {
      console.error('Failed to decode id_token:', e);
    }

    if (!email) {
      console.error('No email in Zoho id_token');
      return Response.redirect(`${redirectBase}?auth_error=no_email`, 302);
    }

    // Derive a display name from email if Zoho didn't provide one
    if (!displayName) {
      const localPart = email.split('@')[0];
      displayName = localPart.charAt(0).toUpperCase() + localPart.slice(1);
    }

    // ─── 3. Access control + auto-registration ───────────────────────────────
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Check allowed_users for role/permissions metadata.
    // If not listed: @affichez.ca domain is always allowed with default member permissions.
    // Any other domain with no allowed_users entry is rejected.
    const { data: allowed } = await admin
      .from('allowed_users')
      .select('email, role, can_access_factures, rep_name')
      .eq('email', email)
      .maybeSingle();

    let userRow: { role: string; can_access_factures: boolean; rep_name: string | null } | null = allowed as typeof userRow ?? null;

    if (!userRow) {
      const domain = email.split('@')[1] ?? '';
      if (domain !== 'affichez.ca') {
        return Response.redirect(`${redirectBase}?auth_error=not_authorized`, 302);
      }
      // @affichez.ca not in allowed_users → auto-register with default member permissions
      // so the admin can see and manage them in the Utilisateurs panel
      const { data: inserted } = await admin
        .from('allowed_users')
        .upsert(
          { email, name: displayName, role: 'member', can_access_factures: false, rep_name: null },
          { onConflict: 'email', ignoreDuplicates: true }
        )
        .select('email, role, can_access_factures, rep_name')
        .maybeSingle();
      if (inserted) userRow = inserted as typeof userRow;
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
      options: { redirectTo: APP_URL, data: userMeta },
    });

    if (linkError || !linkData?.properties?.hashed_token) {
      console.error('generateLink failed:', linkError?.message);
      return Response.redirect(`${redirectBase}?auth_error=session_failed`, 302);
    }

    // ─── 4b. Also update metadata for existing users ──────────────────────────
    const userId = linkData.user?.id;
    if (userId) {
      await admin.auth.admin.updateUserById(userId, { user_metadata: userMeta });
    }

    // ─── 5. Verify the token server-side → capture session tokens → forward ──
    // We verify using APP_URL (always in Supabase's allowlist), capture the
    // fragment with access/refresh tokens, then redirect to the actual origin
    // (localhost or production). This bypasses the redirect-URL allowlist check.
    const hashedToken = linkData.properties.hashed_token;
    const verifyUrl = `${SUPABASE_URL}/auth/v1/verify?token=${hashedToken}&type=magiclink&redirect_to=${encodeURIComponent(APP_URL)}`;
    const verifyRes = await fetch(verifyUrl, { redirect: 'manual' });
    const location = verifyRes.headers.get('Location');

    if (!location) {
      console.error('verify returned no Location header, status:', verifyRes.status);
      return Response.redirect(`${redirectBase}?auth_error=session_failed`, 302);
    }

    // location = "https://sales.agentyx.ca/#access_token=...&refresh_token=..."
    // Rewrite the origin to wherever the user actually came from
    const fragment = location.includes('#') ? location.substring(location.indexOf('#')) : '';
    return Response.redirect(`${redirectBase}${fragment}`, 302);

  } catch (err) {
    console.error('zoho-auth error:', err);
    return Response.redirect(`${redirectBase}?auth_error=server_error`, 302);
  }
});
