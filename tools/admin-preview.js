// Nur für die Vorschau in Claude (nicht im Netlify-Paket): Beispieldaten für die Admin-App.
window.CP_ADMIN_PREVIEW = (function(){
  const now = Date.now(), day = 864e5, P = 7;
  const names = [['Taxi Yilmaz','Mehmet Yilmaz','Berlin',3,'active','SEPA-Lastschrift'],['City Car GmbH','Anna Schulz','Hamburg',12,'active','SEPA-Lastschrift'],
    ['Taxi Becker','Jens Becker','Köln',1,'past_due','SEPA-Lastschrift'],['Funk-Taxi Weber','Petra Weber','München',5,'active','Kreditkarte'],
    ['Taxi Demir','Ali Demir','Berlin',2,'locked','SEPA-Lastschrift'],['Airport Shuttle KG','Tom Krüger','Frankfurt',8,'active','SEPA-Lastschrift'],
    ['Taxi Hoffmann','Uwe Hoffmann','Dortmund',1,'pending',null],['Taxi Özdemir','Kemal Özdemir','Essen',4,'active','PayPal'],
    ['Stadt-Taxi Lang','Sven Lang','Leipzig',2,'past_due','SEPA-Lastschrift'],['Taxi Nowak','Piotr Nowak','Bremen',1,'cancelled','SEPA-Lastschrift'],
    ['Taxi Arslan','Hasan Arslan','Berlin',6,'active','SEPA-Lastschrift'],['Taxi Fischer','Claudia Fischer','Stuttgart',2,'active','SEPA-Lastschrift']];
  const C = names.map((n,i) => ({ id:'c'+i, company_name:n[0], contact_name:n[1], city:n[2], vehicles:n[3], status:n[4], payment_method:n[5],
    email:n[1].toLowerCase().replace(/\s/,'.').replace(/[äöü]/g, m => ({ä:'ae',ö:'oe',ü:'ue'}[m]))+'@example.de', phone:'0170 '+(1000000+i*7919),
    created_at:new Date(now-(i*17+3)*day).toISOString(), next_charge_on:new Date(now+((i*7)%28+1)*day).toISOString(),
    grace_until: n[4]==='past_due' ? new Date(now+(i%9+2)*day).toISOString() : null, locked_reason: n[4]==='locked' ? 'Zahlung nicht eingegangen' : null,
    cancel_at: n[4]==='cancelled' ? new Date(now-2*day).toISOString() : null, devices: n[4]==='pending'?0:1+(i%3),
    last_payment: n[4]==='pending' ? null : { amount:n[3]*P, status: ['active','cancelled'].includes(n[4])?'paid':'failed', at:new Date(now-((i*5)%12+1)*day).toISOString() } }));
  const months = Array.from({length:12}, (_,i) => { const dd = new Date(); dd.setDate(1); dd.setMonth(dd.getMonth()-11+i);
    return { month: dd.toISOString().slice(0,7), paid: i<5 ? 0 : Math.round(40 + (i-5)*42 + (i%2)*11) }; });
  months[11].paid = 287;
  const kpi = () => { const live = C.filter(c => ['active','past_due'].includes(c.status)); return {
    companies_total: C.filter(c => c.status!=='cancelled').length, companies_active: C.filter(c => c.status==='active').length,
    companies_past_due: C.filter(c => c.status==='past_due').length, companies_locked: C.filter(c => c.status==='locked').length,
    companies_pending: C.filter(c => c.status==='pending').length, vehicles_active: live.reduce((a,c) => a+c.vehicles, 0),
    mrr: live.reduce((a,c) => a+c.vehicles*P, 0), paid_this_month: months[11].paid, paid_last_month: months[10].paid, new_this_month: 3,
    cancelled_this_month: 1, open_amount: C.filter(c => c.last_payment?.status==='failed').reduce((a,c) => a+c.last_payment.amount, 0) }; };
  const log = {}, events = [
    { action:'sepa_setup', company_id:'c0', created_at:new Date(now-3*3600e3).toISOString() },
    { action:'payment_failed', company_id:'c2', created_at:new Date(now-20*3600e3).toISOString() },
    { action:'vehicle_added', company_id:'c1', created_at:new Date(now-2*day).toISOString() },
    { action:'auto_lock', company_id:'c4', created_at:new Date(now-3*day).toISOString() },
    { action:'cancelled', company_id:'c9', created_at:new Date(now-5*day).toISOString() } ];
  const S = { s:false, m:false };
  return {
    async login(e,p){ if (!e||!p) throw new Error('Invalid login credentials'); S.s = true; },
    async logout(){ S.s = false; S.m = false; },
    async session(){ return S.s ? {} : null; },
    async setup(){ },
    async mfaState(){ return { level: S.m ? 'aal2' : 'aal1', factors:[{ id:'f1' }] }; },
    async enroll(){ return { id:'f1', totp:{ qr_code:'', secret:'DEMO' } }; },
    async verify(f, code){ if (!/^\d{6}$/.test(code)) throw new Error('falsch'); S.m = true; },
    async overview(){ return { kpi: kpi(), companies: C, revenue_months: months, price_per_vehicle: P }; },
    async payments(){ const out = []; C.filter(c => c.last_payment).forEach((c,i) => { for (let k=0;k<3;k++) out.push({ company_id:c.id, company_name:c.company_name,
      amount:c.vehicles*P, status: k===0 ? c.last_payment.status : 'paid', kind:'recurring', description:'Cockpit Plus – '+c.vehicles+' Fahrzeug(e)',
      created_at:new Date(now-(k*30+(i%12)+1)*day).toISOString(), paid_at:new Date(now-(k*30+(i%12))*day).toISOString() }); });
      return out.sort((a,b) => new Date(b.created_at)-new Date(a.created_at)); },
    async settings(){ return { settings:{ price_per_vehicle:P, grace_days:14, max_devices:3, agb_version:'1.0' },
      admins:[{ name:'Hasan', email:'hasan@example.de', since:new Date(now-30*day).toISOString() },{ name:'Partner', email:'partner@example.de', since:new Date(now-30*day).toISOString() }] }; },
    async events(){ return events; },
    async detail(id){ const c = C.find(x => x.id===id);
      const veh = Array.from({length:c.vehicles}, (_,i) => ({ label:'Taxi '+(1000+i*37), kennzeichen:'B-TX '+(1000+i*37), konzession:'K-'+(2000+i), active:true }));
      const pays = c.status==='pending' ? [] : Array.from({length:4}, (_,i) => ({ amount:c.vehicles*P, status: i===0 ? c.last_payment.status : 'paid', description:'Cockpit Plus – '+c.vehicles+' Fahrzeug(e)', created_at:new Date(now-(i*30+3)*day).toISOString(), paid_at:new Date(now-(i*30+1)*day).toISOString() }));
      const devs = Array.from({length:c.devices}, (_,i) => ({ device_name:['Android','iPhone','Windows-PC'][i%3], created_at:c.created_at, last_seen_at:new Date(now-i*day*2).toISOString(), revoked:false }));
      return { company:{ ...c, street:'Musterstraße '+(id.length+3), zip:'10115' }, vehicles:veh, payments:pays, devices:devs,
        agb:[{ agb_version:'1.0', accepted_at:c.created_at, ip:'84.12.34.'+(id.length*7), user_agent:'Mozilla/5.0 (Linux; Android 14)' }], audit: log[id] || [] }; },
    async act(b){ const c = C.find(x => x.id===b.company_id); if (c){ (log[c.id] ||= []).unshift({ action:'admin_'+b.action, created_at:new Date().toISOString() });
      if (b.action==='lock'){ c.status='locked'; c.locked_reason=b.reason; } if (b.action==='unlock'){ c.status='active'; c.grace_until=null; c.locked_reason=null; }
      if (b.action==='reset_devices') c.devices=0; } return { ok:true }; },
  };
})();
