// supabase/functions/weekly-sales-report/index.ts
//
// Generates the weekly sales recap email ("Rapport des ventes de la semaine").
// Called by the n8n workflow every Friday at 17:00 (Schedule -> HTTP -> Gmail).
// Returns JSON { subject, html, ...stats } so the Gmail node can map the subject
// and HTML body directly.
//
// Auth: pass header  x-report-secret: <REPORT_SECRET>  (set REPORT_SECRET as a
// function secret to enforce it; if REPORT_SECRET is unset the endpoint is open).
//
// Optional query/body params:
//   week_start=YYYY-MM-DD   -> report a specific week (defaults to latest week)
//   preview=1               -> return raw HTML (Content-Type text/html) for eyeballing

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-report-secret',
};

// Reps grouped into a single "Vente Interne" line, mirroring the app
// (frontend/src/lib/constants.ts INTERNAL_REP_NAMES).
const INTERNAL_REP_NAMES = [
  'Simon Fortin Massé',
  'Magasin Affichez',
  'Charles Côté',
  'Pier-Alexandre Lévesque',
  'Vente interne',
].map((n) => n.normalize('NFC'));

// Rep profile photos (keyed by first name), shown for reps over the highlight
// threshold. Hardcoded on request.
const REP_PHOTOS: Record<string, string> = {
  'Dominic':   'https://www.affichez.ca/wp-content/uploads/2025/05/dominic-letendre-president-agence-affichez.webp',
  'Francis':   'https://www.affichez.ca/wp-content/uploads/2026/04/Francis-Adam-768x768.png',
  'Guillaume': 'https://www.affichez.ca/wp-content/uploads/2025/05/guillaume-acheteur-du-departement-promo-768x768.webp',
  'Kim':       'https://www.affichez.ca/wp-content/uploads/2025/05/kim-vice-presidente-chez-agence-affichez-768x768.webp',
  'Morgane':   'https://www.affichez.ca/wp-content/uploads/2025/05/Morgane-768x768.png',
  'Paul':      'https://www.affichez.ca/wp-content/uploads/2026/04/Paul-V2-768x768.png',
  'Richard':   'https://www.affichez.ca/wp-content/uploads/2025/05/richard-directeur-de-comptes-768x768.webp',
  'Sylvain':   'https://www.affichez.ca/wp-content/uploads/2025/05/sylvain_2-768x768.png',
  'Vincent':   'https://www.affichez.ca/wp-content/uploads/2026/03/Vincent-D-768x768.png',
};

function photoFor(repName: string): string | null {
  const first = repName.trim().split(' ')[0];
  return REP_PHOTOS[first] ?? null;
}

function initials(name: string): string {
  const parts = name.trim().split(' ');
  const a = parts[0] ? parts[0][0] : '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

const LOGO_URL = 'https://www.affichez.ca/wp-content/uploads/2025/05/Logo-affichez-1.png';
const BRAND_GREEN = '#154633';
const BRAND_ORANGE = '#e38800';
const HIGHLIGHT_THRESHOLD = 25000; // "Semaine à plus de 25 000 $"

// ─── Helpers ──────────────────────────────────────────────────────────────────

const cad0 = new Intl.NumberFormat('fr-CA', {
  style: 'currency', currency: 'CAD', maximumFractionDigits: 0,
});
const fmtMoney = (n: number) => cad0.format(n);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

// Convert every non-ASCII code point (accents, emoji, arrows, non-breaking
// spaces) to an HTML numeric entity so the email renders correctly no matter
// what charset the client assumes — Gmail strips <meta charset>, so we cannot
// rely on it. Iterating the string yields whole code points (emoji included).
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

// "du 6 au 12 juillet 2026"  /  "du 29 juin au 5 juillet 2026"
function frenchWeekRange(startISO: string, endISO: string): string {
  const s = parseISO(startISO);
  const e = parseISO(endISO);
  const sM = MONTHS_FR[s.getMonth()];
  const eM = MONTHS_FR[e.getMonth()];
  const y = e.getFullYear();
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `du ${s.getDate()} au ${e.getDate()} ${eM} ${y}`;
  }
  return `du ${s.getDate()} ${sM} au ${e.getDate()} ${eM} ${y}`;
}

interface WeekRow { week_start: string; week_end: string; total_amount: number; num_sales: number }
interface SummaryRow { rep_name: string; total_amount: number; num_sales: number }
interface RepStat { rep_name: string; total: number; deals: number }

function aggregateByRep(rows: SummaryRow[]): RepStat[] {
  const internal = new Set(INTERNAL_REP_NAMES);
  const map = new Map<string, RepStat>();
  for (const r of rows) {
    const key = internal.has((r.rep_name ?? '').normalize('NFC')) ? 'Vente Interne' : r.rep_name;
    const cur = map.get(key) ?? { rep_name: key, total: 0, deals: 0 };
    cur.total += Number(r.total_amount) || 0;
    cur.deals += Number(r.num_sales) || 0;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

// ─── HTML email ───────────────────────────────────────────────────────────────

function renderEmail(opts: {
  weekStart: string;
  weekRange: string;
  total: number;
  deals: number;
  prevTotal: number | null;
  leaderboard: RepStat[];
  appUrl: string;
}): string {
  const { weekStart, weekRange, total, deals, prevTotal, leaderboard, appUrl } = opts;

  const deltaPct = prevTotal && prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null;
  const deltaUp = (deltaPct ?? 0) >= 0;
  const deltaPill = deltaPct === null ? '' : `
    <span style="display:inline-block; margin-top:10px; padding:5px 12px; border-radius:20px; font-size:12px; font-weight:600;
                 background:${deltaUp ? '#e7f5ee' : '#fcebea'}; color:${deltaUp ? '#1a7a4d' : '#c0392b'};">
      ${deltaUp ? '▲' : '▼'} ${deltaUp ? '+' : ''}${deltaPct.toFixed(1).replace('.', ',')} % vs semaine précédente
    </span>`;

  const top = leaderboard.filter((r) => r.total >= HIGHLIGHT_THRESHOLD);
  const topRows = top.map((r) => {
    const photo = photoFor(r.rep_name);
    const avatar = photo
      ? `<div style="width:46px; height:46px; border-radius:50%; overflow:hidden; border:2px solid ${BRAND_ORANGE}; line-height:0; font-size:0; box-sizing:border-box;"><img src="${photo}" alt="${escapeHtml(r.rep_name)}" width="46" height="46" style="display:block; width:100%; height:100%; object-fit:cover; object-position:center center;"></div>`
      : `<div style="width:46px; height:46px; border-radius:50%; background:${BRAND_GREEN}; color:#ffffff; font-size:15px; font-weight:700; line-height:46px; text-align:center;">${escapeHtml(initials(r.rep_name))}</div>`;
    return `
      <tr>
        <td width="58" style="padding:5px 12px 5px 0; vertical-align:middle;">${avatar}</td>
        <td style="padding:5px 0; vertical-align:middle; font-size:14px; font-weight:600; color:${BRAND_GREEN};">${escapeHtml(r.rep_name)}</td>
        <td style="padding:5px 0; vertical-align:middle; text-align:right; font-size:14px; font-weight:700; color:${BRAND_ORANGE}; white-space:nowrap;">${fmtMoney(r.total)}</td>
      </tr>`;
  }).join('');
  const topCallout = top.length === 0 ? '' : `
    <tr>
      <td class="pad-section" style="background:#ffffff; padding:0 48px 8px;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
               style="background:#fff7ec; border:1.5px solid #f6d9ac; border-radius:10px;">
          <tr>
            <td style="padding:16px 20px;">
              <p style="margin:0 0 12px; font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:${BRAND_ORANGE};">
                🔥 Semaine à plus de 25 000 $
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                ${topRows}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  const rows = leaderboard.map((r, i) => {
    const isTop = r.total >= HIGHLIGHT_THRESHOLD;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    return `
      <tr>
        <td style="padding:12px 8px 12px 0; border-bottom:1px solid #eef2f0; width:34px;
                   font-size:14px; font-weight:700; color:${BRAND_GREEN}; text-align:center;">${medal}</td>
        <td style="padding:12px 8px; border-bottom:1px solid #eef2f0; font-size:14px; color:${BRAND_GREEN}; font-weight:600;">
          ${escapeHtml(r.rep_name)}
          ${isTop ? `<span style="display:inline-block; margin-left:6px; padding:2px 7px; border-radius:10px; font-size:10px; font-weight:700; background:${BRAND_ORANGE}; color:#ffffff; vertical-align:middle;">25K+</span>` : ''}
        </td>
        <td style="padding:12px 0 12px 8px; border-bottom:1px solid #eef2f0; font-size:14px; color:${BRAND_GREEN}; font-weight:700; text-align:right; white-space:nowrap;">
          ${fmtMoney(r.total)}
        </td>
        <td style="padding:12px 0 12px 12px; border-bottom:1px solid #eef2f0; font-size:12px; color:#7a8c83; text-align:right; white-space:nowrap;">
          ${r.deals} vente${r.deals > 1 ? 's' : ''}
        </td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Rapport des ventes – Affichez</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light only; }
  * { box-sizing: border-box; }
  body { margin:0; padding:0; background-color:#f0f2f0; font-family:'Poppins', Arial, sans-serif; -webkit-font-smoothing:antialiased; }
  @media (prefers-color-scheme: dark) {
    body { background-color:#f0f2f0 !important; }
    .email-container { background-color:#ffffff !important; }
    td, p, h1, h2, a, span, strong { color:inherit !important; }
  }
  @media only screen and (max-width:620px) {
    .email-wrapper { padding:0 !important; }
    .email-container { width:100% !important; border-radius:0 !important; }
    .pad-hero { padding:28px 20px 0 !important; }
    .pad-section { padding:0 20px 16px !important; }
    .pad-footer { padding:24px 20px 28px !important; }
    .pad-sides { padding:24px 20px !important; }
    .h1-title { font-size:20px !important; }
    .stat-big { font-size:34px !important; }
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

      <!-- HEADER -->
      <tr>
        <td class="pad-sides" style="background:#ffffff; padding:32px 48px 24px; text-align:center;">
          <img src="${LOGO_URL}" alt="Affichez" width="160"
               style="display:block; margin:0 auto; width:160px; max-width:100%; border:none;">
        </td>
      </tr>
      <tr><td style="background:${BRAND_ORANGE}; height:5px; font-size:0; line-height:0;">&nbsp;</td></tr>

      <!-- HERO -->
      <tr>
        <td class="pad-hero" style="background:#ffffff; padding:36px 48px 8px; text-align:center;">
          <p style="margin:0 0 6px; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:${BRAND_ORANGE};">
            Rapport hebdomadaire des ventes
          </p>
          <h1 class="h1-title" style="margin:0 0 4px; font-size:22px; font-weight:700; color:${BRAND_GREEN}; line-height:1.3;">
            Semaine ${weekRange}
          </h1>
        </td>
      </tr>

      <!-- BIG STAT -->
      <tr>
        <td style="background:#ffffff; padding:16px 48px 20px; text-align:center;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${BRAND_GREEN}; border-radius:12px;">
            <tr>
              <td style="padding:26px 20px; text-align:center;">
                <p style="margin:0 0 4px; font-size:12px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:#a9c6b7;">
                  Total des ventes
                </p>
                <p class="stat-big" style="margin:0; font-size:44px; font-weight:700; color:#ffffff; line-height:1.1;">
                  ${fmtMoney(total)}
                </p>
                <p style="margin:8px 0 0; font-size:13px; color:#cfe0d7;">
                  ${deals} vente${deals > 1 ? 's' : ''} cette semaine
                </p>
                ${deltaPill}
              </td>
            </tr>
          </table>
        </td>
      </tr>

      ${topCallout}

      <!-- LEADERBOARD -->
      <tr>
        <td class="pad-section" style="background:#ffffff; padding:16px 48px 8px;">
          <p style="margin:0 0 4px; font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:${BRAND_GREEN};">
            🏆 &nbsp;Classement de l'équipe
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:6px;">
            ${rows}
          </table>
        </td>
      </tr>

      <!-- CTA -->
      <tr>
        <td style="background:#ffffff; padding:20px 48px 40px; text-align:center;">
          <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto;">
            <tr>
              <td style="border-radius:8px; background:${BRAND_ORANGE};">
                <a href="${appUrl}/weekly?week=${weekStart}" target="_blank"
                   style="display:inline-block; padding:14px 34px; font-size:14px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:8px;">
                  Voir le rapport complet &nbsp;→
                </a>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0; font-size:12px; color:#7a8c83;">Bon week-end à toute l'équipe ! 🎉</p>
        </td>
      </tr>

      <!-- FOOTER -->
      <tr>
        <td class="pad-footer" style="background:#ffffff; padding:28px 48px 32px; text-align:center; border-top:1px solid #e8ede9;">
          <img src="${LOGO_URL}" alt="Affichez" class="logo-footer" width="120"
               style="display:block; margin:0 auto 16px; width:120px; border:none;">
          <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto 16px;">
            <tr>
              <td style="padding:0 6px;"><a href="https://www.facebook.com/affichez"><img src="https://cdn.signaturehound.com/users/18is732lm834h8p8/horynlmbphwbsa.png" alt="Facebook" width="26" height="26" style="width:26px;height:26px;display:inline-block;border:none;"></a></td>
              <td style="padding:0 6px;"><a href="https://www.instagram.com/affichez.agence"><img src="https://cdn.signaturehound.com/users/18is732lm834h8p8/horynlmbphwns0.png" alt="Instagram" width="26" height="26" style="width:26px;height:26px;display:inline-block;border:none;"></a></td>
              <td style="padding:0 6px;"><a href="https://www.linkedin.com/company/affichez/"><img src="https://cdn.signaturehound.com/users/18is732lm834h8p8/horynlmbphx2ty.png" alt="LinkedIn" width="26" height="26" style="width:26px;height:26px;display:inline-block;border:none;"></a></td>
              <td style="padding:0 6px;"><a href="https://www.tiktok.com/@affichez"><img src="https://cdn.signaturehound.com/users/18is732lm834h8p8/horynlmbphx71p.png" alt="TikTok" width="26" height="26" style="width:26px;height:26px;display:inline-block;border:none;"></a></td>
            </tr>
          </table>
          <p class="footer-phones" style="margin:0 0 6px; font-size:12px; color:#555555; line-height:2;">
            <a href="tel:4188002211" style="color:${BRAND_GREEN}; text-decoration:none; font-weight:600;">418 800-2211</a> &nbsp;|&nbsp;
            <a href="tel:5143601634" style="color:${BRAND_GREEN}; text-decoration:none; font-weight:600;">514 360-1634</a> &nbsp;|&nbsp;
            <a href="tel:18885822184" style="color:${BRAND_GREEN}; text-decoration:none; font-weight:600;">1 888 582-2184</a>
          </p>
          <p style="margin:0 0 12px; font-size:12px; color:#555555;">
            <a href="https://www.affichez.ca" style="color:${BRAND_GREEN}; text-decoration:none; font-weight:600;">www.affichez.ca</a> &nbsp;|&nbsp;
            <a href="https://promotionnel.ca" style="color:${BRAND_GREEN}; text-decoration:none; font-weight:600;">www.promotionnel.ca</a>
          </p>
          <p style="margin:0; font-size:10px; color:#888888; line-height:1.6;">
            Rapport interne automatisé — Affichez. Envoyé chaque vendredi en fin de journée.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  // Shared-secret auth (enforced only if REPORT_SECRET is configured)
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
    const rawAppUrl = Deno.env.get('APP_URL') ?? 'https://app.affichez.ca';
    const appUrl = rawAppUrl.endsWith('/') ? rawAppUrl.slice(0, -1) : rawAppUrl;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Available weeks (newest first) to resolve target + previous week
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

    // Per-rep breakdown for the target week
    const { data: sumData, error: sumErr } = await supabase
      .from('v_weekly_summary')
      .select('rep_name, total_amount, num_sales')
      .eq('week_start', target.week_start);
    if (sumErr) throw sumErr;

    const leaderboard = aggregateByRep((sumData ?? []) as SummaryRow[]);
    const total = Number(target.total_amount) || 0;
    const deals = Number(target.num_sales) || 0;
    const prevTotal = prev ? Number(prev.total_amount) || 0 : null;
    const weekRange = frenchWeekRange(target.week_start, target.week_end);

    // Pure-ASCII HTML (entities) so it renders correctly through any mail client.
    const html = toAsciiEntities(renderEmail({ weekStart: target.week_start, weekRange, total, deals, prevTotal, leaderboard, appUrl }));
    // Subject is sent as a MIME header (encoded by Gmail), so plain UTF-8 text is fine here.
    const subject = `Rapport des ventes - Semaine ${weekRange}`;

    if (preview) {
      return new Response(html, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response(JSON.stringify({
      subject,
      html,
      week_start: target.week_start,
      week_end: target.week_end,
      week_range: weekRange,
      total,
      deals,
      previous_total: prevTotal,
      leaderboard,
    }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('weekly-sales-report error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
