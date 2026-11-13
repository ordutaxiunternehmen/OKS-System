// Mollie meldet hier jede Zahlungsänderung (POST, Formular "id=tr_...").
// Sicherheit: Wir vertrauen dem Aufruf NICHT, sondern holen die Zahlung immer
// selbst mit unserem geheimen Schlüssel bei Mollie ab.
import { addMonths, admin, audit, eur, FUNCTIONS_URL, getSettings, isoDate, mollie } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  try {
    const form = await req.formData().catch(() => null);
    const id = String(form?.get("id") ?? "");
    if (!/^tr_[A-Za-z0-9]+$/.test(id)) return new Response("ignored", { status: 200 });

    const p = await mollie(`/payments/${id}`);
    const { data: company } = await admin.from("companies").select("*")
      .eq("mollie_customer_id", p.customerId).maybeSingle();
    if (!company) { console.warn("Unbekannter Kunde", p.customerId); return new Response("ok"); }

    const chargedBack = p.amountChargedBack && Number(p.amountChargedBack.value) > 0;
    const status = chargedBack ? "charged_back" : p.status;
    const kind = p.subscriptionId ? "recurring" : (p.metadata?.kind ?? "recurring").replace("first_checkout", "first");

    await admin.from("payments").upsert({
      company_id: company.id, mollie_payment_id: p.id, kind, amount: Number(p.amount.value), status,
      description: p.description, paid_at: p.paidAt ?? null,
      vehicles_count: p.metadata?.vehicles ?? null,
    }, { onConflict: "mollie_payment_id" });

    const s = await getSettings();

    if (status === "paid") {
      // Erste Zahlung über Bezahlseite -> Mandat merken und Abo starten
      if (p.sequenceType === "first" && p.mandateId) {
        const patch: Record<string, unknown> = { mollie_mandate_id: p.mandateId };
        if (!company.mollie_subscription_id && p.metadata?.kind === "first_checkout") {
          const { count } = await admin.from("vehicles").select("id", { count: "exact", head: true })
            .eq("company_id", company.id).eq("active", true);
          const start = addMonths(new Date(), 1);
          const sub = await mollie(`/customers/${p.customerId}/subscriptions`, "POST", {
            amount: eur((count ?? 1) * Number(s.price_per_vehicle)), interval: "1 month",
            startDate: isoDate(start), description: `Cockpit Plus – ${count} Fahrzeug(e)`,
            webhookUrl: `${FUNCTIONS_URL}/mollie-webhook`, metadata: { company_id: company.id },
          });
          patch.mollie_subscription_id = sub.id;
          patch.next_charge_on = isoDate(start);
        }
        await admin.from("companies").update(patch).eq("id", company.id);
      }
      // Nächsten Abbuchungstermin aktualisieren
      if (p.subscriptionId) {
        try {
          const sub = await mollie(`/customers/${p.customerId}/subscriptions/${p.subscriptionId}`);
          if (sub.nextPaymentDate) await admin.from("companies").update({ next_charge_on: sub.nextPaymentDate }).eq("id", company.id);
        } catch { /* nicht kritisch */ }
      }
      // Freischalten, wenn nichts mehr offen ist
      const { data: stillOpen } = await admin.from("payments").select("id, created_at")
        .eq("company_id", company.id).in("status", ["failed", "expired", "charged_back"])
        .gt("created_at", new Date(Date.now() - 1000 * 3600 * 24 * 60).toISOString());
      const reactivated = p.metadata?.kind === "reactivation";
      if (company.status !== "cancelled" && (reactivated || !stillOpen?.length) && company.status !== "active") {
        if (reactivated && stillOpen?.length) {
          // offene Posten sind mit dieser Zahlung beglichen
          await admin.from("payments").update({ status: "settled" }).in("id", stillOpen.map((x) => x.id));
        }
        await admin.from("companies").update({ status: "active", grace_until: null, locked_reason: null }).eq("id", company.id);
        await audit(company.id, "auto_unlock", { payment: p.id });
      }
    } else if (["failed", "expired", "charged_back"].includes(status)) {
      // Zahlung geplatzt -> Kulanzfrist starten (App läuft weiter, Hinweis wird angezeigt)
      if (company.status === "active") {
        const grace = new Date(Date.now() + Number(s.grace_days) * 86400000).toISOString();
        await admin.from("companies").update({ status: "past_due", grace_until: grace }).eq("id", company.id);
        await audit(company.id, "payment_failed", { payment: p.id, status, grace_until: grace });
        // TODO E-Mail-Erinnerung: hier z. B. über Resend/Brevo versenden (siehe README)
      }
    }
    return new Response("ok");
  } catch (e) {
    console.error(e);
    // 500 -> Mollie versucht es später automatisch erneut
    return new Response("error", { status: 500 });
  }
});
