import {readTenantWorkbook} from './tenant-import.js?v=father1';
const formatMobile = value => (value || '').replace(/^([0-9]{5})([0-9]{5})$/,'$1-$2');
const formatTenantId = value => (value || '').replace(/^([0-9]{4})([0-9]{4})([0-9]{4})$/,'$1-$2-$3');
const root = document.querySelector('#app');
const modal = document.querySelector('#modal');
const logout = document.querySelector('#logout');
const topButton = document.createElement('button');
topButton.id = 'back-to-top';
topButton.type = 'button';
topButton.setAttribute('aria-label','ऊपर जाएँ');
topButton.title = 'ऊपर जाएँ';
topButton.textContent = '↑';
document.body.append(topButton);
const updateTopButton = () => {
  const isLongPage = document.documentElement.scrollHeight > window.innerHeight + 240;
  topButton.classList.toggle('is-visible', isLongPage && window.scrollY > 240);
};
window.addEventListener('scroll',updateTopButton,{passive:true});
window.addEventListener('resize',updateTopButton);
topButton.addEventListener('click',()=>{
  window.scrollTo({
    top:0,
    behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'
  });
});
new MutationObserver(updateTopButton).observe(root,{childList:true,subtree:true});
const methods = {Cash:'नकद',UPI:'यूपीआई','Bank Transfer':'बैंक ट्रांसफ़र',Cheque:'चेक'};
const shortDate = new Intl.DateTimeFormat('hi-IN',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
const monthDate = new Intl.DateTimeFormat('hi-IN',{timeZone:'UTC',month:'long',year:'numeric'});
const showDate = value => shortDate.format(new Date(value));
const showMonth = value => monthDate.format(new Date(value+'-01'));
function startMonthOptions(today) {
  const [year, month] = today.split('-').map(Number);
  return Array.from({length:60}, (_, offset)=>{
    const date = new Date(Date.UTC(year,month-1+offset,1));
    const value = date.toISOString().slice(0,7);
    return '<option value="'+value+'">'+showMonth(value)+'</option>';
  }).join('');
}
const money = amount => (amount/100).toLocaleString('hi-IN',{style:'currency',currency:'INR'});
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const table = (headers,rows) => rows.length ? '<div class="table"><table><thead><tr>'+
  headers.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+
  rows.map(cells=>'<tr>'+cells.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>' :
  '<p>अभी कोई रिकॉर्ड नहीं है।</p>';
let ledger, month, clock;
let authNotice = '';
let tenantTab = 'tenants';
let tenantDueMonth = '';
let tenantDueRows = [];
let receiptDateFilter = '';
let receiptMonthFilter = '';
let receiptSortBy = 'date';
let receiptSortDirection = 'desc';
let marketFilter = '';
let tenantListMarket = '';
let rentTenantMarket = '';
const depositReturnPasswords = new Map();
const activeMarkets = () => ledger.markets.filter(m=>!m.is_archived);
const activeShops = () => ledger.shops.filter(s=>!s.is_archived);
const shop = id => ledger.shops.find(s=>s.id===id);
const marketOf = s => ledger.markets.find(m=>m.id===s.market_id);
const shopNumber = s => marketOf(s) ? s.code.slice(marketOf(s).prefix.length+1) : s.code;
const shopLabel = s => marketOf(s) ? marketOf(s).name+' · '+shopNumber(s) : s.code;
const inMarket = s => !marketFilter || (s.market_id || 'unassigned') === marketFilter;
const marketOptions = (selected, filter=false) =>
  '<option value="">'+(filter?'सभी मार्केट':'मार्केट नहीं चुना')+'</option>'+
  (filter && activeShops().some(s=>!s.market_id)?'<option value="unassigned"'+(selected==='unassigned'?' selected':'')+'>बिना मार्केट</option>':'')+
  activeMarkets().map(m=>'<option value="'+escape(m.id)+'"'+(m.id===selected?' selected':'')+'>'+escape(m.name)+'</option>').join('');
const marketPicker = () => '<label>मार्केट<select id="market-filter">'+marketOptions(marketFilter,true)+'</select></label>';
const tenantFor = l => ledger.tenants.find(t=>t.id===l.tenant_id);
const lease = id => ledger.leases.find(l=>l.id===id);
const includesMonth = (l,m) => l.start_month <= m && (!l.end_month || l.end_month >= m);
const action = (name,id,label,variant='') => '<button type="button" class="action-'+variant+'" data-action="'+name+'" data-id="'+escape(id)+'">'+label+'</button>';
const dateFormat = new Intl.DateTimeFormat('hi-IN',{timeZone:'Asia/Kolkata',dateStyle:'full'});
const clockFormat = new Intl.DateTimeFormat('hi-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',numberingSystem:'latn'});

async function api(route,data) {
  const response = await fetch('/api/'+route,data === undefined ? {} : {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || 'सर्वर से संपर्क नहीं हो सका। कृपया फिर कोशिश करें।'),{status:response.status});
  return result;
}
async function load() {
  try {
    ledger = await api('ledger');
    month ??= ledger.today.slice(0,7);
    render();
  } catch (error) {
    ledger = null;
    render(error.status === 401 ? '' : (error instanceof TypeError ? 'इंटरनेट कनेक्शन जाँचकर फिर कोशिश करें।' : error.message));
  }
}
function rentRows(selected) {
  const totals = new Map();
  for (const p of ledger.payments) if (p.month === selected) totals.set(p.lease_id,(totals.get(p.lease_id)||0)+p.amount);
  return ledger.leases.filter(l=>includesMonth(l,selected)).map(l=>{
    const paid = totals.get(l.id)||0;
    return {l,paid,balance:l.rent-paid};
  }).sort((a,b)=>shop(a.l.shop_id).code.localeCompare(shop(b.l.shop_id).code,undefined,{numeric:true}));
}
function openingRows() {
  const totals = new Map();
  for (const p of ledger.payments) if (p.month==='opening') totals.set(p.lease_id,(totals.get(p.lease_id)||0)+p.amount);
  return ledger.leases.filter(l=>l.opening>0).map(l=>{
    const paid = totals.get(l.id)||0;
    return {l,paid,balance:l.opening-paid};
  });
}
function tenantOutstandingData(asOf) {
  const paidByPeriod = new Map();
  for (const p of ledger.payments) {
    const key = p.lease_id+'|'+p.month;
    paidByPeriod.set(key,(paidByPeriod.get(key)||0)+p.amount);
  }
  const openingDue = new Map(openingRows().map(({l,balance})=>[l.id,Math.max(0,balance)]));
  const groups = new Map();
  for (const l of ledger.leases) {
    if (l.start_month>asOf) continue;
    const last = l.end_month && l.end_month<asOf ? l.end_month : asOf;
    let total = openingDue.get(l.id)||0;
    const date = new Date(l.start_month+'-01T00:00:00Z');
    for (let period=l.start_month;period<=last;period=date.toISOString().slice(0,7)) {
      total += Math.max(0,l.rent-(paidByPeriod.get(l.id+'|'+period)||0));
      date.setUTCMonth(date.getUTCMonth()+1);
    }
    if (total<=0) continue;
    const tenant = tenantFor(l);
    const leasedShop = shop(l.shop_id);
    const groupKey = l.tenant_id ? 'tenant/'+l.tenant_id : 'lease/'+l.id;
    if (!groups.has(groupKey)) groups.set(groupKey,{
      id:l.tenant_id,leaseId:l.id,name:tenant?.name||l.tenant||'—',phone:tenant?.phone||l.phone||'',
      shops:[],total:0
    });
    const group = groups.get(groupKey);
    group.shops.push({
      market:marketOf(leasedShop)?.name||'बिना मार्केट',
      shop:leasedShop?shopNumber(leasedShop):'—',
      amount:total
    });
    group.total += total;
  }
  return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name,'hi'));
}
function receiptRows() {
  const groups = new Map();
  for (const p of ledger.payments) {
    const key = p.receipt_group || p.id;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(p);
  }
  return [...groups.entries()].map(([key,items])=>({
    ...items.find(p=>p.id===key),items,amount:items.reduce((sum,p)=>sum+p.amount,0)
  }));
}
function payablePeriods(l) {
  const current = ledger.today.slice(0,7);
  const available = new Map();
  if (l.opening) available.set('opening',l.opening);
  const date = new Date(l.start_month+'-01T00:00:00Z');
  const limit = new Date(Math.max(date.getTime(),Date.parse(current+'-01')));
  limit.setUTCMonth(limit.getUTCMonth()+12);
  const last = [limit.toISOString().slice(0,7),l.end_month || '9999-12'].sort()[0];
  for (let period=l.start_month;period<=last;period=date.toISOString().slice(0,7)) {
    available.set(period,l.rent);
    date.setUTCMonth(date.getUTCMonth()+1);
  }
  for (const p of ledger.payments) {
    if (p.lease_id===l.id && available.has(p.month)) available.set(p.month,available.get(p.month)-p.amount);
  }
  return [...available].filter(([,balance])=>balance>0);
}
const paymentPeriod = p => p.month==='opening' ? 'शुरुआती बकाया' : showMonth(p.month);
function tenancyPayments(receipts) {
  if (!receipts.length) return 'कोई भुगतान दर्ज नहीं है';
  const rows = receipts.flatMap(receipt=>receipt.items.map(item=>{
    const paidMonth = item.paid_on.slice(0,7);
    const kind = item.month==='opening' || item.month<paidMonth ? 'बकाया जमा' :
      item.month>paidMonth ? 'एडवांस जमा' : 'चालू किराया';
    return [showDate(item.paid_on),kind,paymentPeriod(item),money(item.amount),
      escape(methods[receipt.method]),escape(receipt.receipt_number || '—'),
      action('print',receipt.id,'रसीद प्रिंट करें')];
  }));
  const total = receipts.reduce((sum,p)=>sum+p.amount,0);
  return '<details><summary>जमा भुगतान देखें · '+money(total)+'</summary>'+
    table(['जमा तारीख','भुगतान का प्रकार','किराये का महीना','जमा राशि','तरीका','रसीद नंबर',''],rows)+'</details>';
}
const passwordField = '<label>एडमिन पासवर्ड<input name="password" type="password" minlength="8" maxlength="20" autocomplete="current-password" required></label>';
function overdue() {
  const current = ledger.today.slice(0,7);
  let amount = 0;
  for (const l of ledger.leases) {
    const until = l.end_month && l.end_month < current ? l.end_month : current;
    const serial = m => Number(m.slice(0,4))*12+Number(m.slice(5));
    const count = Math.max(0,serial(until)-serial(l.start_month)+(until < current ? 1 : 0));
    amount += count*l.rent;
  }
  return amount+openingRows().reduce((sum,row)=>sum+row.balance,0)-ledger.payments.filter(p=>p.month<current).reduce((sum,p)=>sum+p.amount,0);
}
function chartPanel(title, rows, format, bar=false) {
  const total = rows.reduce((sum,[,value])=>sum+value,0);
  const max = Math.max(1,...rows.map(([,value])=>value));
  let offset=0;
  const segments = rows.map(([,value,color])=>{
    const length=total?value/total*100:0;
    const position=offset;
    offset+=length;
    return '<circle cx="60" cy="60" r="44" pathLength="100" fill="none" stroke="'+color+'" stroke-width="30" stroke-dasharray="'+length+' '+(100-length)+'" stroke-dashoffset="'+(-position)+'" transform="rotate(-90 60 60)"/>';
  }).join('');
  const graph = bar ? '' : '<svg class="rent-donut" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="44" fill="none" stroke="#334155" stroke-width="30"/>'+segments+'</svg>';
  return '<section class="panel rent-chart"><h2>'+title+'</h2>'+graph+'<ul>'+
    rows.map(([label,value,color])=>'<li><span class="rent-chart-label">'+label+' <strong>'+format(value)+'</strong></span>'+
      (bar?'<svg class="rent-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="6" fill="#334155"/><rect width="'+value/max*100+'" height="6" fill="'+color+'"/></svg>':
      '<svg class="rent-swatch" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill="'+color+'"/></svg>')+'</li>').join('')+'</ul></section>';
}
function render(error = '') {
  clearInterval(clock);
  logout.hidden = !ledger;
  if (!ledger) {
    const authRoute=location.hash.slice(1);
    if (authRoute==='forgot-password') {
      root.innerHTML='<section class="login panel"><h1>पासवर्ड रीसेट</h1><p>रीसेट लिंक '+escape('info@masscom.co.in')+' पर भेजें।</p><form id="forgot-password-form"><p class="error" role="alert">'+escape(error)+'</p><p id="reset-email-status" role="status" aria-live="polite"></p><button class="primary">रीसेट लिंक भेजें</button><a class="button" href="#dashboard">लॉगिन पर वापस जाएँ</a></form></section>';
      document.querySelector('#forgot-password-form').addEventListener('submit',event=>submit(event,async()=>{
        await api('forgot-password',{});
        document.querySelector('#reset-email-status').textContent='यदि ईमेल सेवा सेटअप है, तो रीसेट लिंक भेज दिया गया है। Inbox और Spam फ़ोल्डर देखें।';
      }));
      return;
    }
    if (authRoute.startsWith('reset-password/')) {
      const token=authRoute.slice('reset-password/'.length);
      root.innerHTML='<section class="login panel"><h1>नया पासवर्ड सेट करें</h1><form id="reset-password-form"><label>नया पासवर्ड<input type="password" name="password" minlength="8" maxlength="20" autocomplete="new-password" required></label><label>पासवर्ड फिर लिखें<input type="password" name="confirm_password" minlength="8" maxlength="20" autocomplete="new-password" required></label><p class="error" role="alert">'+escape(error)+'</p><button class="primary">पासवर्ड बदलें</button></form></section>';
      document.querySelector('#reset-password-form').addEventListener('submit',event=>submit(event,async({password,confirm_password})=>{
        if(password!==confirm_password) throw new Error('दोनों पासवर्ड एक जैसे दर्ज करें।');
        await api('reset-password',{token,password});
        authNotice='पासवर्ड बदल गया है। नए पासवर्ड से लॉगिन करें।';
        location.hash='dashboard';
        await load();
      }));
      return;
    }
    root.innerHTML = '<section class="login panel"><h1>प्रशासक लॉगिन</h1><p role="status">'+escape(authNotice)+'</p><form id="login"><label>पासवर्ड<input type="password" name="password" minlength="8" maxlength="20" autocomplete="current-password" required></label><p class="error" role="alert">'+escape(error)+'</p><button class="primary">लॉगिन करें</button><a class="button" href="#forgot-password">पासवर्ड भूल गए?</a></form></section>';
    document.querySelector('#login').addEventListener('submit',e=>submit(e,async d=>{await api('login',d);authNotice='';await load();}));
    return;
  }
  const route = location.hash.slice(1);
  if (route==='tenants/deposits') tenantTab='deposits';
  const toolbar = (title,tools='')=>'<div class="toolbar"><h2>'+title+'</h2><div>'+tools+'</div></div>';
  let body;
  const current = ledger.today.slice(0,7);
  const isOccupied = l => l.start_month<=current && (!l.end_month || l.end_month>current);
  const occupied = id => ledger.leases.some(l=>l.shop_id===id && isOccupied(l));
  if (route.startsWith('deposit-return/')) {
    const id=route.slice('deposit-return/'.length);
    const l=lease(id);
    if (!l || !l.deposit || l.deposit_returned_on) body='<p>यह सुरक्षा राशि वापसी के लिए उपलब्ध नहीं है।</p><a class="button" href="#tenants/deposits">← सुरक्षा राशि सूची</a>';
    else if (!depositReturnPasswords.has(id)) body='<a class="button" href="#tenants/deposits">← सुरक्षा राशि सूची</a><h2>वापसी की अनुमति</h2><form id="deposit-return-auth" data-id="'+escape(id)+'"><label>एडमिनिस्ट्रेटिव पासवर्ड<input type="password" name="password" minlength="8" maxlength="20" required autocomplete="current-password"></label><p class="error" role="alert"></p><button class="primary">पासवर्ड जाँचें</button></form>';
    else body='<a class="button" href="#tenants/deposits">← सुरक्षा राशि सूची</a><h2>सुरक्षा राशि वापसी दर्ज करें</h2><p>'+escape(tenantFor(l)?.name||l.tenant)+' · '+escape(shopLabel(shop(l.shop_id)))+' · '+money(l.deposit)+'</p>'+action('print-return-form',id,'वापसी रसीद प्रिंट करें')+'<form id="deposit-return-form" data-id="'+escape(id)+'"><label>वापसी की तारीख<input type="date" name="returned_on" value="'+ledger.today+'" max="'+ledger.today+'" required></label><label>वापसी का विवरण<textarea name="description" maxlength="1000" rows="4" required placeholder="वापसी और किरायेदार की सहमति का विवरण"></textarea></label><label>हस्ताक्षरित रसीद संलग्न करें<input type="file" name="attachment" accept="image/jpeg,image/png,image/webp,application/pdf" required></label><p class="field-help">रसीद JPG, PNG, WebP या PDF हो सकती है। छोटी फ़ाइल चुनें, अधिकतम 180 KB।</p><p class="error" role="alert"></p><button class="primary">वापसी सेव करें</button></form>';
  } else if (route === 'deposits') {
    const records=ledger.leases.filter(l=>l.deposit>0).map(l=>({l,t:tenantFor(l),s:shop(l.shop_id),r:ledger.deposit_returns?.find(item=>item.lease_id===l.id)}))
      .sort((a,b)=>(a.t?.name||a.l.tenant).localeCompare(b.t?.name||b.l.tenant,'hi') || (a.s?.code||'').localeCompare(b.s?.code||'','hi',{numeric:true}));
    const held=records.filter(({l})=>!l.deposit_returned_on).reduce((sum,{l})=>sum+l.deposit,0);
    body=toolbar('सुरक्षा राशि')+table(['किरायेदार','मार्केट','दुकान संख्या','जमा सुरक्षा राशि','स्थिति',''],records.map(({l,t,s,r})=>[
      escape(t?.name||l.tenant),escape(marketOf(s)?.name||'बिना मार्केट'),escape(s?shopNumber(s):'—'),money(l.deposit),
      l.deposit_returned_on?'वापस · '+showDate(l.deposit_returned_on):'जमा',
      action('deposit-details',l.id,'विवरण देखें','details')+' '+(!l.deposit_returned_on?action('edit-deposit',l.id,'सुधारें','edit')+' '+action('return-deposit',l.id,'वापस करें','pay'):'')
    ]))+'<h2>कुल सुरक्षा राशि · '+money(records.reduce((sum,{l})=>sum+l.deposit,0))+'</h2><p>वापसी बाकी · '+money(held)+'</p>';
  } else if (route.startsWith('tenant/')) {
    const [tenantId, source] = route.slice(7).split('/');
    const tenant = ledger.tenants.find(t=>t.id===tenantId);
    body = source==='shops'
      ? '<a class="button" href="#shops">← दुकानें</a>'
      : '<a class="button" href="#tenants">← किरायेदार</a>';
    if (tenant) {
      const hasActiveLease = ledger.leases.some(l=>l.tenant_id===tenant.id && (!l.end_month || l.end_month>=current));
      const statusAction = tenant.is_archived || (tenant.is_active && hasActiveLease) ? '' :
        action('tenant-status',tenant.id,tenant.is_active?'निष्क्रिय करें':'सक्रिय करें',tenant.is_active?'edit':'assign');
      body += toolbar(escape(tenant.name)+(tenant.is_archived?' · हटाए गए':''),tenant.is_archived?'':action('tenant',tenant.id,'विवरण संपादित करें')+
        (statusAction?' '+statusAction:'')+(!tenant.is_archived && !tenant.is_active && !hasActiveLease?' '+action('archive-tenant',tenant.id,'किरायेदार हटाएँ'):'')) +
        (tenant.has_photo?'<img width="144" src="/api/tenant-photo?id='+encodeURIComponent(tenant.id)+'" alt="किरायेदार की फ़ोटो">':'') + '<p>मोबाइल नंबर · '+escape(formatMobile(tenant.phone) || '—')+'</p>'+
        '<p>पिता का नाम · '+escape(tenant.father_name || '—')+'</p>'+
        '<p>पता · '+escape(tenant.address || '—')+'</p>'+
        '<p>व्यापार · '+escape(tenant.business || '—')+'</p>'+
        '<p>किरायेदार आईडी नंबर · '+escape(formatTenantId(tenant.tenant_id_number) || '—')+'</p>'+
        '<p>स्थिति · '+(tenant.is_active?'सक्रिय':'निष्क्रिय')+'</p>'+
        table(['दुकान','सुरक्षा राशि जमा','वापसी','किरायेदारी','रसीद',''],ledger.leases.filter(l=>l.tenant_id===tenant.id).map(l=>[
          escape(shopLabel(shop(l.shop_id))),money(l.deposit),
          l.deposit_returned_on ? showDate(l.deposit_returned_on) : l.deposit ? 'वापसी बाकी' : '—',
          l.end_month ? showMonth(l.end_month)+' तक' : 'जारी',
          l.deposit>0 && l.deposit_receipt_number ? action('print-deposit',l.id,'रसीद प्रिंट करें') : '—',
          l.end_month ? '' : l.deposit && !l.deposit_returned_on
            ? action('return-deposit',l.id,'सुरक्षा राशि वापस करें') : action('end',l.id,'समाप्त करें')
        ]));
    }
  } else if (route === 'markets') {
    body = toolbar('मार्केट',action('market','','मार्केट जोड़ें')) + table(['मार्केट','कुल दुकानें','किराये पर','आगे के लिए आवंटित','स्वयं उपयोग','खाली',''],activeMarkets().map(m=>{
      const shops = activeShops().filter(s=>s.market_id===m.id);
      const blocked = shops.filter(s=>s.is_blocked).length;
      const rentable = shops.filter(s=>!s.is_blocked);
      const rented = rentable.filter(s=>occupied(s.id)).length;
      const reserved = rentable.filter(s=>!occupied(s.id) && ledger.leases.some(l=>l.shop_id===s.id && l.start_month>current)).length;
      const canArchive = !blocked && !shops.some(s=>ledger.leases.some(l=>l.shop_id===s.id && (!l.end_month || l.end_month>=current)));
      return [escape(m.name),shops.length,rented,reserved,blocked,rentable.length-rented-reserved,
        action('open-market',m.id,'दुकानें देखें','shops')+' '+action('market',m.id,'मार्केट संपादित करें')+
        (canArchive?' '+action('archive-market',m.id,'मार्केट हटाएँ'):'')];
    }));
  } else if (route === 'shops') {
    const headers = ['मार्केट','दुकान','पता','स्थिति','आवंटित किरायेदार','चालू माह जमा / बाकी',''];
    const currentRentByLease = new Map(rentRows(current).map(row=>[row.l.id,row]));
    const rows = activeShops().filter(inMarket).map(s=>{
      const allocations = ledger.leases.filter(l=>l.shop_id===s.id);
      const currentLease = allocations.find(l=>includesMonth(l,current));
      const nextLease = allocations.filter(l=>l.start_month>current).at(-1);
      const allocation = s.is_blocked ? null : currentLease || nextLease;
      const tenant = allocation ? tenantFor(allocation) : null;
      const status = s.is_blocked ? 'स्वयं उपयोग (ब्लॉक)' : currentLease ? 'किराये पर' : nextLease ? 'आगे के लिए आवंटित' : 'खाली';
      const tenantName = escape(tenant?.name || allocation?.tenant || '—');
      const tenantDetails = tenant
        ? '<a class="button action-details" href="#tenant/'+escape(tenant.id)+'/shops">'+tenantName+'</a>'
        : tenantName;
      const paymentLease = currentLease || nextLease;
      const pay = paymentLease ? ' '+action(tenant?.id?'tenant-payment':'payment',tenant?.id || paymentLease.id,'सभी दुकानों का किराया जमा करें','pay') : '';
      const currentRent = currentLease ? currentRentByLease.get(currentLease.id) : null;
      const paidStatus = currentRent
        ? (currentRent.balance<=0?'पूरा जमा':money(currentRent.paid)+' जमा · '+money(Math.max(0,currentRent.balance))+' बाकी')
        : '—';
      const remove = !s.is_blocked && !allocations.some(l=>!l.end_month || l.end_month>=current)
        ? ' '+action('archive-shop',s.id,'दुकान हटाएँ') : '';
      return [escape(marketOf(s)?.name || '—'),escape(shopNumber(s)),escape(s.address),status,tenantDetails,paidStatus,
        action('shop',s.id,'संपादित करें')+remove+pay];
    });
    body = toolbar('दुकानें',marketPicker()+action('shop','','दुकान जोड़ें')) + table(headers,rows);
  } else if (route === 'tenants' || route === 'tenants/deposits') {
    const receiptsByLease = new Map();
    for (const receipt of receiptRows()) {
      for (const leaseId of new Set(receipt.items.map(item=>item.lease_id))) {
        const items = receipt.items.filter(item=>item.lease_id===leaseId);
        if (!receiptsByLease.has(leaseId)) receiptsByLease.set(leaseId,[]);
        receiptsByLease.get(leaseId).push({...receipt,items,amount:items.reduce((sum,item)=>sum+item.amount,0)});
      }
    }
    const assignedMarkets = new Map();
    for (const l of ledger.leases) {
      if (l.end_month && l.end_month<=current) continue;
      if (!assignedMarkets.has(l.tenant_id)) assignedMarkets.set(l.tenant_id,new Set());
      assignedMarkets.get(l.tenant_id).add(shop(l.shop_id).market_id || 'unassigned');
    }
    const dueMonths = new Set([current]);
    for (const l of ledger.leases) {
      const last = l.end_month && l.end_month<current ? l.end_month : current;
      const date = new Date(l.start_month+'-01T00:00:00Z');
      for (let key=l.start_month;key<=last;key=date.toISOString().slice(0,7)) {
        dueMonths.add(key);
        date.setUTCMonth(date.getUTCMonth()+1);
      }
    }
    if (!dueMonths.has(tenantDueMonth)) tenantDueMonth=current;
    const dueMonthOptions = [...dueMonths].sort().reverse().map(key=>
      '<option value="'+escape(key)+'"'+(key===tenantDueMonth?' selected':'')+'>'+showMonth(key)+'</option>'
    ).join('');
    const dueMonthPicker = '<label>बकाया स्थिति माह<select data-tenant-due-month>'+dueMonthOptions+'</select></label>';
    tenantDueRows = tenantOutstandingData(tenantDueMonth);
    const tenantDueTable = () => table(['क्र.','किरायेदार','मोबाइल नंबर','मार्केट और दुकानें','कुल बकाया',''],tenantDueRows.map((row,index)=>[
      String(index+1),escape(row.name),escape(formatMobile(row.phone)||'—'),
      row.shops.map(item=>escape(item.market)+' — दुकान '+escape(item.shop)+' ('+money(item.amount)+')').join('<br>'),
      money(row.total),
      action(row.id?'tenant-payment':'payment',row.id || row.leaseId,'किराया जमा करें','pay')
    ]));
    const defaultersContent = toolbar('बकायेदार',dueMonthPicker+action('print-defaulters','','A4 PDF प्रिंट / डाउनलोड करें','print'))+
      '<p>चुने गए माह तक जिन किरायेदारों का किराया बाकी है, उनकी सूची।</p>'+tenantDueTable();
    const messageContent = toolbar('संदेश भेजें',dueMonthPicker)+
      '<p role="status">WhatsApp API और संदेश टेम्पलेट सेटअप लंबित है। भेजने का बटन सेटअप पूरा होने के बाद चालू होगा।</p>'+
      table(['किरायेदार','मोबाइल नंबर','मार्केट और दुकानें','कुल बकाया','संदेश'],tenantDueRows.map(row=>[
        escape(row.name),escape(formatMobile(row.phone)||'—'),
        row.shops.map(item=>escape(item.market)+' — दुकान '+escape(item.shop)+' ('+money(item.amount)+')').join('<br>'),
        money(row.total),'<button type="button" class="action-message" disabled title="WhatsApp API और संदेश टेम्पलेट लंबित हैं">संदेश भेजें</button>'
      ]));
    const marketOrder = new Map(activeMarkets().map((market,index)=>[market.id,index]));
    const shopNumberOrder = new Intl.Collator('hi-IN',{numeric:true,sensitivity:'base'});
    const compareShops = (a,b) =>
      (marketOrder.get(a.market_id) ?? marketOrder.size) - (marketOrder.get(b.market_id) ?? marketOrder.size) ||
      shopNumberOrder.compare(shopNumber(a),shopNumber(b));
    const firstShop = new Map();
    for (const allocation of ledger.leases) {
      if (allocation.end_month && allocation.end_month<current) continue;
      const assignedShop = shop(allocation.shop_id);
      if (!assignedShop || (tenantListMarket && (assignedShop.market_id || 'unassigned')!==tenantListMarket)) continue;
      const future = allocation.start_month>current;
      const previous = firstShop.get(allocation.tenant_id);
      if (!previous || (previous.future && !future) ||
          (previous.future===future && compareShops(assignedShop,previous.shop)<0)) {
        firstShop.set(allocation.tenant_id,{shop:assignedShop,future});
      }
    }
    const visibleTenants = ledger.tenants.filter(t=>!t.is_archived && (!tenantListMarket ||
      (tenantListMarket==='no-allocation' ? !assignedMarkets.has(t.id) : assignedMarkets.get(t.id)?.has(tenantListMarket))))
      .sort((a,b)=>{
        const first = firstShop.get(a.id);
        const second = firstShop.get(b.id);
        if (!first || !second) return Number(Boolean(second))-Number(Boolean(first));
        return compareShops(first.shop,second.shop);
      });
    const tenantMarketPicker = '<label>मार्केट<select id="tenant-list-market">'+marketOptions(tenantListMarket,true)+
      '<option value="no-allocation"'+(tenantListMarket==='no-allocation'?' selected':'')+'>बिना आवंटन</option></select></label>';
    const tenantListContent = toolbar('किरायेदार',tenantMarketPicker+action('tenant','','किरायेदार जोड़ें','add-tenant')+' '+action('lease','','आवंटन करें','assign')+' '+action('import-tenants','','Excel इम्पोर्ट','import')+' <a class="button action-template" href="/kirayedaar-import-template.xlsx?v=father1" download>Excel टेम्पलेट</a>') +
      table(['किरायेदार','पिता का नाम','मोबाइल नंबर','अभी किराये पर ली गई दुकानें',''],visibleTenants.map(t=>{
        const allocations = ledger.leases.filter(l=>l.tenant_id===t.id && (!l.end_month || l.end_month>=current));
        const shops = new Set(allocations.map(l=>l.shop_id));
        const currentLease = allocations.find(isOccupied) || allocations[0];
        const hasActiveLease = ledger.leases.some(l=>l.tenant_id===t.id && (!l.end_month || l.end_month>=current));
        const pay = t.is_active && currentLease
          ? action('tenant-payment',t.id,'सभी दुकानों का किराया जमा करें','pay') : '';
        const statusAction = t.is_active
          ? (hasActiveLease ? '' : action('tenant-status',t.id,'निष्क्रिय करें','edit'))
          : action('tenant-status',t.id,'सक्रिय करें','assign') +
            (hasActiveLease?'':' '+action('archive-tenant',t.id,'किरायेदार हटाएँ'));
        const tenancyActions = t.is_active
          ? ' '+action('lease',t.id,'आवंटन करें','assign')+
            (allocations.some(l=>!l.end_month)?' '+action('edit-allocation',t.id,'आवंटन संशोधित करें','edit'):'')+' '+pay
          : '';
        return [escape(t.name)+(t.is_active?'':' <span class="tenant-inactive">निष्क्रिय</span>'),escape(t.father_name || '—'),escape(formatMobile(t.phone)),
          allocations.filter(isOccupied).map(l=>shop(l.shop_id)).sort(compareShops).map(s=>escape(shopLabel(s))).join('<br>') || '—',
          '<a class="button action-details" href="#tenant/'+escape(t.id)+'">विवरण</a> '+statusAction+tenancyActions];
      }));
    const tenancyRecordContent = toolbar('किरायेदारी का रिकॉर्ड',marketPicker()) + table(['दुकान','किरायेदार','फ़ोन','मासिक किराया','शुरुआती माह','अंतिम माह','जमा भुगतान',''],ledger.leases.filter(l=>inMarket(shop(l.shop_id))).map(l=>[
      escape(shopLabel(shop(l.shop_id))),escape(tenantFor(l)?.name ?? l.tenant),escape(tenantFor(l)?.phone ?? l.phone),money(l.rent),showMonth(l.start_month),
      l.end_month ? showMonth(l.end_month) : 'जारी',tenancyPayments(receiptsByLease.get(l.id) || []),'<a class="button action-details" href="#tenant/'+escape(l.tenant_id)+'">किरायेदार विवरण</a>'
    ]));
    const depositRecords=ledger.leases.filter(l=>l.deposit>0).map(l=>({l,t:tenantFor(l),s:shop(l.shop_id)}))
      .sort((a,b)=>(a.t?.name||a.l.tenant).localeCompare(b.t?.name||b.l.tenant,'hi') || (a.s?.code||'').localeCompare(b.s?.code||'','hi',{numeric:true}));
    const heldDeposits=depositRecords.filter(({l})=>!l.deposit_returned_on).reduce((sum,{l})=>sum+l.deposit,0);
    const depositContent=toolbar('सुरक्षा राशि')+table(['किरायेदार','मार्केट','दुकान संख्या','जमा सुरक्षा राशि','स्थिति',''],depositRecords.map(({l,t,s})=>[
      escape(t?.name||l.tenant),escape(marketOf(s)?.name||'बिना मार्केट'),escape(s?shopNumber(s):'—'),money(l.deposit),
      l.deposit_returned_on?'वापस · '+showDate(l.deposit_returned_on):'जमा',
      action('deposit-details',l.id,'विवरण देखें','details')+' '+(!l.deposit_returned_on?action('edit-deposit',l.id,'सुधारें','edit')+' '+action('return-deposit',l.id,'वापस करें','pay'):'')
    ]))+'<h2>कुल सुरक्षा राशि · '+money(depositRecords.reduce((sum,{l})=>sum+l.deposit,0))+'</h2><p>वापसी बाकी · '+money(heldDeposits)+'</p>';
    body = '<nav class="tenant-tabs" aria-label="किरायेदार पेज">'+
      '<button type="button" class="tenant-tab" data-tenant-tab="tenants" aria-pressed="'+(tenantTab==='tenants')+'">किरायेदार</button>'+
      '<button type="button" class="tenant-tab" data-tenant-tab="defaulters" aria-pressed="'+(tenantTab==='defaulters')+'">बकायेदार</button>'+
      '<button type="button" class="tenant-tab" data-tenant-tab="messages" aria-pressed="'+(tenantTab==='messages')+'">संदेश भेजें</button>'+
      '<button type="button" class="tenant-tab" data-tenant-tab="leases" aria-pressed="'+(tenantTab==='leases')+'">किरायेदारी का रिकॉर्ड</button>'+
      '<button type="button" class="tenant-tab" data-tenant-tab="deposits" aria-pressed="'+(tenantTab==='deposits')+'">सुरक्षा राशि</button>'+
      '</nav>'+
      '<section class="tenant-tab-panel"'+(tenantTab==='tenants'?'':' hidden')+'>'+tenantListContent+'</section>'+
      '<section class="tenant-tab-panel"'+(tenantTab==='defaulters'?'':' hidden')+'>'+defaultersContent+'</section>'+
      '<section class="tenant-tab-panel"'+(tenantTab==='messages'?'':' hidden')+'>'+messageContent+'</section>'+
      '<section class="tenant-tab-panel"'+(tenantTab==='leases'?'':' hidden')+'>'+tenancyRecordContent+'</section>'+
      '<section class="tenant-tab-panel"'+(tenantTab==='deposits'?'':' hidden')+'>'+depositContent+'</section>';
  } else if (route === 'rent') {
    const inRentMarket = l => !rentTenantMarket ||
      (shop(l.shop_id)?.market_id || 'unassigned')===rentTenantMarket;
    const allocated = new Set(ledger.leases.filter(inRentMarket).map(l=>l.tenant_id));
    const months = new Set([current,month]);
    for (const l of ledger.leases) {
      const date = new Date(l.start_month+'-01T00:00:00Z');
      const limit = new Date(Math.max(date.getTime(),Date.parse(current+'-01')));
      limit.setUTCMonth(limit.getUTCMonth()+12);
      const last = l.end_month || limit.toISOString().slice(0,7);
      for (let key=l.start_month;key<=last;key=date.toISOString().slice(0,7)) {
        months.add(key);
        date.setUTCMonth(date.getUTCMonth()+1);
      }
    }
    const monthOptions = [...months].sort().reverse().map(key=>
      '<option value="'+escape(key)+'"'+(key===month?' selected':'')+'>'+showMonth(key)+'</option>'
    ).join('');
    const tenantOptions = ledger.tenants.filter(t=>allocated.has(t.id)).map(t=>
      '<option value="'+escape(t.id)+'">'+escape(t.name+(t.phone?' · '+formatMobile(t.phone):''))+'</option>'
    ).join('');
    body = '<form id="rent-tenant-form"><label>मार्केट चुनें<select id="rent-tenant-market">'+
      marketOptions(rentTenantMarket,true)+'</select></label><label>किरायेदार चुनें<select name="tenant_id" required>'+
      '<option value="">किरायेदार चुनें</option>'+tenantOptions+'</select></label>'+
      '<div><button class="action-pay" type="submit">किराया जमा करें</button></div></form>'+
      '<hr>'+toolbar('मासिक किराया','<label>किराये का महीना<select id="month">'+monthOptions+'</select></label>') +
      table(['दुकान','किरायेदार','किराया','जमा','बाकी',''],rentRows(month).filter(({l})=>inRentMarket(l)).map(({l,paid,balance})=>[
        escape(shopLabel(shop(l.shop_id))),escape(tenantFor(l)?.name ?? l.tenant),money(l.rent),money(paid),money(balance),
        balance>0?action(tenantFor(l)?.id?'tenant-payment':'payment',tenantFor(l)?.id || l.id,'सभी दुकानों का किराया जमा करें','pay'):'पूरा जमा '+action(tenantFor(l)?.id?'tenant-payment':'payment',tenantFor(l)?.id || l.id,'अन्य माह जमा करें','pay')
      ]));
    body += toolbar('शुरुआती बकाया') + table(['दुकान','किरायेदार','शुरुआत में दर्ज रकम','जमा','अब बाकी',''],
      openingRows().filter(({l})=>inRentMarket(l)).map(({l,paid,balance})=>[
        escape(shopLabel(shop(l.shop_id))),escape(tenantFor(l)?.name ?? l.tenant),money(l.opening),money(paid),money(balance),
        balance>0?action(tenantFor(l)?.id?'tenant-payment':'opening-payment',tenantFor(l)?.id || l.id,'सभी दुकानों का बकाया जमा करें','pay'):'पूरा जमा'
      ]));
  } else if (route === 'receipts') {
    const receiptMonths = [...new Set(ledger.payments.map(p=>p.month))].sort((a,b)=>
      (a==='opening'?-1:b==='opening'?1:b.localeCompare(a))
    );
    const receiptControls = marketPicker()+
      '<label>जमा तारीख़<input id="receipt-date-filter" type="date" value="'+escape(receiptDateFilter)+'"></label>'+
      '<label>किराये का महीना<select id="receipt-month-filter"><option value="">सभी महीने</option>'+
      receiptMonths.map(value=>'<option value="'+escape(value)+'"'+(receiptMonthFilter===value?' selected':'')+'>'+
        (value==='opening'?'शुरुआती बकाया':showMonth(value))+'</option>').join('')+'</select></label>'+
      '<label>क्रमबद्ध करें<select id="receipt-sort-by"><option value="date"'+(receiptSortBy==='date'?' selected':'')+'>भुगतान तारीख़</option>'+
      '<option value="month"'+(receiptSortBy==='month'?' selected':'')+'>किराये का महीना</option></select></label>'+
      '<label>क्रम<select id="receipt-sort-direction"><option value="desc"'+(receiptSortDirection==='desc'?' selected':'')+'>नवीनतम पहले</option>'+
      '<option value="asc"'+(receiptSortDirection==='asc'?' selected':'')+'>पुराने पहले</option></select></label>';
    const receipts = receiptRows()
      .filter(p=>p.items.some(item=>inMarket(shop(lease(item.lease_id).shop_id))))
      .filter(p=>!receiptDateFilter || p.paid_on===receiptDateFilter)
      .filter(p=>!receiptMonthFilter || p.items.some(item=>item.month===receiptMonthFilter))
      .sort((a,b)=>{
        const key = p=>receiptSortBy==='date' ? p.paid_on :
          p.items.map(item=>item.month==='opening'?'0000-00':item.month).sort()[0] || '';
        const order = key(a).localeCompare(key(b));
        return (receiptSortDirection==='asc'?1:-1)*(order || a.paid_on.localeCompare(b.paid_on));
      });
    body = toolbar('किराये की रसीदें',receiptControls) + table(['भुगतान की तारीख','दुकान','किरायेदार','किराये का महीना','राशि','भुगतान का तरीका','ट्रांज़ैक्शन आईडी','रसीद नंबर',''],receipts.map(p=>[
      showDate(p.paid_on),[...new Set(p.items.map(item=>escape(shopLabel(shop(lease(item.lease_id).shop_id)))))].join('<br>'),escape(lease(p.lease_id).tenant),
      p.items.map(paymentPeriod).join(' · '),money(p.amount),escape(methods[p.method]),escape(p.transaction_id || '—'),escape(p.receipt_number || '—'),action('edit-receipt',p.id,'रसीद संपादित करें','edit')+' '+action('print',p.id,'प्रिंट करें')
    ]));
  } else {
    const collected = prefix => ledger.payments.filter(p=>p.paid_on.startsWith(prefix)).reduce((sum,p)=>sum+p.amount,0);
    const metrics = [['आज की वसूली',collected(ledger.today)],['इस महीने की वसूली',collected(current)],
      ['पिछले महीनों का बकाया',overdue()],['इस महीने का बाकी किराया',rentRows(current).reduce((sum,r)=>sum+r.balance,0)]];
    const blocked = activeShops().filter(s=>s.is_blocked).length;
    const rentable = activeShops().filter(s=>!s.is_blocked);
    const rented = rentable.filter(s=>occupied(s.id)).length;
    const reserved = rentable.filter(s=>!occupied(s.id) && ledger.leases.some(l=>l.shop_id===s.id && l.start_month>current)).length;
    const monthRent = rentRows(current);
    const advance = ledger.payments.filter(p=>p.month!=='opening' && p.month>current).reduce((sum,p)=>sum+p.amount,0);
    const counts = new Intl.NumberFormat('hi-IN');
    const charts = chartPanel('मार्केट और दुकानें · '+counts.format(activeMarkets().length)+' मार्केट',[
      ['किराये पर',rented,'#34d399'],['खाली',rentable.length-rented-reserved,'#60a5fa'],
      ['आगे के लिए आवंटित',reserved,'#fbbf24'],['स्वयं उपयोग',blocked,'#a78bfa']
    ],value=>counts.format(value)) +
    chartPanel('चालू महीना · '+showMonth(current),[
      ['किराया जमा',monthRent.reduce((sum,row)=>sum+row.paid,0),'#34d399'],
      ['किराया बाकी',monthRent.reduce((sum,row)=>sum+row.balance,0),'#fb7185']
    ],money) +
    chartPanel('बकाया और एडवांस',[
      ['पुराना बकाया',Math.max(0,overdue()),'#fb7185'],
      ['चालू माह बकाया',Math.max(0,monthRent.reduce((sum,row)=>sum+Math.max(0,row.balance),0)),'#fbbf24'],
      ['कुल एडवांस',advance,'#60a5fa']
    ],money);
    const cards = [['किरायेदार प्रबंधन','किरायेदार जोड़ें, आवंटन करें, संदेश भेजें','♙','tenants'],
      ['मासिक किराया','किराया जमा करें और बकाया देखें','₹','rent'],['किराये की रसीदें','भुगतान देखें और रसीद प्रिंट करें','▤','receipts']];
    root.innerHTML = '<div class="hero dashboard-hero"><img class="dashboard-logo" src="/dashboard-logo.png" width="713" height="515" alt="लोगो"><div><h1>दुकान किराया प्रबंधन</h1><p>मासकॉम इन्फोटेक सॉल्यूशंस</p></div>'+
      '<div class="dashboard-clock"><svg viewBox="0 0 80 80" aria-hidden="true"><circle class="clock-face" cx="40" cy="40" r="37"/>'+
      Array.from({length:12},(_,i)=>'<line class="clock-tick" x1="40" y1="8" x2="40" y2="'+(i%3===0?14:11)+'" transform="rotate('+i*30+' 40 40)"/>').join('')+
      '<line id="clock-hour" class="clock-hour" x1="40" y1="40" x2="40" y2="22"/>'+
      '<line id="clock-minute" class="clock-minute" x1="40" y1="40" x2="40" y2="15"/>'+
      '<line id="clock-second" class="clock-second" x1="40" y1="46" x2="40" y2="13"/>'+
      '<circle class="clock-pin" cx="40" cy="40" r="3"/></svg><time id="date"></time></div></div>'+
      '<section class="panel">'+toolbar('किराये का सारांश','<a href="#rent" class="button action-pay">किराया जमा करें</a>')+'<div class="metrics">'+
      metrics.map(([name,value])=>'<div class="metric">'+name+'<strong>'+money(value)+'</strong></div>').join('')+'</div></section>'+
      '<div class="rent-charts">'+charts+'</div>'+
      '<div class="grid dashboard-grid"><section class="card"><span class="icon" aria-hidden="true">▦</span><h2>मार्केट और दुकानें</h2>'+
      '<nav class="catalog-tabs" aria-label="मार्केट और दुकानें"><a class="button" href="#markets">मार्केट <strong>'+activeMarkets().length+'</strong></a>'+
      '<a class="button" href="#shops">दुकानें <strong>'+activeShops().length+'</strong></a></nav></section>'+cards.map(([title,description,icon,target])=>'<a class="card" href="#'+target+'"><span class="icon" aria-hidden="true">'+icon+'</span><h2>'+title+'</h2><p>'+description+'</p></a>').join('')+
      '</div>';
    const hands = ['hour','minute','second'].map(name=>document.querySelector('#clock-'+name));
    const date = document.querySelector('#date');
    const tick = ()=>{
      const now = new Date();
      const parts = Object.fromEntries(clockFormat.formatToParts(now).map(({type,value})=>[type,Number(value)]));
      const {hour,minute,second} = parts;
      const angles = [hour*30+minute/2,minute*6+second/10,second*6];
      hands.forEach((hand,i)=>hand.setAttribute('transform','rotate('+angles[i]+' 40 40)'));
      date.textContent = dateFormat.format(now);
      date.dateTime = now.toISOString();
      date.title = clockFormat.format(now)+' IST';
    };
    tick();
    clock = setInterval(tick,1000);
    return;
  }
  if (route==='markets' || route==='shops') {
    const tabs = [['markets','मार्केट'],['shops','दुकानें']].map(([target,label])=>
      '<a class="button tenant-tab" href="#'+target+'"'+(route===target?' aria-current="page"':'')+'>'+label+'</a>'
    ).join('');
    body = '<nav class="tenant-tabs" aria-label="मार्केट और दुकानें">'+tabs+'</nav>'+body;
  }
  root.innerHTML = '<div class="toolbar"><a class="button" href="#dashboard">← डैशबोर्ड</a></div><section class="panel">'+body+'</section>';
  document.querySelector('#deposit-return-auth')?.addEventListener('submit',event=>submit(event,async ({password})=>{
    const id=event.currentTarget.dataset.id;
    await api('verify-admin',{password});
    depositReturnPasswords.set(id,password);
    render();
  }));
  document.querySelector('#deposit-return-form')?.addEventListener('submit',event=>submit(event,async values=>{
    const id=event.currentTarget.dataset.id;
    const file=values.attachment;
    if (!file?.size) throw new Error('हस्ताक्षरित वापसी रसीद की फ़ाइल चुनें।');
    let attachmentData;
    let attachmentName=file.name;
    if (file.type==='application/pdf') {
      if (file.size>180000) throw new Error('PDF फ़ाइल 180 KB से छोटी रखें।');
      attachmentData=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('फ़ाइल पढ़ी नहीं जा सकी।'));reader.readAsDataURL(file);});
    } else {
      const jpeg=await tenantPhoto(file);
      attachmentData='data:image/jpeg;base64,'+jpeg;
    }
    await api('return-deposit',{id,password:depositReturnPasswords.get(id),returned_on:values.returned_on,description:values.description,attachment_data:attachmentData,attachment_name:attachmentName});
    depositReturnPasswords.delete(id);
    location.hash='tenants/deposits';
    await load();
  }));
  document.querySelectorAll('[data-tenant-tab]').forEach(button=>button.addEventListener('click',()=>{
    tenantTab=button.dataset.tenantTab;
    render();
    document.querySelector('[data-tenant-tab="'+tenantTab+'"]')?.focus();
  }));
  document.querySelector('#rent-tenant-market')?.addEventListener('change',event=>{
    rentTenantMarket=event.target.value;
    render();
    document.querySelector('#rent-tenant-market')?.focus();
  });
  document.querySelector('#rent-tenant-form')?.addEventListener('submit',event=>{
    event.preventDefault();
    openTenantPayment('tenant-payment',new FormData(event.currentTarget).get('tenant_id'));
  });
  document.querySelectorAll('[data-tenant-due-month]').forEach(select=>select.addEventListener('change',event=>{
    if (!event.target.value) return;
    tenantDueMonth=event.target.value;
    render();
    document.querySelector('[data-tenant-due-month]')?.focus();
  }));
  document.querySelector('#tenant-list-market')?.addEventListener('change',event=>{
    tenantListMarket=event.target.value;
    render();
    document.querySelector('#tenant-list-market')?.focus();
  });
  document.querySelector('#market-filter')?.addEventListener('change',event=>{marketFilter=event.target.value;render();});
  document.querySelector('#receipt-date-filter')?.addEventListener('change',event=>{
    receiptDateFilter=event.target.value;
    render();
    document.querySelector('#receipt-date-filter')?.focus();
  });
  document.querySelector('#receipt-month-filter')?.addEventListener('change',event=>{
    receiptMonthFilter=event.target.value;
    render();
    document.querySelector('#receipt-month-filter')?.focus();
  });
  document.querySelector('#receipt-sort-by')?.addEventListener('change',event=>{
    receiptSortBy=event.target.value;
    render();
    document.querySelector('#receipt-sort-by')?.focus();
  });
  document.querySelector('#receipt-sort-direction')?.addEventListener('change',event=>{
    receiptSortDirection=event.target.value;
    render();
    document.querySelector('#receipt-sort-direction')?.focus();
  });
  document.querySelector('#month')?.addEventListener('change',event=>{
    if (event.target.validity.valid && event.target.value) {month=event.target.value;render();}
  });
}
async function submit(event,save) {
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('[type=submit],button:not([type])');
  const error=form.querySelector('.error');
  error.textContent='';
  button.disabled=true;
  try {await save(Object.fromEntries(new FormData(form)));}
  catch (failure) {error.textContent=failure instanceof TypeError ? 'इंटरनेट कनेक्शन जाँचकर फिर कोशिश करें।' : failure.message;}
  finally {button.disabled=false;}
}
function dialog(title,fields,route,convert,button='सेव करें') {
  modal.innerHTML='<h2>'+title+'</h2><form>'+fields+'<p class="error" role="alert"></p>'+
    '<div class="toolbar"><button type="button" id="cancel">रद्द करें</button><button class="primary" type="submit">'+button+'</button></div></form>';
  modal.querySelector('#cancel').onclick=()=>modal.close();
  modal.querySelector('form').onsubmit=event=>submit(event,async values=>{
    await api(route,await convert(values));
    modal.close();
    await load();
  });
  modal.showModal();
}
async function tenantPhoto(file) {
  if (file.size>25*1024*1024) throw new Error('25 MB तक की फ़ोटो चुनें।');
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('यह फ़ोटो नहीं खुली। दूसरी फ़ोटो चुनें।'); }
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1,720/Math.max(bitmap.width,bitmap.height));
    canvas.width = Math.max(1,Math.round(bitmap.width*scale));
    canvas.height = Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    for (const quality of [0.82,0.65,0.45,0.25]) {
      const jpeg = canvas.toDataURL('image/jpeg',quality).split(',')[1];
      if (jpeg?.length<=240000) return jpeg;
    }
    throw new Error('छोटी फ़ोटो चुनें।');
  } finally { bitmap.close(); }
}
const minor = value => Math.round(Number(value)*100);
root.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');
  if (!button) return;
  const {action:name,id}=button.dataset;
  if (name==='open-market') {
    marketFilter=id;
    location.hash='shops';
  }
  if (name==='deposit-details') {
    const l=lease(id), info=ledger.deposit_returns?.find(item=>item.lease_id===id);
    if (!l) return;
    const tenant=tenantFor(l), s=shop(l.shop_id);
    const fileLink=info?.attachment_name?'<p><a class="button" href="/api/deposit-return-file?id='+encodeURIComponent(id)+'" target="_blank" rel="noopener">हस्ताक्षरित वापसी रसीद · '+escape(info.attachment_name)+'</a></p>':'';
    dialog('सुरक्षा राशि का विवरण','<p>किरायेदार · '+escape(tenant?.name||l.tenant)+'</p><p>मार्केट · '+escape(marketOf(s)?.name||'बिना मार्केट')+'</p><p>दुकान · '+escape(shopNumber(s))+'</p><p>जमा राशि · '+money(l.deposit)+'</p><p>जमा तारीख · '+(l.deposit_paid_on?showDate(l.deposit_paid_on):'पुराने रिकॉर्ड में उपलब्ध नहीं')+'</p><p>वापसी तारीख · '+(l.deposit_returned_on?showDate(l.deposit_returned_on):'वापसी बाकी')+'</p><p>वापसी विवरण · '+escape(info?.description||'—')+'</p>'+fileLink,
      'deposit-details',()=>({id}),'बंद करें');
    modal.querySelector('form').onsubmit=event=>{event.preventDefault();modal.close();};
  }
  if (name==='edit-deposit') {
    const l=lease(id);
    if (!l || l.deposit_returned_on) return;
    dialog('सुरक्षा राशि सुधारें','<p>'+escape(tenantFor(l)?.name||l.tenant)+' · '+escape(shopLabel(shop(l.shop_id)))+'</p><label>जमा सुरक्षा राशि (₹)<input type="number" name="deposit" min="0" step=".01" required value="'+(l.deposit/100)+'"></label>',
      'edit-deposit',d=>({id,deposit:minor(d.deposit)}));
  }
  if (name==='return-deposit') {
    const l=lease(id);
    if (!l || !l.deposit || l.deposit_returned_on) return;
    modal.innerHTML='<h2>एडमिन पासवर्ड जाँच</h2><p>'+escape(tenantFor(l)?.name||l.tenant)+' · '+escape(shopLabel(shop(l.shop_id)))+' · '+money(l.deposit)+'</p><form><label>एडमिनिस्ट्रेटिव पासवर्ड<input type="password" name="password" minlength="8" maxlength="20" required autocomplete="current-password"></label><p class="error" role="alert"></p><div class="toolbar"><button type="button" id="cancel">रद्द करें</button><button class="primary">आगे बढ़ें</button></div></form>';
    modal.querySelector('#cancel').onclick=()=>modal.close();
    modal.querySelector('form').onsubmit=event=>submit(event,async ({password})=>{await api('verify-admin',{password});depositReturnPasswords.set(id,password);modal.close();location.hash='deposit-return/'+encodeURIComponent(id);});
    modal.showModal();
  }
  if (name==='print-return-form') {
    const l=lease(id);
    if (!l) return;
    const t=tenantFor(l), s=shop(l.shop_id);
    document.querySelector('#print').innerHTML='<article class="deposit-return-receipt"><h1>सुरक्षा राशि वापसी रसीद</h1><p>मासकॉम इन्फोटेक सॉल्यूशंस</p><p>रसीद संख्या · ____________________</p><p>वापसी की तारीख · ____________________</p><hr><p>मैं, <strong>'+escape(t?.name||l.tenant)+'</strong>, मार्केट <strong>'+escape(marketOf(s)?.name||'बिना मार्केट')+'</strong>, दुकान संख्या <strong>'+escape(shopNumber(s))+'</strong> का किरायेदार, पुष्टि करता/करती हूँ कि मुझे जमा सुरक्षा राशि <strong>'+money(l.deposit)+'</strong> पूरी प्राप्त हो गई है। इस वापसी के संबंध में मेरी सहमति है।</p><p>विवरण · __________________________________________________________________</p><p>________________________________________________________________________</p><div class="signature-row"><span>किरायेदार का हस्ताक्षर / अंगूठा निशान<br><br>________________________</span><span>प्राप्तकर्ता / अधिकृत हस्ताक्षर<br><br>________________________</span></div></article>';
    window.print();
  }
  if (name==='import-tenants') {
    dialog('Excel से किरायेदार इम्पोर्ट करें',
      '<p><a class="button" href="/kirayedaar-import-template.xlsx?v=father1" download>Excel टेम्पलेट डाउनलोड करें</a></p>'+
      '<label>भरी हुई Excel फ़ाइल चुनें<input name="workbook" type="file" accept=".xlsx" required></label>',
      'import-tenants',async ({workbook})=>({rows:await readTenantWorkbook(workbook)}),'इम्पोर्ट करें');
  }
  if (name==='tenant') {
    const t = ledger.tenants.find(tenant=>tenant.id===id);
    dialog(t?'किरायेदार का विवरण संपादित करें':'किरायेदार जोड़ें',
      '<label>किरायेदार का नाम<input name="name" maxlength="120" required value="'+escape(t?.name)+'"></label>'+
      '<label>पिता का नाम<input name="father_name" maxlength="120" value="'+escape(t?.father_name)+'"></label>'+
      '<label>मोबाइल नंबर<input name="phone" type="tel" inputmode="numeric" pattern="[0-9]{5}-?[0-9]{5}" maxlength="11" placeholder="00000-00000" required value="'+escape(formatMobile(t?.phone))+'"></label>'+
      '<label>पता<input name="address" maxlength="240" value="'+escape(t?.address)+'"></label>'+
      '<label>व्यापार<input name="business" maxlength="120" value="'+escape(t?.business)+'"></label>'+
      '<label>किरायेदार आईडी नंबर<input name="tenant_id_number" inputmode="numeric" pattern="(?:[0-9]{12}|[0-9]{4}-[0-9]{4}-[0-9]{4})" maxlength="14" placeholder="0000-0000-0000" required value="'+escape(formatTenantId(t?.tenant_id_number))+'"></label>'+
      '<label>फ़ोटो चुनें<input type="file" name="photo_file" accept="image/*"></label>',
      'tenants',async ({photo_file,...details})=>({
        ...details,id:t?.id,photo:photo_file?.size ? await tenantPhoto(photo_file) : null
      }));
  }
  if (name==='archive-tenant') {
    const tenant = ledger.tenants.find(t=>t.id===id);
    if (!tenant || tenant.is_active || tenant.is_archived) return;
    dialog('किरायेदार हटाएँ',
      '<p>'+escape(tenant.name)+'</p><p>किरायेदार सूची से हट जाएगा। पुरानी किरायेदारी, भुगतान और रसीदें सुरक्षित रहेंगी।</p>',
      'archive-tenant',()=>({id}),'किरायेदार हटाएँ');
  }
  if (name==='tenant-status') {
    const tenant=ledger.tenants.find(t=>t.id===id);
    if (!tenant) return;
    const nextActive=tenant.is_active?0:1;
    dialog(nextActive?'किरायेदार सक्रिय करें':'किरायेदार निष्क्रिय करें',
      '<p>'+escape(tenant.name)+'</p><p>पुराने किरायेदारी और भुगतान रिकॉर्ड सुरक्षित रहेंगे।</p>',
      'tenant-status',()=>({id,is_active:nextActive}),nextActive?'सक्रिय करें':'निष्क्रिय करें');
  }
  if (name==='market') {
    const market = activeMarkets().find(m=>m.id===id);
    if (id && !market) return;
    dialog(market?'मार्केट संपादित करें':'मार्केट जोड़ें',
      '<label>मार्केट का नाम<input name="name" maxlength="120" value="'+escape(market?.name)+'" required></label>'+
      (market?'<p>मार्केट कोड · '+escape(market.prefix)+'</p>':
        '<label>मार्केट कोड<input name="prefix" maxlength="12" pattern="[A-Za-z0-9]{1,12}" placeholder="जैसे BZ" required></label>'),
      'markets',values=>({...values,id:market?.id}),market?'नाम सेव करें':'मार्केट जोड़ें');
  }
  if (name==='archive-market') {
    const market = activeMarkets().find(m=>m.id===id);
    if (!market) return;
    dialog('मार्केट हटाएँ',
      '<p>'+escape(market.name)+'</p><p>यह मार्केट और इसकी दुकानें सूची व नए आवंटन से हट जाएँगी। पुराने किराये और रसीदों का रिकॉर्ड सुरक्षित रहेगा।</p>',
      'archive-market',()=>({id}),'मार्केट हटाएँ');
  }
  if (name==='archive-shop') {
    const s = shop(id);
    if (!s || s.is_archived) return;
    dialog('दुकान हटाएँ',
      '<p>'+escape(shopLabel(s))+'</p><p>दुकान सूची और नए आवंटन से हट जाएगी। पुरानी किरायेदारी, भुगतान और रसीदें सुरक्षित रहेंगी।</p>',
      'archive-shop',()=>({id}),'दुकान हटाएँ');
  }
  if (name==='shop') {
    const s=shop(id);
    const hasUnfinishedLease = s && ledger.leases.some(l=>l.shop_id===s.id &&
      (!l.end_month || l.end_month>=ledger.today.slice(0,7)));
    const blockControl = s
      ? '<input type="hidden" name="is_blocked" value="0"><label class="checkbox-label"><input type="checkbox" name="is_blocked" value="1"'+
        (s.is_blocked?' checked':'')+(hasUnfinishedLease?' disabled':'')+'> स्वयं उपयोग के लिए दुकान ब्लॉक करें</label>'+
        (hasUnfinishedLease?'<p class="field-help">किरायेदारी पूरी होने तक दुकान ब्लॉक नहीं की जा सकती।</p>':'')
      : '';
    dialog(s?'दुकान संपादित करें':'दुकान जोड़ें','<label>मार्केट<select name="market_id">'+marketOptions(s?.market_id || (!s && marketFilter !== 'unassigned' ? marketFilter : ''))+'</select></label>'+
      '<label>दुकान का नंबर या नाम<input name="code" maxlength="40" required value="'+escape(s ? shopNumber(s) : '')+'"></label>'+
      '<label>पता<input name="address" maxlength="240" value="'+escape(s?.address)+'"></label>'+blockControl,'shops',d=>({...d,id}));
  }
  if (name==='edit-allocation') {
    const allocations = ledger.leases.filter(l=>l.tenant_id===id && !l.end_month);
    if (!allocations.length) return;
    dialog('आवंटन संशोधित करें','<label>किरायेदारी चुनें<select name="id" required>'+
      allocations.map(l=>'<option value="'+escape(l.id)+'">'+escape(shopLabel(shop(l.shop_id)))+'</option>').join('')+
      '</select></label>'+
      '<label>आवंटित दुकान बदलें<select name="shop_id" required></select></label>'+
      '<label>मासिक किराया (₹)<input type="number" name="rent" min="0" step=".01" required></label>'+
      '<label>शुरुआती बकाया (₹)<input type="number" name="opening" min="0" step=".01" required></label>'+
      '<label>सुरक्षा राशि (₹)<input type="number" name="deposit" min="0" step=".01" required></label>',
      'edit-allocation',d=>({id:d.id,shop_id:d.shop_id,rent:minor(d.rent),opening:minor(d.opening),deposit:minor(d.deposit)}));
    const form = modal.querySelector('form');
    const picker = form.elements.namedItem('id');
    const shopPicker = form.elements.namedItem('shop_id');
    const populate = ()=>{
      const allocation = lease(picker.value);
      for (const field of ['rent','opening','deposit']) form.elements.namedItem(field).value=allocation[field]/100;
      const availableShops = activeShops().filter(s=>(!s.is_blocked || s.id===allocation.shop_id) && !ledger.leases.some(other=>
        other.id!==allocation.id && other.shop_id===s.id &&
        (!other.end_month || other.end_month>=allocation.start_month)));
      shopPicker.innerHTML=availableShops.map(s=>
        '<option value="'+escape(s.id)+'">'+escape(shopLabel(s))+'</option>'
      ).join('');
      shopPicker.value=allocation.shop_id;
    };
    picker.addEventListener('change',populate);
    populate();
  }
  if (name==='lease') {
    const options=activeShops().filter(s=>!s.is_blocked && !ledger.leases.some(l=>l.shop_id===s.id&&!l.end_month));
    const tenantOptions = tenants=>'<option value="">किरायेदार चुनें</option>'+
      tenants.map(t=>'<option value="'+escape(t.id)+'">'+escape(t.name+(t.phone?' · '+formatMobile(t.phone):''))+'</option>').join('');
    dialog('दुकान आवंटित करें','<label>किरायेदार का मार्केट<select name="tenant_market"><option value="">सभी मार्केट</option>'+
      activeMarkets().map(m=>'<option value="'+escape(m.id)+'">'+escape(m.name)+'</option>').join('')+
      '<option value="unallocated">बिना चालू आवंटन</option></select></label><label>किरायेदार<select name="tenant_id" required>'+
      tenantOptions(ledger.tenants.filter(t=>t.is_active))+
      '</select></label><label>मार्केट<select name="market_id" required><option value="">मार्केट चुनें</option>'+
      activeMarkets().map(m=>'<option value="'+escape(m.id)+'">'+escape(m.name)+'</option>').join('')+
      (options.some(s=>!s.market_id)?'<option value="unassigned">बिना मार्केट</option>':'')+'</select></label>'+
      '<fieldset><legend>दुकानें चुनें</legend><div id="allocation-shops">पहले मार्केट चुनें</div></fieldset>'+

      '<label>मासिक किराया प्रति दुकान (₹)<input type="number" name="rent" min="0" step=".01" required></label>'+
      '<label>किराया शुरू होने का महीना<select name="start_month" required><option value="">महीना चुनें</option>'+
      startMonthOptions(ledger.today)+'</select></label>'+
      '<label>शुरुआती बकाया प्रति दुकान (₹)<input type="number" name="opening" min="0" step=".01" value="0"></label>'+
      '<label>जमा सुरक्षा राशि प्रति दुकान (₹)<input type="number" name="deposit" min="0" step=".01" value="0"></label>',
      'leases',d=>{
      const shop_ids = Object.keys(d).filter(key=>key.startsWith('shop_')).map(key=>key.slice(5));
      if (!shop_ids.length) throw new Error('कम से कम एक दुकान चुनें।');
      return {shop_ids,tenant_id:d.tenant_id,start_month:d.start_month,rent:minor(d.rent),opening:minor(d.opening),deposit:minor(d.deposit)};
    });
    const tenantMarket = modal.querySelector('[name="tenant_market"]');
    const tenantSelect = modal.querySelector('[name="tenant_id"]');
    if (id) tenantSelect.value=id;
    tenantMarket.addEventListener('change',()=>{
      const selectedTenant = tenantSelect.value;
      const market = tenantMarket.value;
      const current = ledger.today.slice(0,7);
      const activeLeases = ledger.leases.filter(l=>!l.end_month || l.end_month>current);
      const activeTenants = ledger.tenants.filter(t=>t.is_active);
      const tenants = !market ? activeTenants : activeTenants.filter(t=>market==='unallocated'
        ? !activeLeases.some(l=>l.tenant_id===t.id)
        : activeLeases.some(l=>l.tenant_id===t.id && shop(l.shop_id)?.market_id===market));
      tenantSelect.innerHTML=tenantOptions(tenants);
      tenantSelect.value=tenants.some(t=>t.id===selectedTenant)?selectedTenant:'';
    });
    const marketSelect = modal.querySelector('[name="market_id"]');
    const shopList = modal.querySelector('#allocation-shops');
    marketSelect.addEventListener('change',()=>{
      const selected = marketSelect.value;
      const shops = options.filter(s=>(s.market_id || 'unassigned')===selected);
      shopList.innerHTML = shops.length ? shops.map(s=>'<label><span><input type="checkbox" name="shop_'+escape(s.id)+'"> '+escape(shopNumber(s))+'</span></label>').join('')
        : selected ? 'कोई दुकान उपलब्ध नहीं है' : 'पहले मार्केट चुनें';
    });
  }
  if (name==='end') {
    dialog('किरायेदारी समाप्त करें','<label>किराये का अंतिम महीना<input type="month" name="end_month" min="'+lease(id).start_month+
      '" value="'+ledger.today.slice(0,7)+'" required></label>'+passwordField,'end-lease',d=>({...d,id}),'किरायेदारी समाप्त करें');
  }
  if (['payment','opening-payment','tenant-payment'].includes(name)) openTenantPayment(name,id);
  if (name==='print-defaulters') {
    const compactClass=tenantDueRows.length>80?'due-report-extra-compact':tenantDueRows.length>35?'due-report-compact':'';
    const rows=tenantDueRows.map((row,index)=>[
      String(index+1),escape(row.name),escape(formatMobile(row.phone)||'—'),
      row.shops.map(item=>escape(item.market)+' — दुकान '+escape(item.shop)+' ('+money(item.amount)+')').join('<br>'),
      money(row.total)
    ]);
    const total=tenantDueRows.reduce((sum,row)=>sum+row.total,0);
    document.querySelector('#print').innerHTML='<article class="due-report '+compactClass+'">'+
      '<h1>किराया बकाया सूची</h1><p>मासकॉम इन्फोटेक सॉल्यूशंस</p>'+
      '<p>बकाया स्थिति माह · '+showMonth(tenantDueMonth)+' · प्रिंट तारीख · '+showDate(ledger.today)+'</p>'+
      table(['क्र.','किरायेदार','मोबाइल नंबर','मार्केट और दुकानें','कुल बकाया'],rows)+
      '<h2>सभी किरायेदारों का कुल बकाया · '+money(total)+'</h2></article>';
    window.print();
  }
  if (name==='print-deposit') {
    const l=lease(id);
    if (!l || !l.deposit_receipt_number || l.deposit<=0) return;
    const tenant=tenantFor(l);
    document.querySelector('#print').innerHTML='<h1>सुरक्षा राशि की रसीद</h1><p>मासकॉम इन्फोटेक सॉल्यूशंस</p>'+
      '<p>रसीद नंबर '+escape(l.deposit_receipt_number)+'</p><hr>'+
      '<p>किरायेदार · '+escape(tenant?.name || l.tenant)+'</p>'+
      '<p>दुकान · '+escape(shopLabel(shop(l.shop_id)))+'</p>'+
      '<p>जमा तारीख · '+(l.deposit_paid_on?showDate(l.deposit_paid_on):'पुराने रिकॉर्ड में तारीख उपलब्ध नहीं')+'</p>'+
      '<h2>सुरक्षा राशि · '+money(l.deposit)+'</h2><p>अधिकृत हस्ताक्षर ____________________</p>';
    window.print();
  }
  if (name==='edit-receipt') {
    const receipt = receiptRows().find(p=>p.id===id);
    if (!receipt) return;
    const fields = receipt.items.map((item,index)=>
      '<label>'+escape(shopLabel(shop(lease(item.lease_id).shop_id)))+' · '+paymentPeriod(item)+' (₹)'+
      '<input type="number" name="amount_'+index+'" min=".01" step=".01" required value="'+(item.amount/100)+'"></label>'
    ).join('');
    const upi = receipt.method==='UPI';
    dialog('रसीद संपादित करें',
      '<label>रसीद नंबर<input name="receipt_number" maxlength="60" value="'+escape(receipt.receipt_number)+'"></label>'+
      '<label>भुगतान की तारीख<input type="date" name="paid_on" required max="'+ledger.today+'" value="'+escape(receipt.paid_on)+'"></label>'+
      '<label>भुगतान का तरीका<select name="method">'+Object.entries(methods).map(([key,label])=>
        '<option value="'+key+'"'+(receipt.method===key?' selected':'')+'>'+label+'</option>').join('')+'</select></label>'+
      '<label id="edit-receipt-transaction"'+(upi?'':' hidden')+'>यूपीआई ट्रांज़ैक्शन आईडी<input name="transaction_id" maxlength="100" value="'+
      escape(receipt.transaction_id)+'"'+(upi?' required':' disabled')+'></label>'+fields,
      'edit-receipt',values=>({id,receipt_number:values.receipt_number,paid_on:values.paid_on,method:values.method,
        transaction_id:values.transaction_id,items:receipt.items.map((item,index)=>({id:item.id,amount:minor(values['amount_'+index])}))}));
    const transaction = modal.querySelector('#edit-receipt-transaction');
    const input = transaction.querySelector('input');
    modal.querySelector('[name="method"]').addEventListener('change',event=>{
      const isUpi = event.target.value==='UPI';
      transaction.hidden = input.disabled = !isUpi;
      input.required = isUpi;
    });
  }
  if (name==='print') {
    const p=receiptRows().find(item=>item.id===id);
    const l=lease(p.lease_id);
    document.querySelector('#print').innerHTML='<h1>किराये की रसीद</h1><p>मासकॉम इन्फोटेक सॉल्यूशंस</p><p>ऐप रसीद आईडी '+escape(p.id)+
      '</p>'+(p.receipt_number?'<p>रसीद नंबर '+escape(p.receipt_number)+'</p>':'')+'<hr><p>इनसे प्राप्त हुआ '+escape(l.tenant)+'</p>'+table(['दुकान','किराये का महीना','जमा राशि'],p.items.map(item=>[escape(shopLabel(shop(lease(item.lease_id).shop_id))),paymentPeriod(item),money(item.amount)]))+
      '<p>भुगतान की तारीख '+showDate(p.paid_on)+'</p><p>भुगतान का तरीका '+escape(methods[p.method])+'</p>'+(p.transaction_id?'<p>यूपीआई ट्रांज़ैक्शन आईडी '+escape(p.transaction_id)+'</p>':'')+'<h2>'+money(p.amount)+'</h2><p>अधिकृत हस्ताक्षर ____________________</p>';
    window.print();
  }
});
function paymentCategory(period,current) {
  return period==='opening' || period<current ? 'arrears' : period===current ? 'current' : 'advance';
}
function openTenantPayment(name,id) {
  const combined = name==='tenant-payment';
  const leases = combined ? ledger.leases.filter(l=>l.tenant_id===id) : [lease(id)];
  const current = ledger.today.slice(0,7);
  const paymentOptions = leases.map(l=>({l,periods:payablePeriods(l)})).filter(({periods})=>periods.length);
  if (!paymentOptions.length) { window.alert('जमा करने के लिए कोई किराया बाकी नहीं है।'); return; }
  const periodFields = paymentOptions.map(({l,periods})=>{
    const fields = periods.map(([key,balance])=>{
      const type = key==='opening' ? '' : key<current ? 'बकाया · ' : key===current ? 'चालू · ' : 'एडवांस · ';
      return '<label>'+type+paymentPeriod({month:key})+' (बाकी '+money(balance)+')'+
        '<input type="number" name="period_'+escape(l.id)+'/'+key+'" step=".01" min="0" max="'+balance/100+'"></label>';
    }).join('');
    const label = escape(shopLabel(shop(l.shop_id)));
    return '<h3>'+label+'</h3>'+fields;
  }).join('');
  const months = [...new Set(paymentOptions.flatMap(({periods})=>periods.map(([key])=>key))
    .filter(key=>paymentCategory(key,current)==='advance'))].sort();
  const categories = new Set(paymentOptions.flatMap(({periods})=>periods.map(([key])=>paymentCategory(key,current))));
  const quickFill = '<div class="payment-quick-actions">'+
    '<button type="button" data-fill="current"'+(!categories.has('current')||categories.has('arrears')?' disabled':'')+'>चालू माह</button> '+
    '<button type="button" data-fill="arrears"'+(categories.has('arrears')?'':' disabled')+'>बकाया</button>'+
    (months.length?' <button type="button" id="select-advance" aria-controls="advance-controls" aria-expanded="false"'+(categories.has('arrears')||categories.has('current')?' disabled':'')+'>एडवांस</button>':'')+
    '</div>'+
    (months.length?'<div id="advance-controls" hidden>'+
      '<div id="advance-month-selectors"><label>एडवांस का महीना<select id="advance-month-0" data-advance-month><option value="">महीना चुनें</option>'+
      months.map(m=>'<option value="'+escape(m)+'">'+showMonth(m)+'</option>').join('')+
      '</select></label></div>'+
      '<button type="button" id="add-advance-month" hidden>एक माह और जोड़ें</button>'+
      '</div>':'')+
    '<p id="payment-fill-status" role="status"></p>';
  const paymentId=crypto.randomUUID();
  const tenant = combined ? ledger.tenants.find(t=>t.id===id) : tenantFor(leases[0]);
  dialog(combined?'सभी आवंटित दुकानों का किराया जमा करें':'किराया जमा करें','<p>'+escape(tenant?.name ?? leases[0].tenant)+'</p>'+
    quickFill+'<div id="payment-period-fields" hidden>'+periodFields+'</div>'+
    '<p>कुल भुगतान <strong id="payment-total"></strong></p>'+
    '<label>रसीद नंबर<input name="receipt_number" maxlength="60" required></label>'+
    '<label>भुगतान की तारीख<input type="date" name="paid_on" value="'+ledger.today+'" max="'+ledger.today+'" required></label>'+
    '<label>भुगतान का तरीका<select name="method"><option value="Cash">नकद</option><option value="UPI">यूपीआई</option></select></label>'+
    '<label id="transaction-field" hidden>यूपीआई ट्रांज़ैक्शन आईडी<input name="transaction_id" maxlength="100" disabled></label>',
    'payments',({receipt_number,paid_on,method,transaction_id,...amounts})=>{
      const items = Object.entries(amounts).map(([key,value])=>{
        const [lease_id,month] = key.slice(7).split('/');
        return {lease_id,month,amount:minor(value)};
      }).filter(item=>item.amount>0);
      if (!items.length) throw new Error('किसी महीने या बकाये की राशि चुनें।');
      return {id:paymentId,receipt_number,paid_on,method,transaction_id,items};
    },'भुगतान सेव करें');
  const paymentFields = [...modal.querySelectorAll('[name^="period_"]')];
  const updateTotal = ()=>{modal.querySelector('#payment-total').textContent=money(paymentFields.reduce((sum,input)=>sum+minor(input.value),0));};
  const currentFields = paymentFields.filter(input=>paymentCategory(input.name.split('/')[1],current)==='current');
  const arrearsFields = paymentFields.filter(input=>paymentCategory(input.name.split('/')[1],current)==='arrears');
  const advanceFields = paymentFields.filter(input=>paymentCategory(input.name.split('/')[1],current)==='advance');
  const fillStatus = modal.querySelector('#payment-fill-status');
  const currentButton = modal.querySelector('[data-fill="current"]');
  const arrearsButton = modal.querySelector('[data-fill="arrears"]');
  const advanceButton = modal.querySelector('#select-advance');
  const fieldsIncluded = fields=>fields.every(input=>
    Math.round(Number(input.value||0)*100)>=Math.round(Number(input.max||0)*100));
  const updatePaymentButtons = () => {
    if (arrearsButton) arrearsButton.disabled=!arrearsFields.length;
    if (currentButton) currentButton.disabled=!currentFields.length || !fieldsIncluded(arrearsFields);
    if (advanceButton) advanceButton.disabled=!advanceFields.length ||
      !fieldsIncluded(arrearsFields) || !fieldsIncluded(currentFields);
  };
  for (const input of paymentFields) input.addEventListener('input',()=>{
    updateTotal();
    updatePaymentButtons();
  });
  for (const button of modal.querySelectorAll('[data-fill]')) {
    button.addEventListener('click',()=>{
      if (button.dataset.fill==='current' && !fieldsIncluded(arrearsFields)) return;
      for (const input of paymentFields) {
        if (paymentCategory(input.name.split('/')[1],current)===button.dataset.fill) input.value=input.max;
      }
      updateTotal();
      updatePaymentButtons();
      fillStatus.textContent=button.dataset.fill==='arrears'
        ? 'बकाया कुल भुगतान में जुड़ गया है।'
        : 'चालू माह का किराया कुल भुगतान में जुड़ गया है।';
    });
  }
  const advanceControls = modal.querySelector('#advance-controls');
  const advanceSelectors = modal.querySelector('#advance-month-selectors');
  const addAdvanceButton = modal.querySelector('#add-advance-month');
  let advanceSelectCount=1;
  const selectedAdvanceMonths = () => [...advanceSelectors.querySelectorAll('[data-advance-month]')]
    .map(select=>select.value).filter(Boolean);
  const refreshAdvanceSelectors = () => {
    const selects=[...advanceSelectors.querySelectorAll('[data-advance-month]')];
    const selected=selects.map(select=>select.value).filter(Boolean);
    for (const select of selects) {
      const keep=select.value;
      select.innerHTML='<option value="">महीना चुनें</option>'+
        months.filter(month=>month===keep || !selected.includes(month))
          .map(month=>'<option value="'+escape(month)+'">'+showMonth(month)+'</option>').join('');
      select.value=keep;
    }
  };
  const updateAdvancePayments = () => {
    const selected=new Set(selectedAdvanceMonths());
    for (const input of advanceFields) {
      const period=input.name.split('/')[1];
      input.value=selected.has(period)?input.max:'';
    }
    updateTotal();
    refreshAdvanceSelectors();
    const selects=advanceSelectors.querySelectorAll('[data-advance-month]');
    const selectedCount=selected.size;
    addAdvanceButton.hidden=selectedCount===0;
    addAdvanceButton.disabled=selects.length>=months.length;
    fillStatus.textContent=selectedCount
      ? [...selected].map(showMonth).join(' और ')+' का एडवांस कुल भुगतान में जुड़ गया है।'
      : '';
  };
  advanceButton?.addEventListener('click',()=>{
    if (!fieldsIncluded(arrearsFields) || !fieldsIncluded(currentFields)) return;
    advanceControls.hidden=false;
    advanceButton.setAttribute('aria-expanded','true');
    advanceSelectors.querySelector('[data-advance-month]')?.focus();
  });
  advanceSelectors?.addEventListener('change',event=>{
    if (event.target.matches('[data-advance-month]')) updateAdvancePayments();
  });
  addAdvanceButton?.addEventListener('click',()=>{
    const selects=advanceSelectors.querySelectorAll('[data-advance-month]');
    if (selectedAdvanceMonths().length===0 || selects.length>=months.length) return;
    const id='advance-month-'+advanceSelectCount++;
    advanceSelectors.insertAdjacentHTML('beforeend','<label>एक और एडवांस महीना<select id="'+id+'" data-advance-month><option value="">महीना चुनें</option>'+
      months.map(m=>'<option value="'+escape(m)+'">'+showMonth(m)+'</option>').join('')+
      '</select></label>');
    refreshAdvanceSelectors();
    advanceSelectors.querySelector('#'+id)?.focus();
    updateAdvancePayments();
  });
  updatePaymentButtons();
  updateTotal();
  const method=modal.querySelector('[name="method"]');
  const field=modal.querySelector('#transaction-field');
  const input=field.querySelector('input');
  method.addEventListener('change',()=>{
    const upi=method.value==='UPI';
    field.hidden=!upi;
    input.disabled=!upi;
    input.required=upi;
  });
}
logout.onclick=async ()=>{
  logout.disabled=true;
  try { await api('logout',{}); }
  catch (error) { if(error.status!==401){window.alert((error instanceof TypeError ? 'इंटरनेट कनेक्शन जाँचकर फिर कोशिश करें।' : error.message));return;} }
  finally {logout.disabled=false;}
  ledger=null;
  month=null;
  location.hash='dashboard';
  render();
};
window.addEventListener('hashchange',()=>render());
load();
