// Erstmalige Anlage eines Admins (höchstens 2 Admins: die beiden Inhaber).
// Geschützt durch einen geheimen Einrichtungscode (Supabase-Secret ADMIN_SETUP_CODE).
import { admin, audit, cors, env, json } from "../_shared/util.ts";

const MAX_ADMINS = 2;
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    const { name, email, password, code } = await req.json().catch(() => ({}));
    const secret = env("ADMIN_SETUP_CODE");
    if (!secret || secret.length < 12) return json(req, { error: "setup_disabled" }, 403);
    // kleine Bremse gegen Durchprobieren
    await new Promise((r) => setTimeout(r, 800));
    if (!same(String(code ?? ""), secret)) return json(req, { error: "wrong_code" }, 403);
    if (!name || !/^\S+@\S+\.\S+$/.test(email ?? "") || String(password ?? "").length < 12) {
      return json(req, { error: "invalid_input" }, 400);
    }
    const { count } = await admin.from("admins").select("user_id", { count: "exact", head: true });
    if ((count ?? 0) >= MAX_ADMINS) return json(req, { error: "admins_full" }, 403);

    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role: "admin", name } });
    if (error) return json(req, { error: error.message.includes("already") ? "email_exists" : "create_failed" }, 400);
    await admin.from("admins").insert({ user_id: data.user.id, name });
    await audit(null, "admin_created", { name, email }, data.user.id);
    return json(req, { ok: true });
  } catch (e) {
    console.error(e);
    return json(req, { error: "server_error" }, 500);
  }
});
