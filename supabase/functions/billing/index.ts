// Abo & Zahlungen für den Kunden
// Aktionen (POST, JSON {action, ...}):
//   setup_sepa      – SEPA-Lastschriftmandat (IBAN) anlegen, erste Zahlung + Abo starten
//   setup_checkout  – Alternative: Bezahlseite von Mollie (Karte/PayPal), erzeugt Mandat
//   add_vehicle     – Fahrzeug hinzufügen (Abo-Betrag steigt, Restmonat anteilig)
//   remove_vehicle  – Fahrzeug abbestellen (ab nächstem Monat günstiger)
//   pay_now         – offene Beträge sofort einziehen (bei Sperre / Zahlungsproblem)
//   cancel          – Abo kündigen (zum Ende des laufenden Monats)
import {
  activeVehicleCount, addMonths, admin, APP_URL, audit, canUse, companyOf, cors, eur, FUNCTIONS_URL,
  getSettings, getUser, isoDate, json, mollie,
} from "../_shared/util.ts";

const WEBHOOK = `${FUNCTIONS_URL}/mollie-webhook`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    const auth = await getUser(req);
    if (!auth) return json(req, { error: "not_authenticated" }, 401);
    const body = await req.json().catch(() => ({}));
    const company = await companyOf(auth.user.id);
    if (!company) return json(req, { error: "no_company" }, 400);
    const s = await getSettings();
    const price = Number(s.price_per_vehicle);

    // Mollie-Kunde sicherstellen
    async function ensureCustomer() {
      if (company.mollie_customer_id) return company.mollie_customer_id as string;
      const c = await mollie("/customers", "POST", {
        name: company.company_name, email: company.email, metadata: { company_id: company.id },
      });
      await admin.from("companies").update({ mollie_customer_id: c.id }).eq("id", company.id);
      company.mollie_customer_id = c.id;
      return c.id as string;
    }

    // Abo bei Mollie anlegen bzw. Betrag anpassen
    async function upsertSubscription(customerId: string, vehicles: number, startDate: Date) {
      const amount = eur(vehicles * price);
      if (company.mollie_subscription_id) {
        await mollie(`/customers/${customerId}/subscriptions/${company.mollie_subscription_id}`, "PATCH", {
          amount, description: `Cockpit Plus – ${vehicles} Fahrzeug(e)`,
        });
        return company.mollie_subscription_id as string;
      }
      const sub = await mollie(`/customers/${customerId}/subscriptions`, "POST", {
        amount, interval: "1 month", startDate: isoDate(startDate),
        description: `Cockpit Plus – ${vehicles} Fahrzeug(e)`,
        webhookUrl: WEBHOOK, metadata: { company_id: company.id },
      });
      await admin.from("companies").update({
        mollie_subscription_id: sub.id, next_charge_on: isoDate(startDate),
      }).eq("id", company.id);
      company.mollie_subscription_id = sub.id;
      return sub.id as string;
    }

    async function recordPayment(p: any, kind: string, vehicles: number | null) {
      await admin.from("payments").upsert({
        company_id: company.id, mollie_payment_id: p.id, kind, amount: Number(p.amount.value),
        status: p.status, description: p.description, vehicles_count: vehicles,
      }, { onConflict: "mollie_payment_id" });
    }

    switch (body.action) {
      // ------------------------------------------------------------------
      case "setup_sepa": {
        const { iban, account_holder, mandate_accepted } = body;
        if (!mandate_accepted) return json(req, { error: "mandate_not_accepted" }, 400);
        const cleanIban = String(iban ?? "").replace(/\s+/g, "").toUpperCase();
        if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(cleanIban)) return json(req, { error: "iban_invalid" }, 400);
        if (!account_holder) return json(req, { error: "holder_missing" }, 400);

        const customerId = await ensureCustomer();
        const mandate = await mollie(`/customers/${customerId}/mandates`, "POST", {
          method: "directdebit", consumerName: account_holder, consumerAccount: cleanIban,
          signatureDate: isoDate(new Date()), mandateReference: `CP-${company.id.slice(0, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
        });
        await admin.from("companies").update({ mollie_mandate_id: mandate.id }).eq("id", company.id);

        const vehicles = await activeVehicleCount(company.id);
        // Erster Monat sofort, danach monatlich per Abo
        const first = await mollie("/payments", "POST", {
          amount: eur(vehicles * price), customerId, mandateId: mandate.id, sequenceType: "recurring",
          description: `Cockpit Plus – erster Monat – ${vehicles} Fahrzeug(e)`,
          webhookUrl: WEBHOOK, metadata: { company_id: company.id, kind: "first", vehicles },
        });
        await recordPayment(first, "first", vehicles);
        await upsertSubscription(customerId, vehicles, addMonths(new Date(), 1));
        // Sofort freischalten – Lastschrift ist unterwegs. Platzt sie, setzt der Webhook auf "past_due".
        await admin.from("companies").update({ status: "active", grace_until: null, locked_reason: null }).eq("id", company.id);
        await audit(company.id, "sepa_setup", { vehicles }, auth.user.id);
        return json(req, { ok: true, status: "active" });
      }

      // ------------------------------------------------------------------
      case "setup_checkout": {
        const customerId = await ensureCustomer();
        const vehicles = await activeVehicleCount(company.id);
        const p = await mollie("/payments", "POST", {
          amount: eur(vehicles * price), customerId, sequenceType: "first",
          description: `Cockpit Plus – erster Monat – ${vehicles} Fahrzeug(e)`,
          redirectUrl: `${APP_URL}/?zahlung=fertig`, webhookUrl: WEBHOOK,
          metadata: { company_id: company.id, kind: "first_checkout", vehicles },
        });
        await recordPayment(p, "first", vehicles);
        return json(req, { ok: true, checkoutUrl: p._links.checkout.href });
      }

      // ------------------------------------------------------------------
      case "add_vehicle": {
        if (!canUse(company)) return json(req, { error: "locked" }, 403);
        const { label, konzession, kennzeichen } = body;
        if (!label) return json(req, { error: "label_missing" }, 400);
        const { data: v, error } = await admin.from("vehicles").insert({
          company_id: company.id, label, konzession, kennzeichen,
        }).select().single();
        if (error) throw error;
        const vehicles = await activeVehicleCount(company.id);

        if (company.mollie_subscription_id && company.mollie_customer_id) {
          await upsertSubscription(company.mollie_customer_id, vehicles, new Date());
          // Restmonat anteilig berechnen
          const next = company.next_charge_on ? new Date(company.next_charge_on) : addMonths(new Date(), 1);
          const days = Math.max(0, Math.ceil((next.getTime() - Date.now()) / 86400000));
          const prorated = Math.round(price * Math.min(1, days / 30) * 100) / 100;
          if (prorated >= 1 && company.mollie_mandate_id) {
            const p = await mollie("/payments", "POST", {
              amount: eur(prorated), customerId: company.mollie_customer_id, mandateId: company.mollie_mandate_id,
              sequenceType: "recurring", description: `Cockpit Plus – anteilig ${days} Tage – ${label}`,
              webhookUrl: WEBHOOK, metadata: { company_id: company.id, kind: "prorated", vehicle_id: v.id },
            });
            await recordPayment(p, "prorated", 1);
          }
        }
        await audit(company.id, "vehicle_added", { vehicle_id: v.id, label }, auth.user.id);
        return json(req, { ok: true, vehicle: v, vehicles });
      }

      // ------------------------------------------------------------------
      case "remove_vehicle": {
        const { vehicle_id } = body;
        const count = await activeVehicleCount(company.id);
        if (count <= 1) return json(req, { error: "last_vehicle" }, 400);
        const { error } = await admin.from("vehicles").update({ active: false, removed_at: new Date().toISOString() })
          .eq("id", vehicle_id).eq("company_id", company.id);
        if (error) throw error;
        if (company.mollie_subscription_id && company.mollie_customer_id) {
          await upsertSubscription(company.mollie_customer_id, count - 1, new Date());
        }
        await audit(company.id, "vehicle_removed", { vehicle_id }, auth.user.id);
        return json(req, { ok: true, vehicles: count - 1 });
      }

      // ------------------------------------------------------------------
      case "pay_now": {
        if (!company.mollie_customer_id) return json(req, { error: "no_payment_setup" }, 400);
        const { data: open } = await admin.from("payments").select("amount,status")
          .eq("company_id", company.id).in("status", ["failed", "expired", "canceled", "charged_back"]);
        const { data: paidLater } = await admin.from("payments").select("amount").eq("company_id", company.id)
          .eq("kind", "reactivation").eq("status", "paid");
        const due = (open ?? []).reduce((a, p) => a + Number(p.amount), 0) - (paidLater ?? []).reduce((a, p) => a + Number(p.amount), 0);
        const amount = Math.max(due, 1);
        if (body.method === "checkout" || !company.mollie_mandate_id) {
          const p = await mollie("/payments", "POST", {
            amount: eur(amount), customerId: company.mollie_customer_id, sequenceType: "first",
            description: "Cockpit Plus – offener Betrag", redirectUrl: `${APP_URL}/?zahlung=fertig`,
            webhookUrl: WEBHOOK, metadata: { company_id: company.id, kind: "reactivation" },
          });
          await recordPayment(p, "reactivation", null);
          return json(req, { ok: true, checkoutUrl: p._links.checkout.href });
        }
        const p = await mollie("/payments", "POST", {
          amount: eur(amount), customerId: company.mollie_customer_id, mandateId: company.mollie_mandate_id,
          sequenceType: "recurring", description: "Cockpit Plus – offener Betrag",
          webhookUrl: WEBHOOK, metadata: { company_id: company.id, kind: "reactivation" },
        });
        await recordPayment(p, "reactivation", null);
        return json(req, { ok: true, pending: true });
      }

      // ------------------------------------------------------------------
      case "cancel": {
        if (company.mollie_subscription_id && company.mollie_customer_id) {
          await mollie(`/customers/${company.mollie_customer_id}/subscriptions/${company.mollie_subscription_id}`, "DELETE");
        }
        const until = company.next_charge_on ?? isoDate(addMonths(new Date(), 1));
        await admin.from("companies").update({ cancel_at: until, mollie_subscription_id: null }).eq("id", company.id);
        await audit(company.id, "cancelled", { until }, auth.user.id);
        return json(req, { ok: true, until });
      }

      default:
        return json(req, { error: "unknown_action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json(req, { error: "server_error", detail: String((e as Error).message ?? e) }, 500);
  }
});
