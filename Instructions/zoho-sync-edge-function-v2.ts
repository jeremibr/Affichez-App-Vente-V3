// supabase/functions/zoho-sync/index.ts  (v2)
// Supabase Edge Function — receives webhooks from Zoho Books workflow rules
// Handles: estimate accepted (upsert) and estimate declined (delete)
// week_start/week_end are computed by DB trigger, NOT sent from here

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("ZOHO_WEBHOOK_SECRET")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Department Mapping ────────────────────────────────────────────
// Must stay in sync with department_mappings table
const DEPT_MAP: Record<string, string> = {
  "MÉDIA MULTI-ANNONCEURS": "MULTI-ANNONCEURS",
  "MULTI-ANNONCEURS": "MULTI-ANNONCEURS",
  "PROMOTIONNEL": "PROMOTIONNEL",
  "DIST. PUBLICITAIRE SOLO": "DIST. PUBLICITAIRE SOLO",
  "AGENCE PUB": "NUMERIQUE",
  "NUMÉRIQUE": "NUMERIQUE",
  "APPLICATION": "APPLICATION",
  "SERVICES IA": "SERVICES IA",
};

// ─── Helper: Log webhook event ─────────────────────────────────────
async function logWebhook(
  zohoId: string | null,
  action: string,
  statusCode: number,
  payload: unknown,
  errorMessage?: string
) {
  await supabase.from("webhook_log").insert({
    zoho_id: zohoId,
    action,
    status_code: statusCode,
    payload: payload as Record<string, unknown>,
    error_message: errorMessage || null,
  });
}

// ─── Helper: Resolve rep_id from name ──────────────────────────────
async function getRepId(repName: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("reps")
    .select("id")
    .eq("name", repName.trim())
    .single();

  if (error || !data) {
    console.error(`Rep not found: "${repName}"`, error);
    return null;
  }
  return data.id;
}

// ─── Main Handler ──────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── Auth: verify shared secret ──
  const authHeader = req.headers.get("x-webhook-secret") || "";
  if (authHeader !== WEBHOOK_SECRET) {
    console.error("Unauthorized webhook attempt");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  console.log("Zoho webhook received:", JSON.stringify(payload));

  // ── Extract fields from Zoho Books estimate payload ──
  // Adjust field names to match YOUR Zoho webhook entity parameter configuration
  const zohoId = String(payload.estimate_id || payload.estimate_number || "");
  const status = String(payload.status || "").toLowerCase();
  const clientName = String(payload.customer_name || "");
  const amount = parseFloat(String(payload.total || payload.sub_total || "0"));
  const quoteNumber = String(payload.estimate_number || "");
  const saleDate = String(payload.date || "");               // YYYY-MM-DD
  const repName = String(payload.salesperson_name || "");
  const zohoDeptLabel = String(payload.cf_d_partement || ""); // Zoho API name for Département

  try {
    // ── DECLINED → Delete from DB ──
    if (status === "declined" || status === "rejected") {
      const { error } = await supabase
        .from("sales")
        .delete()
        .eq("zoho_id", zohoId);

      if (error) {
        await logWebhook(zohoId, "error", 500, payload, `Delete failed: ${error.message}`);
        return new Response(JSON.stringify({ error: "Delete failed" }), { status: 500 });
      }

      await logWebhook(zohoId, "deleted", 200, payload);
      console.log(`Deleted estimate ${zohoId} (declined)`);
      return new Response(
        JSON.stringify({ action: "deleted", zoho_id: zohoId }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── ACCEPTED → Upsert into DB ──
    if (status === "accepted") {
      // Validate required fields
      if (!zohoId || !saleDate || !repName || !zohoDeptLabel) {
        const missing = { zohoId, saleDate, repName, zohoDeptLabel };
        await logWebhook(zohoId, "error", 400, payload, `Missing fields: ${JSON.stringify(missing)}`);
        return new Response(
          JSON.stringify({ error: "Missing required fields", details: missing }),
          { status: 400 }
        );
      }

      // Resolve department
      const department = DEPT_MAP[zohoDeptLabel];
      if (!department) {
        await logWebhook(zohoId, "error", 400, payload, `Unknown department: ${zohoDeptLabel}`);
        return new Response(
          JSON.stringify({ error: `Unknown department: ${zohoDeptLabel}` }),
          { status: 400 }
        );
      }

      // Resolve rep
      const repId = await getRepId(repName);
      if (!repId) {
        await logWebhook(zohoId, "error", 400, payload, `Rep not found: ${repName}`);
        return new Response(
          JSON.stringify({ error: `Rep not found: ${repName}` }),
          { status: 400 }
        );
      }

      // Upsert — week_start/week_end are computed by DB trigger, not sent from here
      const { error } = await supabase.from("sales").upsert(
        {
          zoho_id: zohoId,
          sale_date: saleDate,
          client_name: clientName,
          amount: amount,
          quote_number: quoteNumber,
          rep_id: repId,
          zoho_department_label: zohoDeptLabel,
          department: department,
        },
        { onConflict: "zoho_id" }
      );

      if (error) {
        await logWebhook(zohoId, "error", 500, payload, `Upsert failed: ${error.message}`);
        return new Response(
          JSON.stringify({ error: "Upsert failed", details: error }),
          { status: 500 }
        );
      }

      await logWebhook(zohoId, "upserted", 200, payload);
      console.log(`Upserted estimate ${zohoId} — ${clientName} — $${amount}`);
      return new Response(
        JSON.stringify({ action: "upserted", zoho_id: zohoId, amount }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Unknown status → ignore ──
    await logWebhook(zohoId, "ignored", 200, payload);
    return new Response(
      JSON.stringify({ action: "ignored", status }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    await logWebhook(zohoId, "error", 500, payload, String(err));
    console.error("Webhook processing error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error", message: String(err) }),
      { status: 500 }
    );
  }
});
