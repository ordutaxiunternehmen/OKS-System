// Täglich aufrufen (Supabase Cron oder externer Cron mit geheimem Schlüssel):
// sperrt Konten mit abgelaufener Kulanzfrist und beendet gekündigte Konten.
import { admin, env } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) return new Response("forbidden", { status: 403 });
  const { data, error } = await admin.rpc("lock_overdue_companies");
  if (error) return new Response(error.message, { status: 500 });
  return new Response(JSON.stringify({ locked: data }), { headers: { "Content-Type": "application/json" } });
});
