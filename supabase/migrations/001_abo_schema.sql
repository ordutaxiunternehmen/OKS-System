-- =====================================================================
-- Cockpit Plus – Abo-Verfahren
-- Datenbank-Schema für Supabase (PostgreSQL)
-- Einmal komplett im Supabase SQL-Editor ausführen.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Einstellungen (Preis, Kulanzfrist, Geräte-Limit, aktuelle AGB-Version)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id               int primary key default 1 check (id = 1),
  price_per_vehicle numeric(10,2) not null default 7.00,   -- € pro Fahrzeug und Monat
  grace_days       int not null default 14,                 -- Tage bis zur Sperre nach fehlgeschlagener Zahlung
  max_devices      int not null default 3,                  -- Standard: Geräte pro Konto
  agb_version      text not null default '1.0',
  updated_at       timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------------
-- Admins (nur die Inhaber)
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------
-- Unternehmer (ein Konto pro Unternehmer)
-- ---------------------------------------------------------------------
do $$ begin
  create type public.company_status as enum
    ('pending',    -- registriert, Zahlung noch nicht eingerichtet
     'active',     -- bezahlt
     'past_due',   -- Zahlung fehlgeschlagen, Kulanzfrist läuft (Nutzung noch möglich)
     'locked',     -- gesperrt
     'cancelled'); -- gekündigt
exception when duplicate_object then null; end $$;

create table if not exists public.companies (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null unique references auth.users(id) on delete cascade,
  company_name           text not null,
  contact_name           text not null,
  street                 text,
  zip                    text,
  city                   text,
  phone                  text,
  email                  text not null,
  vat_id                 text,
  status                 public.company_status not null default 'pending',
  grace_until            timestamptz,
  locked_reason          text,
  max_devices            int,               -- null = Standard aus settings
  mollie_customer_id     text unique,
  mollie_mandate_id      text,
  payment_method         text,              -- z. B. SEPA-Lastschrift, Kreditkarte, PayPal
  mollie_subscription_id text,
  next_charge_on         date,
  cancel_at              date,              -- Kündigung wirksam zum
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Darf dieses Konto die App gerade benutzen?
alter table public.companies add column if not exists payment_method text;

create or replace function public.company_can_use(c public.companies) returns boolean
language sql stable as $$
  select c.status = 'active'
      or (c.status = 'past_due' and c.grace_until is not null and c.grace_until > now());
$$;

create or replace function public.my_company_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.companies where owner_id = auth.uid();
$$;

create or replace function public.my_company_active() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public.company_can_use(c) from public.companies c where owner_id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------
-- Fahrzeuge (jedes Fahrzeug = eigener Bereich, eigenes Abo-Stück)
-- ---------------------------------------------------------------------
create table if not exists public.vehicles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  label       text not null,             -- z. B. "Taxi 1234"
  konzession  text,                      -- Konzessionsnummer
  kennzeichen text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  removed_at  timestamptz
);
create index if not exists vehicles_company_idx on public.vehicles(company_id) where active;

-- ---------------------------------------------------------------------
-- Geräte + PIN
-- ---------------------------------------------------------------------
create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  device_key   text not null,            -- zufällige ID, die das Gerät beim ersten Login erzeugt
  device_name  text,
  pin_hash     text,                     -- bcrypt, nie im Klartext
  pin_failed   int not null default 0,
  revoked      boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (company_id, device_key)
);

-- ---------------------------------------------------------------------
-- AGB-Zustimmungen (Nachweis)
-- ---------------------------------------------------------------------
create table if not exists public.agb_acceptances (
  id          bigserial primary key,
  company_id  uuid references public.companies(id) on delete set null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  agb_version text not null,
  accepted_at timestamptz not null default now(),
  ip          text,
  user_agent  text
);
create index if not exists agb_user_idx on public.agb_acceptances(user_id, agb_version);

-- ---------------------------------------------------------------------
-- Zahlungen (kommen automatisch über den Mollie-Webhook)
-- ---------------------------------------------------------------------
create table if not exists public.payments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  mollie_payment_id text not null unique,
  kind              text not null default 'recurring',  -- first | recurring | prorated | reactivation
  amount            numeric(10,2) not null,
  status            text not null,                      -- open | pending | paid | failed | expired | canceled | charged_back
  description       text,
  vehicles_count    int,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists payments_company_idx on public.payments(company_id, created_at desc);

-- ---------------------------------------------------------------------
-- Daten der App, getrennt pro Fahrzeug
-- (Kassenbuch, Fahrtenbuch, Schichtauswertung – Schlüssel/Wert wie in der App)
-- ---------------------------------------------------------------------
create table if not exists public.vehicle_kv (
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  key        text not null,
  value      text,
  updated_at timestamptz not null default now(),
  primary key (vehicle_id, key)
);

-- ---------------------------------------------------------------------
-- Protokoll für Admin-Aktionen
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id         bigserial primary key,
  actor_id   uuid,
  company_id uuid,
  action     text not null,
  details    jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- updated_at automatisch
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists companies_touch on public.companies;
create trigger companies_touch before update on public.companies
  for each row execute function public.touch_updated_at();
drop trigger if exists payments_touch on public.payments;
create trigger payments_touch before update on public.payments
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- Zugriffsregeln (Row Level Security)
-- Grundsatz: Kunden lesen nur ihr eigenes Konto. Alles, was Geld oder
-- Status betrifft, ändert nur der Server (Edge Functions mit Service-Key).
-- =====================================================================
alter table public.settings        enable row level security;
alter table public.admins          enable row level security;
alter table public.companies       enable row level security;
alter table public.vehicles        enable row level security;
alter table public.devices         enable row level security;
alter table public.agb_acceptances enable row level security;
alter table public.payments        enable row level security;
alter table public.vehicle_kv      enable row level security;
alter table public.audit_log       enable row level security;

-- settings: alle angemeldeten dürfen lesen (Preis, AGB-Version)
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (true);

-- admins: nur Admins sehen die Liste
drop policy if exists admins_read on public.admins;
create policy admins_read on public.admins for select to authenticated using (public.is_admin());

-- companies: eigenes Konto lesen; Admins alles lesen. Schreiben nur Server.
drop policy if exists companies_read on public.companies;
create policy companies_read on public.companies for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

-- vehicles: eigene lesen; Admins alles. Anlegen/Entfernen nur über Server (wegen Abo-Betrag).
drop policy if exists vehicles_read on public.vehicles;
create policy vehicles_read on public.vehicles for select to authenticated
  using (company_id = public.my_company_id() or public.is_admin());
drop policy if exists vehicles_rename on public.vehicles;
create policy vehicles_rename on public.vehicles for update to authenticated
  using (company_id = public.my_company_id() and public.my_company_active())
  with check (company_id = public.my_company_id());

-- devices: eigene lesen (ohne PIN-Hash über View), Admins alles
drop policy if exists devices_read on public.devices;
create policy devices_read on public.devices for select to authenticated
  using (company_id = public.my_company_id() or public.is_admin());

-- AGB: eigene lesen, Admins alles
drop policy if exists agb_read on public.agb_acceptances;
create policy agb_read on public.agb_acceptances for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- payments: eigene lesen, Admins alles
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated
  using (company_id = public.my_company_id() or public.is_admin());

-- vehicle_kv: NUR bei aktivem Abo und nur eigene Fahrzeuge. Admins sehen KEINE Kundendaten.
drop policy if exists kv_all on public.vehicle_kv;
create policy kv_all on public.vehicle_kv for all to authenticated
  using (
    public.my_company_active()
    and exists (select 1 from public.vehicles v
                where v.id = vehicle_kv.vehicle_id and v.active
                  and v.company_id = public.my_company_id()))
  with check (
    public.my_company_active()
    and exists (select 1 from public.vehicles v
                where v.id = vehicle_kv.vehicle_id and v.active
                  and v.company_id = public.my_company_id()));

-- audit_log: nur Admins lesen
drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated using (public.is_admin());

-- PIN-Hash niemals an den Client geben
revoke all on public.devices from anon, authenticated;
grant select (id, company_id, device_key, device_name, pin_failed, revoked, created_at, last_seen_at)
  on public.devices to authenticated;

-- =====================================================================
-- Funktionen, die der Kunde aufrufen darf (sicher, serverseitig geprüft)
-- =====================================================================

-- Konto nach Registrierung anlegen + AGB-Zustimmung speichern
create or replace function public.register_company(
  p_company_name text, p_contact_name text, p_street text, p_zip text, p_city text,
  p_phone text, p_vat_id text, p_agb_version text, p_user_agent text,
  p_vehicles jsonb  -- [{label, konzession, kennzeichen}, ...]
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid; v_email text; v_current text; v jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select agb_version into v_current from settings where id = 1;
  if p_agb_version is distinct from v_current then raise exception 'agb_version_mismatch'; end if;
  if jsonb_array_length(coalesce(p_vehicles,'[]'::jsonb)) < 1 then raise exception 'min_one_vehicle'; end if;
  select email into v_email from auth.users where id = auth.uid();

  insert into companies (owner_id, company_name, contact_name, street, zip, city, phone, email, vat_id)
  values (auth.uid(), p_company_name, p_contact_name, p_street, p_zip, p_city, p_phone, v_email, p_vat_id)
  returning id into v_company;

  for v in select * from jsonb_array_elements(p_vehicles) loop
    insert into vehicles (company_id, label, konzession, kennzeichen)
    values (v_company, coalesce(nullif(v->>'label',''),'Fahrzeug'), v->>'konzession', v->>'kennzeichen');
  end loop;

  insert into agb_acceptances (company_id, user_id, agb_version, ip, user_agent)
  values (v_company, auth.uid(), p_agb_version,
          current_setting('request.headers', true)::json->>'x-forwarded-for', p_user_agent);
  return v_company;
end $$;

-- Neue AGB-Version bestätigen (bei späteren Änderungen)
create or replace function public.accept_agb(p_agb_version text, p_user_agent text) returns void
language plpgsql security definer set search_path = public as $$
declare v_current text;
begin
  select agb_version into v_current from settings where id = 1;
  if p_agb_version is distinct from v_current then raise exception 'agb_version_mismatch'; end if;
  insert into agb_acceptances (company_id, user_id, agb_version, ip, user_agent)
  values (my_company_id(), auth.uid(), p_agb_version,
          current_setting('request.headers', true)::json->>'x-forwarded-for', p_user_agent);
end $$;

-- Status für die App (eine Abfrage beim Start)
create or replace function public.my_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'company', (select to_jsonb(c) - 'mollie_customer_id' - 'mollie_mandate_id' - 'mollie_subscription_id'
                from companies c where owner_id = auth.uid()),
    'can_use', my_company_active(),
    'vehicles', coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'konzession',konzession,'kennzeichen',kennzeichen) order by created_at)
                          from vehicles where company_id = my_company_id() and active), '[]'::jsonb),
    'agb_current', (select agb_version from settings where id=1),
    'agb_accepted', exists (select 1 from agb_acceptances a, settings s
                            where a.user_id = auth.uid() and a.agb_version = s.agb_version and s.id=1),
    'price_per_vehicle', (select price_per_vehicle from settings where id=1),
    'is_admin', is_admin()
  );
$$;

-- Gerät anmelden (mit Geräte-Limit) und PIN setzen
create or replace function public.register_device(p_device_key text, p_device_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_limit int; v_count int; v_dev devices;
begin
  v_company := my_company_id();
  if v_company is null then raise exception 'no_company'; end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'pin_format'; end if;

  select * into v_dev from devices where company_id = v_company and device_key = p_device_key;
  if found and v_dev.revoked then raise exception 'device_revoked'; end if;

  if not found then
    select coalesce(c.max_devices, s.max_devices) into v_limit
      from companies c, settings s where c.id = v_company and s.id = 1;
    select count(*) into v_count from devices where company_id = v_company and not revoked;
    if v_count >= v_limit then raise exception 'device_limit'; end if;
    insert into devices (company_id, device_key, device_name, pin_hash, last_seen_at)
    values (v_company, p_device_key, p_device_name, crypt(p_pin, gen_salt('bf')), now());
  else
    update devices set pin_hash = crypt(p_pin, gen_salt('bf')), pin_failed = 0, last_seen_at = now(),
                       device_name = coalesce(p_device_name, device_name)
     where id = v_dev.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- PIN prüfen (nach 5 Fehlversuchen wird das Gerät gesperrt -> neu anmelden)
create or replace function public.verify_pin(p_device_key text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dev devices;
begin
  select * into v_dev from devices where company_id = my_company_id() and device_key = p_device_key;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_device'); end if;
  if v_dev.revoked then return jsonb_build_object('ok', false, 'reason', 'device_revoked'); end if;
  if v_dev.pin_hash is null then return jsonb_build_object('ok', false, 'reason', 'no_pin'); end if;
  if v_dev.pin_hash = crypt(p_pin, v_dev.pin_hash) then
    update devices set pin_failed = 0, last_seen_at = now() where id = v_dev.id;
    return jsonb_build_object('ok', true);
  end if;
  update devices set pin_failed = pin_failed + 1,
                     pin_hash = case when pin_failed + 1 >= 5 then null else pin_hash end
   where id = v_dev.id;
  return jsonb_build_object('ok', false, 'reason', case when v_dev.pin_failed + 1 >= 5 then 'too_many' else 'wrong_pin' end,
                            'left', greatest(0, 4 - v_dev.pin_failed));
end $$;

-- Gerätestatus abfragen (ohne PIN-Versuch zu verbrauchen)
create or replace function public.device_state(p_device_key text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select case when revoked then 'revoked' when pin_hash is null then 'no_pin' else 'ok' end
                   from devices where company_id = my_company_id() and device_key = p_device_key), 'unknown');
$$;

-- Fahrzeug umbenennen (Kunde)
-- (Anlegen/Entfernen läuft über die Edge Function "billing", weil sich der Abo-Betrag ändert)

grant execute on function public.register_company(text,text,text,text,text,text,text,text,text,jsonb) to authenticated;
grant execute on function public.accept_agb(text,text) to authenticated;
grant execute on function public.my_status() to authenticated;
grant execute on function public.register_device(text,text,text) to authenticated;
grant execute on function public.verify_pin(text,text) to authenticated;
grant execute on function public.device_state(text) to authenticated;

-- =====================================================================
-- Admin-Übersicht (nur für Admins lesbar, über Funktion)
-- =====================================================================
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  -- Admin-Daten nur mit Zwei-Faktor-Anmeldung
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then raise exception 'mfa_required'; end if;
  return jsonb_build_object(
    'kpi', jsonb_build_object(
      'companies_total',   (select count(*) from companies where status <> 'cancelled'),
      'companies_active',  (select count(*) from companies where status = 'active'),
      'companies_past_due',(select count(*) from companies where status = 'past_due'),
      'companies_locked',  (select count(*) from companies where status = 'locked'),
      'companies_pending', (select count(*) from companies where status = 'pending'),
      'vehicles_active',   (select count(*) from vehicles v join companies c on c.id=v.company_id
                             where v.active and c.status in ('active','past_due')),
      'mrr', (select coalesce(count(*),0) * (select price_per_vehicle from settings where id=1)
              from vehicles v join companies c on c.id=v.company_id
              where v.active and c.status in ('active','past_due')),
      'paid_this_month', (select coalesce(sum(amount),0) from payments
                          where status='paid' and paid_at >= date_trunc('month', now())),
      'new_this_month', (select count(*) from companies where created_at >= date_trunc('month', now())),
      'cancelled_this_month', (select count(*) from companies where cancel_at is not null and updated_at >= date_trunc('month', now())),
      'paid_last_month', (select coalesce(sum(amount),0) from payments where status='paid'
                          and paid_at >= date_trunc('month', now()) - interval '1 month' and paid_at < date_trunc('month', now())),
      'open_amount', (select coalesce(sum(amount),0) from payments where status in ('failed','expired','charged_back'))
    ),
    -- Einnahmen der letzten 12 Monate (bestätigte Zahlungen)
    'revenue_months', coalesce((
      select jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
               'paid', (select coalesce(sum(amount),0) from payments
                        where status = 'paid' and paid_at >= m and paid_at < m + interval '1 month')) order by m)
      from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m), '[]'::jsonb),
    'price_per_vehicle', (select price_per_vehicle from settings where id = 1),
    'companies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'company_name', c.company_name, 'contact_name', c.contact_name,
        'email', c.email, 'phone', c.phone, 'city', c.city, 'status', c.status,
        'grace_until', c.grace_until, 'locked_reason', c.locked_reason, 'payment_method', c.payment_method, 'cancel_at', c.cancel_at,
        'created_at', c.created_at, 'next_charge_on', c.next_charge_on,
        'vehicles', (select count(*) from vehicles v where v.company_id=c.id and v.active),
        'last_payment', (select jsonb_build_object('amount',p.amount,'status',p.status,'at',coalesce(p.paid_at,p.created_at))
                         from payments p where p.company_id=c.id order by p.created_at desc limit 1),
        'devices', (select count(*) from devices d where d.company_id=c.id and not d.revoked)
      ) order by c.created_at desc) from companies c), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_company_detail(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then raise exception 'mfa_required'; end if;
  return jsonb_build_object(
    'company', (select to_jsonb(c) from companies c where id = p_company),
    'vehicles', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at) from vehicles v where company_id = p_company), '[]'),
    'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc) from payments p where company_id = p_company), '[]'),
    'devices', coalesce((select jsonb_agg(to_jsonb(d) - 'pin_hash' order by d.created_at) from devices d where company_id = p_company), '[]'),
    'agb', coalesce((select jsonb_agg(to_jsonb(a) order by a.accepted_at desc) from agb_acceptances a where company_id = p_company), '[]'),
    'audit', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at desc) from audit_log l where company_id = p_company), '[]')
  );
end $$;

grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_company_detail(uuid) to authenticated;

-- Letzte Zahlungen aller Kunden (Admin)
create or replace function public.admin_payments(p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then raise exception 'mfa_required'; end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select p.id, p.company_id, c.company_name, p.amount, p.status, p.kind, p.description,
           p.paid_at, p.created_at
      from payments p join companies c on c.id = p.company_id
     order by p.created_at desc limit least(greatest(p_limit,1),1000)) x), '[]'::jsonb);
end $$;
grant execute on function public.admin_payments(int) to authenticated;

-- Einstellungen lesen (Admin)
create or replace function public.admin_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object('settings', (select to_jsonb(s) from settings s where id = 1),
                            'admins', (select jsonb_agg(jsonb_build_object('name', a.name, 'email', u.email, 'since', a.created_at))
                                       from admins a join auth.users u on u.id = a.user_id));
end $$;
grant execute on function public.admin_settings() to authenticated;


-- =====================================================================
-- Speicher für Dateien (Belege, PDFs) – privat, pro Fahrzeug
-- Pfad: <vehicle_id>/<schlüssel>
-- Und ein privater Speicher "app" für den eigentlichen Programmcode.
-- =====================================================================
insert into storage.buckets (id, name, public) values ('vehicle-files', 'vehicle-files', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('app', 'app', false)
  on conflict (id) do nothing;

drop policy if exists vf_all on storage.objects;
create policy vf_all on storage.objects for all to authenticated
  using (
    bucket_id = 'vehicle-files' and public.my_company_active()
    and exists (select 1 from public.vehicles v
                where v.id::text = (storage.foldername(name))[1]
                  and v.active and v.company_id = public.my_company_id()))
  with check (
    bucket_id = 'vehicle-files' and public.my_company_active()
    and exists (select 1 from public.vehicles v
                where v.id::text = (storage.foldername(name))[1]
                  and v.active and v.company_id = public.my_company_id()));
-- Bucket "app": keine Policy -> nur der Server (Service-Key) kommt heran.

-- =====================================================================
-- Tägliche Sperrprüfung (Supabase -> Database -> Cron aktivieren)
-- Sperrt Konten, deren Kulanzfrist abgelaufen ist.
-- =====================================================================
create or replace function public.lock_overdue_companies() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with x as (
    update companies set status = 'locked', locked_reason = 'Zahlung nicht eingegangen'
     where status = 'past_due' and grace_until is not null and grace_until <= now()
    returning id)
  insert into audit_log (company_id, action, details)
  select id, 'auto_lock', jsonb_build_object('reason','grace_expired') from x;
  get diagnostics n = row_count;
  -- Gekündigte Konten zum Laufzeitende beenden
  update companies set status = 'cancelled'
   where cancel_at is not null and cancel_at <= current_date and status <> 'cancelled';
  return n;
end $$;

-- Falls pg_cron aktiviert ist:
-- select cron.schedule('cockpit-lock-overdue', '15 3 * * *', $$select public.lock_overdue_companies()$$);
