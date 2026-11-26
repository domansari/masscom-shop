import {readTenantWorkbook} from './tenant-import.js?v=father1';
const formatMobile = value => (value || '').replace(/^([0-9]{5})([0-9]{5})$/,'$1-$2');
const formatTenantId = value => (value || '').replace(/^([0-9]{4})([0-9]{4})([0-9]{4})$/,'$1-$2-$3');
const root = document.querySelector('#app');
const modal = document.querySelector('#modal');
const logout = document.querySelector('#logout');
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
let marketFilter = '';
const shop = id => ledger.shops.find(s=>s.id===id);
const marketOf = s => ledger.markets.find(m=>m.id===s.market_id);
const shopNumber = s => marketOf(s) ? s.code.slice(marketOf(s).prefix.length+1) : s.code;
const shopLabel = s => marketOf(s) ? marketOf(s).name+' · '+shopNumber(s) : s.code;
const inMarket = s => !marketFilter || (s.market_id || 'unassigned') === marketFilter;
const marketOptions = (selected, filter=false) =>
  '<option value="">'+(filter?'सभी मार्केट':'मार्केट नहीं चुना')+'</option>'+
  (filter && ledger.shops.some(s=>!s.market_id)?'<option value="unassigned"'+(selected==='unassigned'?' selected':'')+'>बिना मार्केट</option>':'')+
  ledger.markets.map(m=>'<option value="'+escape(m.id)+'"'+(m.id===selected?' selected':'')+'>'+escape(m.name)+'</option>').join('');
const marketPicker = () => '<label>मार्केट<select id="market-filter">'+marketOptions(marketFilter,true)+'</select></label>';
const tenantFor = l => ledger.tenants.find(t=>t.id===l.tenant_id);
const lease = id => ledger.leases.find(l=>l.id===id);
const includesMonth = (l,m) => l.start_month <= m && (!l.end_month || l.end_month >= m);
const action = (name,id,label) => '<button type="button" data-action="'+name+'" data-id="'+escape(id)+'">'+label+'</button>';
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
function render(error = '') {
  clearInterval(clock);
  logout.hidden = !ledger;
  if (!ledger) {
    root.innerHTML = '<section class="login panel"><h1>प्रशासक लॉगिन</h1><form id="login"><label>पासवर्ड<input type="password" name="password" minlength="8" maxlength="20" autocomplete="current-password" required></label><p class="error" role="alert">'+escape(error)+'</p><button class="primary">लॉगिन करें</button></form></section>';
    document.querySelector('#login').addEventListener('submit',e=>submit(e,async d=>{await api('login',d);await load();}));
    return;
  }
  const route = location.hash.slice(1);
  const toolbar = (title,tools='')=>'<div class="toolbar"><h2>'+title+'</h2><div>'+tools+'</div></div>';
  let body;
  const current = ledger.today.slice(0,7);
  const isOccupied = l => l.start_month<=current && (!l.end_month || l.end_month>current);
  const occupied = id => ledger.leases.some(l=>l.shop_id===id && isOccupied(l));
  if (route.startsWith('tenant/')) {
    const tenant = ledger.tenants.find(t=>t.id===route.slice(7));
    body = '<a class="button" href="#tenants">← किरायेदार</a>';
    if (tenant) body += toolbar(escape(tenant.name),action('tenant',tenant.id,'विवरण संपादित करें')) +
      (tenant.has_photo?'<img width="144" src="/api/tenant-photo?id='+encodeURIComponent(tenant.id)+'" alt="किरायेदार की फ़ोटो">':'') + '<p>मोबाइल नंबर · '+escape(formatMobile(tenant.phone) || '—')+'</p>'+
      '<p>पिता का नाम · '+escape(tenant.father_name || '—')+'</p>'+
      '<p>पता · '+escape(tenant.address || '—')+'</p>'+
      '<p>व्यापार · '+escape(tenant.business || '—')+'</p>'+
      '<p>किरायेदार आईडी नंबर · '+escape(formatTenantId(tenant.tenant_id_number) || '—')+'</p>' +
      table(['दुकान','सुरक्षा राशि जमा','वापसी','किरायेदारी',''],ledger.leases.filter(l=>l.tenant_id===tenant.id).map(l=>[
        escape(shopLabel(shop(l.shop_id))),money(l.deposit),
        l.deposit_returned_on ? showDate(l.deposit_returned_on) : l.deposit ? 'वापसी बाकी' : '—',
        l.end_month ? showMonth(l.end_month)+' तक' : 'जारी',
        l.end_month ? '' : l.deposit && !l.deposit_returned_on
          ? action('return-deposit',l.id,'सुरक्षा राशि वापस करें') : action('end',l.id,'समाप्त करें')
      ]));
  } else if (route === 'markets') {
    body = toolbar('मार्केट') + table(['मार्केट','कुल दुकानें','किराये पर','आगे के लिए आवंटित','खाली',''],ledger.markets.map(m=>{
      const shops = ledger.shops.filter(s=>s.market_id===m.id);
      const rented = shops.filter(s=>occupied(s.id)).length;
      const reserved = shops.filter(s=>!occupied(s.id) && ledger.leases.some(l=>l.shop_id===s.id && l.start_month>current)).length;
      return [escape(m.name),shops.length,rented,reserved,shops.length-rented-reserved,action('open-market',m.id,'दुकानें देखें')];
    }));
  } else if (route === 'shops') {
    body = toolbar('दुकानें',marketPicker()+action('shop','','दुकान जोड़ें')) + table(['मार्केट','दुकान','पता','स्थिति',''],ledger.shops.filter(inMarket).map(s=>[
      escape(marketOf(s)?.name || '—'),escape(shopNumber(s)),escape(s.address),occupied(s.id)?'किराये पर':ledger.leases.some(l=>l.shop_id===s.id && l.start_month>current)?'आगे के लिए आवंटित':'खाली',
      action('shop',s.id,'संपादित करें')
    ]));
  } else if (route === 'tenants') {
    const receiptsByLease = new Map();
    for (const receipt of receiptRows()) {
      if (!receiptsByLease.has(receipt.lease_id)) receiptsByLease.set(receipt.lease_id,[]);
      receiptsByLease.get(receipt.lease_id).push(receipt);
    }
    body = toolbar('किरायेदार',action('tenant','','किरायेदार जोड़ें')+' '+action('lease','','दुकान आवंटित करें')+' '+action('import-tenants','','Excel इम्पोर्ट')+' <a class="button" href="/kirayedaar-import-template.xlsx?v=father1" download>Excel टेम्पलेट</a>') +
    table(['किरायेदार','पिता का नाम','मोबाइल नंबर','अभी किराये पर ली गई दुकानें',''],ledger.tenants.map(t=>[
      escape(t.name),escape(t.father_name || '—'),escape(formatMobile(t.phone)),ledger.leases.filter(l=>l.tenant_id===t.id && isOccupied(l))
        .map(l=>escape(shopLabel(shop(l.shop_id)))).join('<br>')||'—','<a class="button" href="#tenant/'+escape(t.id)+'">विवरण</a> '+action('lease',t.id,'दुकान आवंटित करें')
    ])) + toolbar('किरायेदारी का रिकॉर्ड',marketPicker()) + table(['दुकान','किरायेदार','फ़ोन','मासिक किराया','शुरुआती माह','अंतिम माह','जमा भुगतान',''],ledger.leases.filter(l=>inMarket(shop(l.shop_id))).map(l=>[
      escape(shopLabel(shop(l.shop_id))),escape(tenantFor(l)?.name ?? l.tenant),escape(tenantFor(l)?.phone ?? l.phone),money(l.rent),showMonth(l.start_month),
      l.end_month ? showMonth(l.end_month) : 'जारी',tenancyPayments(receiptsByLease.get(l.id) || []),'<a class="button" href="#tenant/'+escape(l.tenant_id)+'">किरायेदार विवरण</a>'
    ]));
  } else if (route === 'rent') {
    body = toolbar('मासिक किराया',marketPicker()+'<label>किराये का महीना<input id="month" type="month" value="'+escape(month)+'" required></label>') +
      table(['दुकान','किरायेदार','किराया','जमा','बाकी',''],rentRows(month).filter(({l})=>inMarket(shop(l.shop_id))).map(({l,paid,balance})=>[
        escape(shopLabel(shop(l.shop_id))),escape(tenantFor(l)?.name ?? l.tenant),money(l.rent),money(paid),money(balance),
        balance>0?action('payment',l.id,'किराया जमा करें'):'पूरा जमा '+action('payment',l.id,'अन्य माह जमा करें')
      ]));
    body += toolbar('शुरुआती बकाया') + table(['दुकान','किरायेदार','शुरुआत में दर्ज रकम','जमा','अब बाकी',''],
      openingRows().filter(({l})=>inMarket(shop(l.shop_id))).map(({l,paid,balance})=>[
        escape(shopLabel(shop(l.shop_id))),escape(tenantFor(l)?.name ?? l.tenant),money(l.opening),money(paid),money(balance),
        balance>0?action('opening-payment',l.id,'बकाया जमा करें'):'पूरा जमा'
      ]));
  } else if (route === 'receipts') {
    body = toolbar('किराये की रसीदें',marketPicker()) + table(['भुगतान की तारीख','दुकान','किरायेदार','किराये का महीना','राशि','भुगतान का तरीका','ट्रांज़ैक्शन आईडी','रसीद नंबर',''],receiptRows().filter(p=>inMarket(shop(lease(p.lease_id).shop_id))).map(p=>[
      showDate(p.paid_on),escape(shopLabel(shop(lease(p.lease_id).shop_id))),escape(lease(p.lease_id).tenant),
      p.items.map(paymentPeriod).join(' · '),money(p.amount),escape(methods[p.method]),escape(p.transaction_id || '—'),escape(p.receipt_number || '—'),action('print',p.id,'प्रिंट करें')
    ]));
  } else {
    const collected = prefix => ledger.payments.filter(p=>p.paid_on.startsWith(prefix)).reduce((sum,p)=>sum+p.amount,0);
    const metrics = [['आज की वसूली',collected(ledger.today)],['इस महीने की वसूली',collected(current)],
      ['पिछले महीनों का बकाया',overdue()],['इस महीने का बाकी किराया',rentRows(current).reduce((sum,r)=>sum+r.balance,0)]];
    const paid = [0,0,0];
    for (const payment of ledger.payments) {
      const receiptMonth = payment.paid_on.slice(0,7);
      const category = payment.month==='opening' || payment.month<receiptMonth ? 0 :
        payment.month===receiptMonth ? 1 : 2;
      paid[category]+=payment.amount;
    }
    const rentAmounts = [...paid,Math.max(0,overdue()),rentRows(current).reduce((sum,row)=>sum+row.balance,0)];
    const rentLabels = ['पुराना बकाया जमा','चालू किराया जमा','एडवांस जमा','पुराना बकाया बाकी','इस महीने का किराया बाकी'];
    const chartTotal = rentAmounts.reduce((sum,amount)=>sum+amount,0);
    const colors = ['#a78bfa','#34d399','#60a5fa','#fb7185','#fbbf24'];
    let offset=0;
    const chart = rentAmounts.map((amount,i)=>{
      const from=offset;
      const length=chartTotal?amount/chartTotal*100:0;
      offset+=length;
      return '<circle cx="60" cy="60" r="44" pathLength="100" fill="none" stroke="'+colors[i]+'" stroke-width="30" '+
        'stroke-dasharray="'+length+' '+(100-length)+'" stroke-dashoffset="'+(-from)+'" transform="rotate(-90 60 60)"/>';
    }).join('');
    const cards = [['किरायेदार','एक किरायेदार के नाम कई दुकानें','♙','tenants'],
      ['मासिक किराया','किराया जमा करें और बकाया देखें','₹','rent'],['किराये की रसीदें','भुगतान देखें और रसीद प्रिंट करें','▤','receipts']];
    root.innerHTML = '<div class="hero dashboard-hero"><img class="dashboard-logo" src="/dashboard-logo.png" width="713" height="515" alt="लोगो"><div><h1>दुकान किराया प्रबंधन</h1><p>मासकॉम इन्फोटेक सॉल्यूशंस</p></div>'+
      '<div class="dashboard-clock"><svg viewBox="0 0 80 80" aria-hidden="true"><circle class="clock-face" cx="40" cy="40" r="37"/>'+
      Array.from({length:12},(_,i)=>'<line class="clock-tick" x1="40" y1="8" x2="40" y2="'+(i%3===0?14:11)+'" transform="rotate('+i*30+' 40 40)"/>').join('')+
      '<line id="clock-hour" class="clock-hour" x1="40" y1="40" x2="40" y2="22"/>'+
      '<line id="clock-minute" class="clock-minute" x1="40" y1="40" x2="40" y2="15"/>'+
      '<line id="clock-second" class="clock-second" x1="40" y1="46" x2="40" y2="13"/>'+
      '<circle class="clock-pin" cx="40" cy="40" r="3"/></svg><time id="date"></time></div></div>'+
      '<section class="panel">'+toolbar('किराये का सारांश','<a href="#rent" class="button primary">किराया जमा करें</a>')+'<div class="metrics">'+
      metrics.map(([name,value])=>'<div class="metric">'+name+'<strong>'+money(value)+'</strong></div>').join('')+'</div></section>'+
      '<section class="panel occupancy-panel"><h2>किराया जमा और बकाया</h2><div class="occupancy-content">'+
      '<svg viewBox="0 0 120 120" aria-hidden="true">'+(chartTotal?chart:'<circle cx="60" cy="60" r="44" fill="none" stroke="#334155" stroke-width="30"/>')+'</svg><ul>'+
      rentLabels.map((label,i)=>'<li><span class="occupancy-dot occupancy-dot-'+i+'"></span>'+label+' <strong>'+money(rentAmounts[i])+'</strong></li>').join('')+
      '</ul></div></section>'+
      '<div class="grid dashboard-grid"><section class="card"><span class="icon" aria-hidden="true">▦</span><h2>मार्केट और दुकानें</h2>'+
      '<nav class="catalog-tabs" aria-label="मार्केट और दुकानें"><a class="button" href="#markets">मार्केट <strong>'+ledger.markets.length+'</strong></a>'+
      '<a class="button" href="#shops">दुकानें <strong>'+ledger.shops.length+'</strong></a></nav></section>'+cards.map(([title,description,icon,target])=>'<a class="card" href="#'+target+'"><span class="icon" aria-hidden="true">'+icon+'</span><h2>'+title+'</h2><p>'+description+'</p></a>').join('')+
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
  root.innerHTML = '<div class="toolbar"><a class="button" href="#dashboard">← डैशबोर्ड</a></div><section class="panel">'+body+'</section>';
  document.querySelector('#market-filter')?.addEventListener('change',event=>{marketFilter=event.target.value;render();});
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
  if (name==='shop') {
    const s=shop(id);
    dialog(s?'दुकान संपादित करें':'दुकान जोड़ें','<label>मार्केट<select name="market_id">'+marketOptions(s?.market_id || (!s && marketFilter !== 'unassigned' ? marketFilter : ''))+'</select></label>'+
      '<label>दुकान का नंबर या नाम<input name="code" maxlength="40" required value="'+escape(s ? shopNumber(s) : '')+'"></label>'+
      '<label>पता<input name="address" maxlength="240" value="'+escape(s?.address)+'"></label>','shops',d=>({...d,id}));
  }
  if (name==='lease') {
    const options=ledger.shops.filter(s=>!ledger.leases.some(l=>l.shop_id===s.id&&!l.end_month));
    const tenantOptions = tenants=>'<option value="">किरायेदार चुनें</option>'+
      tenants.map(t=>'<option value="'+escape(t.id)+'">'+escape(t.name+(t.phone?' · '+formatMobile(t.phone):''))+'</option>').join('');
    dialog('दुकान आवंटित करें','<label>किरायेदार का मार्केट<select name="tenant_market"><option value="">सभी मार्केट</option>'+
      ledger.markets.map(m=>'<option value="'+escape(m.id)+'">'+escape(m.name)+'</option>').join('')+
      '<option value="unallocated">बिना चालू आवंटन</option></select></label><label>किरायेदार<select name="tenant_id" required>'+
      tenantOptions(ledger.tenants)+
      '</select></label><label>मार्केट<select name="market_id" required><option value="">मार्केट चुनें</option>'+
      ledger.markets.map(m=>'<option value="'+escape(m.id)+'">'+escape(m.name)+'</option>').join('')+
      (options.some(s=>!s.market_id)?'<option value="unassigned">बिना मार्केट</option>':'')+'</select></label>'+
      '<fieldset><legend>दुकानें चुनें</legend><div id="allocation-shops">पहले मार्केट चुनें</div></fieldset>'+

      '<label>मासिक किराया प्रति दुकान (₹)<input type="number" name="rent" min=".01" step=".01" required></label>'+
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
      const tenants = !market ? ledger.tenants : ledger.tenants.filter(t=>market==='unallocated'
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
  if (name==='return-deposit') {
    dialog('सुरक्षा राशि की वापसी','<p>वापस की गई राशि · '+money(lease(id).deposit)+'</p>'+
      '<label>वापसी की तारीख<input type="date" name="returned_on" value="'+ledger.today+'" max="'+ledger.today+'" required></label>'+
      passwordField,'return-deposit',d=>({...d,id}),'वापसी दर्ज करें');
  }
  if (name==='end') {
    dialog('किरायेदारी समाप्त करें','<label>किराये का अंतिम महीना<input type="month" name="end_month" min="'+lease(id).start_month+
      '" value="'+ledger.today.slice(0,7)+'" required></label>'+passwordField,'end-lease',d=>({...d,id}),'किरायेदारी समाप्त करें');
  }
  if (name==='payment' || name==='opening-payment') {
    const opening = name==='opening-payment';
    const periods = payablePeriods(lease(id));
    const current = ledger.today.slice(0,7);
    if (!periods.length) { window.alert('इस दुकान के लिए कोई किराया जमा करना बाकी नहीं है।'); return; }
    const periodFields = periods.map(([key,balance])=>{
      const type = key==='opening' ? '' : key<current ? 'बकाया · ' : key===current ? 'चालू · ' : 'एडवांस · ';
      return '<label>'+type+paymentPeriod({month:key})+' (बाकी '+money(balance)+')'+
        '<input type="number" name="period_'+key+'" step=".01" min="0" max="'+balance/100+'"></label>';
    }).join('');
    const paymentId=crypto.randomUUID();
    dialog(opening?'शुरुआती बकाया जमा करें':'किराया जमा करें','<p>'+escape(shopLabel(shop(lease(id).shop_id)))+' · '+escape(tenantFor(lease(id))?.name ?? lease(id).tenant)+' · '+(opening?'शुरुआती बकाया':showMonth(month))+'</p>'+
      '<fieldset><legend>जिन महीनों का किराया लेना है, उनकी राशि भरें</legend>'+periodFields+'</fieldset>'+
      '<p>कुल भुगतान <strong id="payment-total"></strong></p>'+
      '<label>रसीद नंबर<input name="receipt_number" maxlength="60" required></label>'+
      '<label>भुगतान की तारीख<input type="date" name="paid_on" value="'+ledger.today+'" max="'+ledger.today+'" required></label>'+
      '<label>भुगतान का तरीका<select name="method"><option value="Cash">नकद</option><option value="UPI">यूपीआई</option></select></label>'+
      '<label id="transaction-field" hidden>यूपीआई ट्रांज़ैक्शन आईडी<input name="transaction_id" maxlength="100" disabled></label>',
      'payments',({receipt_number,paid_on,method,transaction_id,...amounts})=>{
        const items = Object.entries(amounts).map(([key,value])=>({month:key.slice(7),amount:minor(value)})).filter(item=>item.amount>0);
        if (!items.length) throw new Error('किसी महीने या बकाये की राशि भरें।');
        return {id:paymentId,lease_id:id,receipt_number,paid_on,method,transaction_id,items};
      },'भुगतान सेव करें');
    const paymentFields = [...modal.querySelectorAll('[name^="period_"]')];
    const updateTotal = ()=>{modal.querySelector('#payment-total').textContent=money(paymentFields.reduce((sum,input)=>sum+minor(input.value),0));};
    for (const input of paymentFields) input.addEventListener('input',updateTotal);
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
  if (name==='print') {
    const p=receiptRows().find(item=>item.id===id);
    const l=lease(p.lease_id);
    document.querySelector('#print').innerHTML='<h1>किराये की रसीद</h1><p>मासकॉम इन्फोटेक सॉल्यूशंस</p><p>ऐप रसीद आईडी '+escape(p.id)+
      '</p>'+(p.receipt_number?'<p>रसीद नंबर '+escape(p.receipt_number)+'</p>':'')+'<hr><p>दुकान '+escape(shopLabel(shop(l.shop_id)))+'</p><p>इनसे प्राप्त हुआ '+escape(l.tenant)+'</p>'+table(['किराये का महीना','जमा राशि'],p.items.map(item=>[paymentPeriod(item),money(item.amount)]))+
      '<p>भुगतान की तारीख '+showDate(p.paid_on)+'</p><p>भुगतान का तरीका '+escape(methods[p.method])+'</p>'+(p.transaction_id?'<p>यूपीआई ट्रांज़ैक्शन आईडी '+escape(p.transaction_id)+'</p>':'')+'<h2>'+money(p.amount)+'</h2><p>अधिकृत हस्ताक्षर ____________________</p>';
    window.print();
  }
});
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
window.addEventListener('hashchange',()=>{if(ledger)render();});
load();
