// Gemeinsame Hilfsfunktionen für alle Server-Funktionen (Supabase Edge Functions, Deno)
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export const env = (k: string, fallback = ""): string => Deno.env.get(k) ?? fallback;

export const SUPABASE_URL = env("SUPABASE_URL");
export const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
export const ANON_KEY = env("SUPABASE_ANON_KEY");
export const APP_URL = env("APP_URL", "https://example.netlify.app"); // öffentliche Adresse der App (Netlify)
export const MOLLIE_KEY = env("MOLLIE_API_KEY");                       // test_... oder live_...
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// CORS nur für die eigene App-Adresse (und Admin-Seite auf derselben Domain)
export const cors = (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  const allowed = env("ALLOWED_ORIGINS", APP_URL).split(",").map((s) => s.trim());
  const ok = allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
};

export const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// Server-Client mit vollen Rechten (nur hier im Server, nie im Browser!)
export const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Angemeldeten Benutzer aus dem Token holen (prüft die Signatur über Supabase)
export async function getUser(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  // aal (Zwei-Faktor-Stufe) steht im Token – nach erfolgreicher Prüfung lesen wir es aus
  let aal = "aal1";
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    aal = payload.aal ?? "aal1";
  } catch { /* ignore */ }
  return { user: data.user, aal, token };
}

export async function getSettings() {
  const { data } = await admin.from("settings").select("*").eq("id", 1).single();
  return data as { price_per_vehicle: number; grace_days: number; max_devices: number; agb_version: string };
}

export async function companyOf(userId: string) {
  const { data } = await admin.from("companies").select("*").eq("owner_id", userId).maybeSingle();
  return data;
}

export const canUse = (c: { status: string; grace_until: string | null } | null) =>
  !!c && (c.status === "active" || (c.status === "past_due" && !!c.grace_until && new Date(c.grace_until) > new Date()));

export async function activeVehicleCount(companyId: string) {
  const { count } = await admin.from("vehicles").select("id", { count: "exact", head: true })
    .eq("company_id", companyId).eq("active", true);
  return count ?? 0;
}

export async function audit(companyId: string | null, action: string, details: unknown, actorId: string | null = null) {
  await admin.from("audit_log").insert({ company_id: companyId, action, details, actor_id: actorId });
}

// ---------------- Mollie ----------------
export const eur = (n: number) => ({ currency: "EUR", value: (Math.round(n * 100) / 100).toFixed(2) });

export async function mollie(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`https://api.mollie.com/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${MOLLIE_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Mollie ${res.status}: ${data?.detail ?? text}`);
  return data;
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export function addMonths(d: Date, n: number) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}
