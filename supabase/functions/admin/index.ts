// Aktionen für den Admin-Bereich (nur Inhaber, nur mit Zwei-Faktor-Anmeldung)
//   lock            {company_id, reason}
//   unlock          {company_id}
//   revoke_device   {device_id}
//   reset_devices   {company_id}       – alle Geräte abmelden (z. B. neues Handy)
//   set_max_devices {company_id, max}
import { admin, audit, cors, getUser, json } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    const auth = await getUser(req);
    if (!auth) return json(req, { error: "not_authenticated" }, 401);
    const { data: isAdmin } = await admin.from("admins").select("user_id").eq("user_id", auth.user.id).maybeSingle();
    if (!isAdmin) return json(req, { error: "forbidden" }, 403);
    if (auth.aal !== "aal2") return json(req, { error: "mfa_required" }, 403);

    const b = await req.json().catch(() => ({}));
    const actor = auth.user.id;
    switch (b.action) {
      case "lock":
        await admin.from("companies").update({ status: "locked", locked_reason: b.reason || "Durch Admin gesperrt" }).eq("id", b.company_id);
        await audit(b.company_id, "admin_lock", { reason: b.reason }, actor);
        break;
      case "unlock":
        await admin.from("companies").update({ status: "active", grace_until: null, locked_reason: null }).eq("id", b.company_id);
        await audit(b.company_id, "admin_unlock", {}, actor);
        break;
      case "revoke_device": {
        const { data: d } = await admin.from("devices").update({ revoked: true, pin_hash: null }).eq("id", b.device_id).select("company_id").single();
        await audit(d?.company_id ?? null, "admin_revoke_device", { device_id: b.device_id }, actor);
        break;
      }
      case "reset_devices":
        await admin.from("devices").delete().eq("company_id", b.company_id);
        await audit(b.company_id, "admin_reset_devices", {}, actor);
        break;
      case "set_max_devices":
        await admin.from("companies").update({ max_devices: Number(b.max) || null }).eq("id", b.company_id);
        await audit(b.company_id, "admin_max_devices", { max: b.max }, actor);
        break;
      default:
        return json(req, { error: "unknown_action" }, 400);
    }
    return json(req, { ok: true });
  } catch (e) {
    console.error(e);
    return json(req, { error: "server_error", detail: String((e as Error).message ?? e) }, 500);
  }
});
