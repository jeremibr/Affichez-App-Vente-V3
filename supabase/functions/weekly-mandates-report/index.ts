// supabase/functions/weekly-mandates-report/index.ts
//
// Team-wide "Mandats signés" weekly email — sent right after the sales report
// (same n8n workflow, Friday 17:00), to the ENTIRE team. Lists clients who signed
// this week (won = accepted OR invoiced, QC + MTL combined) and the department(s)
// each touched, plus new clients. Revenue is intentionally not shown.
//
// Auth: header  x-report-secret: <REPORT_SECRET>  (enforced if that secret is set).
//   week_start=YYYY-MM-DD  -> specific week (defaults to latest)
//   preview=1              -> raw HTML

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-report-secret',
};

// Two logo variants, matching how affichez.ca actually uses them:
// - colour wordmark on white backgrounds (site header)
// - pure-white wordmark on the orange background (site footer)
// PNG, not the .svg the site serves: Gmail, Outlook and Yahoo all refuse to
// render SVG in an email, and this goes out through Gmail.
const LOGO_URL = 'https://www.affichez.ca/wp-content/uploads/2026/09/Untitled-design-53.png';
const LOGO_URL_WHITE = 'https://www.affichez.ca/wp-content/uploads/2025/05/logo-affichez-pied-de-page.png';

const BRAND_DARK = '#000000';
const BRAND_ORANGE = '#F5570E';

const DEPT_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  'PROMOTIONNEL':            { label: 'Promotionnel',     bg: '#fff1e0', fg: '#b45f06' },
  'NUMERIQUE':               { label: 'Numérique',        bg: '#e5efff', fg: '#1d4ed8' },
  'DIST. PUBLICITAIRE SOLO': { label: 'Distribution',     bg: '#f3e9ff', fg: '#7c3aed' },
  'MULTI-ANNONCEURS':        { label: 'Multi-annonceurs', bg: '#e7f7ee', fg: '#15803d' },
  'APPLICATION':             { label: 'Application',       bg: '#e0f2fe', fg: '#0369a1' },
  'SERVICES IA':             { label: 'Services IA',       bg: '#fde8f3', fg: '#be1e6a' },
};
function deptStyle(d: string) {
  return DEPT_STYLE[d] ?? { label: d, bg: '#eef2f0', fg: '#475b52' };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function toAsciiEntities(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += cp > 127 ? `&#${cp};` : ch;
  }
  return out;
}

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function parseISO(d: string): Date { return new Date(d + 'T00:00:00'); }

function frenchWeekRange(startISO: string, endISO: string): string {
  const s = parseISO(startISO);
  const e = parseISO(endISO);
  const y = e.getFullYear();
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `du ${s.getDate()} au ${e.getDate()} ${MONTHS_FR[e.getMonth()]} ${y}`;
  }
  return `du ${s.getDate()} ${MONTHS_FR[s.getMonth()]} au ${e.getDate()} ${MONTHS_FR[e.getMonth()]} ${y}`;
}

interface WeekRow { week_start: string; week_end: string; total_amount: number; num_sales: number }
interface MandateRow { client_name: string; departments: string[]; nb_quotes: number; total_amount: number; is_new: boolean }

function chip(label: string, bg: string, fg: string): string {
  return `<span style="display:inline-block; padding:3px 9px; border-radius:12px; font-size:11px; font-weight:600; background:${bg}; color:${fg}; margin:2px 0 2px 5px; white-space:nowrap;">${escapeHtml(label)}</span>`;
}

function renderEmail(opts: { weekRange: string; rows: MandateRow[]; prevClients: number | null }): string {
  const { weekRange, rows, prevClients } = opts;

  const totalClients = rows.length;
  const newClients = rows.filter((r) => r.is_new).length;

  const deptCounts = new Map<string, number>();
  for (const r of rows) for (const d of r.departments) deptCounts.set(d, (deptCounts.get(d) ?? 0) + 1);
  const deptsSorted = [...deptCounts.entries()].sort((a, b) => b[1] - a[1]);

  const delta = prevClients && prevClients > 0 ? totalClients - prevClients : null;
  const deltaUp = (delta ?? 0) >= 0;
  const wowPill = delta === null ? '' : `
    <span style="display:inline-block; margin-top:10px; padding:5px 12px; border-radius:20px; font-size:12px; font-weight:600;
                 background:${deltaUp ? '#e7f5ee' : '#fcebea'}; color:${deltaUp ? '#1a7a4d' : '#c0392b'};">
      ${deltaUp ? '▲' : '▼'} ${deltaUp ? '+' : ''}${delta} vs semaine précédente
    </span>`;

  const deptCards = deptsSorted.map(([d, n]) => {
    const st = deptStyle(d);
    return `
      <td style="padding:4px;">
        <table cellpadding="0" cellspacing="0" role="presentation" style="background:${st.bg}; border-radius:10px;">
          <tr><td style="padding:12px 16px; text-align:center; white-space:nowrap;">
            <div style="font-size:22px; font-weight:700; color:${st.fg}; line-height:1;">${n}</div>
            <div style="font-size:11px; font-weight:600; color:${st.fg}; margin-top:4px;">${escapeHtml(st.label)}</div>
          </td></tr>
        </table>
      </td>`;
  }).join('');

  const clientRows = rows.map((r) => {
    const chips = r.departments.map((d) => { const s = deptStyle(d); return chip(s.label, s.bg, s.fg); }).join('');
    const badge = r.is_new
      ? `<span style="display:inline-block; margin-left:7px; padding:1px 7px; border-radius:10px; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; background:#e7f7ee; color:#15803d; vertical-align:middle;">Nouveau</span>`
      : '';
    return `
      <tr>
        <td style="padding:10px 8px 10px 0; border-bottom:1px solid #eef2f0; font-size:14px; color:${BRAND_DARK}; vertical-align:middle;">
          <span style="font-weight:600;">${escapeHtml(r.client_name)}</span>${badge}
        </td>
        <td style="padding:10px 0 10px 8px; border-bottom:1px solid #eef2f0; text-align:right; vertical-align:middle;">${chips}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Mandats signés - Affichez</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light only; }
  * { box-sizing: border-box; }
  body { margin:0; padding:0; background-color:#f0f2f0; font-family:'Poppins', Arial, sans-serif; -webkit-font-smoothing:antialiased; }
  @media (prefers-color-scheme: dark) {
    body { background-color:#f0f2f0 !important; }
    .email-container { background-color:#ffffff !important; }
    td, p, h1, h2, a, span, strong, div { color:inherit !important; }
  }
  @media only screen and (max-width:620px) {
    .email-wrapper { padding:0 !important; }
    .email-container { width:100% !important; border-radius:0 !important; }
    .pad-hero { padding:28px 20px 0 !important; }
    .h1-title { font-size:20px !important; }
    .pad-section { padding:0 20px 16px !important; }
    .pad-footer { padding:24px 20px 28px !important; }
    .pad-sides { padding:24px 20px !important; }
    .stat-big { font-size:40px !important; }
    .footer-phones { font-size:11px !important; }
    .logo-footer { width:100px !important; }
  }
</style>
</head>
<body>
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" class="email-wrapper" style="background:#f0f2f0; padding:40px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" role="presentation" class="email-container"
           style="max-width:600px; width:100%; border-radius:12px; overflow:hidden; box-shadow:0 4px 24px rgba(21,70,51,0.10);">

      <tr>
        <td class="pad-sides" style="background:#ffffff; padding:32px 48px 24px; text-align:center;">
          <img src="${LOGO_URL}" alt="Affichez" width="160" style="display:block; margin:0 auto; width:160px; max-width:100%; border:none;">
        </td>
      </tr>
      <tr><td style="background:${BRAND_ORANGE}; height:5px; font-size:0; line-height:0;">&nbsp;</td></tr>

      <tr>
        <td class="pad-hero" style="background:#ffffff; padding:36px 48px 8px; text-align:center;">
          <p style="margin:0 0 6px; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:${BRAND_ORANGE};">Mandats signés</p>
          <h1 class="h1-title" style="margin:0 0 4px; font-size:22px; font-weight:700; color:${BRAND_DARK}; line-height:1.3;">Semaine ${weekRange}</h1>
        </td>
      </tr>

      <tr>
        <td style="background:#ffffff; padding:16px 48px 12px; text-align:center;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${BRAND_DARK}; border-radius:12px;">
            <tr><td style="padding:26px 20px; text-align:center;">
              <p style="margin:0 0 4px; font-size:12px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:#a9c6b7;">Mandats signés cette semaine</p>
              <p class="stat-big" style="margin:0; font-size:48px; font-weight:700; color:#ffffff; line-height:1;">${totalClients}</p>
              <p style="margin:8px 0 0; font-size:13px; color:#cfe0d7;">${newClients} nouveaux clients &nbsp;&bull;&nbsp; ${deptsSorted.length} départements</p>
              ${wowPill}
            </td></tr>
          </table>
        </td>
      </tr>

      <tr>
        <td class="pad-section" style="background:#ffffff; padding:16px 48px 4px; text-align:center;">
          <p style="margin:0; font-size:13px; color:#4a6155; line-height:1.7;">
            Chaque semaine, voici les mandats signés — pour que <strong style="color:${BRAND_DARK};">toute l'équipe</strong> ait une vue d'ensemble de notre progression collective.
          </p>
        </td>
      </tr>

      <tr>
        <td style="background:#ffffff; padding:8px 48px;">
          <div style="height:1px; background:#e8ede9; font-size:0; line-height:0;">&nbsp;</div>
        </td>
      </tr>

      <tr>
        <td class="pad-section" style="background:#ffffff; padding:12px 48px 6px;">
          <p style="margin:0 0 8px; font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:${BRAND_DARK};">Mandats par département</p>
          <table cellpadding="0" cellspacing="0" role="presentation"><tr>${deptCards}</tr></table>
        </td>
      </tr>

      <tr>
        <td style="background:#ffffff; padding:8px 48px;">
          <div style="height:1px; background:#e8ede9; font-size:0; line-height:0;">&nbsp;</div>
        </td>
      </tr>

      <tr>
        <td class="pad-section" style="background:#ffffff; padding:18px 48px 8px;">
          <p style="margin:0 0 2px; font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:${BRAND_DARK};">Les clients qui ont signé cette semaine</p>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:6px;">
            ${clientRows}
          </table>
        </td>
      </tr>

      <tr>
        <td style="background:#ffffff; padding:14px 48px 40px; text-align:center;">
          <p style="margin:0; font-size:14px; color:#4a6155; line-height:1.7;">Merci à tous pour votre implication.<br><strong style="color:${BRAND_DARK};">Bon week-end à toute l'équipe ! 🎉</strong></p>
        </td>
      </tr>

      <tr>
        <td class="pad-footer" style="background:${BRAND_ORANGE}; padding:28px 48px 32px; text-align:center;">
          <img src="${LOGO_URL_WHITE}" alt="Affichez" class="logo-footer" width="120" style="display:block; margin:0 auto 24px; width:120px; border:none;">
          <p class="footer-phones" style="margin:0 0 4px; font-size:12px; color:#ffffff; line-height:1.9;">
            <a href="tel:4188002211" style="color:#ffffff; text-decoration:none; font-weight:600;">Québec : 418 800-2211</a>
          </p>
          <p class="footer-phones" style="margin:0 0 4px; font-size:12px; color:#ffffff; line-height:1.9;">
            <a href="tel:5143601634" style="color:#ffffff; text-decoration:none; font-weight:600;">Laval : 514 360-1634</a>
          </p>
          <p class="footer-phones" style="margin:0 0 16px; font-size:12px; color:#ffffff; line-height:1.9;">
            <a href="tel:8193032944" style="color:#ffffff; text-decoration:none; font-weight:600;">Gatineau : 819 303-2944</a>
          </p>
          <p style="margin:0 0 14px; font-size:12px; color:#ffffff;">
            <a href="https://www.affichez.ca" style="color:#ffffff; text-decoration:none; font-weight:600;">www.affichez.ca</a>
          </p>
          <p style="margin:0; font-size:10px; color:#ffe9de; line-height:1.6;">Rapport interne automatisé - Affichez. Envoyé chaque vendredi en fin de journée.</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  const secret = Deno.env.get('REPORT_SECRET');
  if (secret && req.headers.get('x-report-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') { try { body = await req.json(); } catch { /* ignore */ } }
    const weekStartParam = url.searchParams.get('week_start') ?? (body.week_start as string | undefined);
    const preview = url.searchParams.get('preview') === '1' || body.preview === true;

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const year = new Date().getFullYear();
    const { data: weeksData, error: weeksErr } = await supabase
      .rpc('get_available_weeks', { p_year: year, p_office: null, p_status: null });
    if (weeksErr) throw weeksErr;
    const weeks = (weeksData ?? []) as WeekRow[];
    if (weeks.length === 0) throw new Error('Aucune semaine disponible.');

    let idx = 0;
    if (weekStartParam) {
      const found = weeks.findIndex((w) => w.week_start === weekStartParam);
      idx = found >= 0 ? found : 0;
    }
    const target = weeks[idx];
    const prev = weeks[idx + 1] ?? null;

    const { data: rowsData, error: rowsErr } = await supabase.rpc('get_weekly_mandates', { p_week_start: target.week_start });
    if (rowsErr) throw rowsErr;
    const rows = (rowsData ?? []) as MandateRow[];

    let prevClients: number | null = null;
    if (prev) {
      const { data: prevData } = await supabase.rpc('get_weekly_mandates', { p_week_start: prev.week_start });
      prevClients = (prevData ?? []).length;
    }

    const weekRange = frenchWeekRange(target.week_start, target.week_end);
    const html = toAsciiEntities(renderEmail({ weekRange, rows, prevClients }));
    const subject = `Mandats signés - Semaine ${weekRange}`;

    if (preview) {
      return new Response(html, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response(JSON.stringify({
      subject, html,
      week_start: target.week_start,
      week_end: target.week_end,
      week_range: weekRange,
      total_clients: rows.length,
      new_clients: rows.filter((r) => r.is_new).length,
    }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('weekly-mandates-report error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
