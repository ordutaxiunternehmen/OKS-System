// Liefert den eigentlichen Programmcode von Cockpit Plus NUR an angemeldete
// Kunden mit aktivem Abo und freigegebenem Gerät. Der Code liegt im privaten
// Speicher "app" und ist ohne diesen Weg nicht erreichbar.
import { admin, canUse, companyOf, cors, getUser, json } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const auth = await getUser(req);
  if (!auth) return json(req, { error: "not_authenticated" }, 401);
  const company = await companyOf(auth.user.id);
  if (!canUse(company)) return json(req, { error: "locked", status: company?.status ?? "none" }, 402);

  const deviceKey = req.headers.get("x-device-key") ?? "";
  const { data: dev } = await admin.from("devices").select("id, revoked")
    .eq("company_id", company!.id).eq("device_key", deviceKey).maybeSingle();
  if (!dev || dev.revoked) return json(req, { error: "device_not_allowed" }, 403);
  await admin.from("devices").update({ last_seen_at: new Date().toISOString() }).eq("id", dev.id);

  const { data, error } = await admin.storage.from("app").download("cockpit.html");
  if (error || !data) return json(req, { error: "app_missing" }, 500);
  return new Response(await data.text(), {
    headers: { ...cors(req), "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
});
