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
const lease = id => ledger.leases.find(l=>l.id===id);
const includesMonth = (l,m) => l.start_month <= m && (!l.end_month || l.end_month >= m);
const action = (name,id,label) => '<button type="button" data-action="'+name+'" data-id="'+escape(id)+'">'+label+'</button>';
const dateFormat = new Intl.DateTimeFormat('hi-IN',{timeZone:'Asia/Kolkata',dateStyle:'full'});
const clockFormat = new Intl.DateTimeFormat('hi-IN',{timeZone:'Asia/Kolkata',timeStyle:'medium',hourCycle:'h23'});

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
const paymentPeriod = p => p.month==='opening' ? 'शुरुआती बकाया' : showMonth(p.month);
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
    if (tenant) body += toolbar(escape(tenant.name)) + '<p>'+escape(tenant.phone)+'</p>' +
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
    body = toolbar('किरायेदार',action('tenant','','किरायेदार जोड़ें')+' '+action('lease','','दुकान आवंटित करें')) +
    table(['किरायेदार','फ़ोन','अभी किराये पर ली गई दुकानें',''],ledger.tenants.map(t=>[
      escape(t.name),escape(t.phone),ledger.leases.filter(l=>l.tenant_id===t.id && isOccupied(l))
        .map(l=>escape(shopLabel(shop(l.shop_id)))).join('<br>')||'—','<a class="button" href="#tenant/'+escape(t.id)+'">विवरण</a> '+action('lease',t.id,'दुकान आवंटित करें')
    ])) + toolbar('किरायेदारी का रिकॉर्ड',marketPicker()) + table(['दुकान','किरायेदार','फ़ोन','मासिक किराया','शुरुआती माह','अंतिम माह',''],ledger.leases.filter(l=>inMarket(shop(l.shop_id))).map(l=>[
      escape(shopLabel(shop(l.shop_id))),escape(l.tenant),escape(l.phone),money(l.rent),showMonth(l.start_month),
      l.end_month ? showMonth(l.end_month) : 'जारी','<a class="button" href="#tenant/'+escape(l.tenant_id)+'">किरायेदार विवरण</a>'
    ]));
  } else if (route === 'rent') {
    body = toolbar('मासिक किराया',marketPicker()+'<label>किराये का महीना<input id="month" type="month" value="'+escape(month)+'" required></label>') +
      table(['दुकान','किरायेदार','किराया','जमा','बाकी',''],rentRows(month).filter(({l})=>inMarket(shop(l.shop_id))).map(({l,paid,balance})=>[
        escape(shopLabel(shop(l.shop_id))),escape(l.tenant),money(l.rent),money(paid),money(balance),
        balance>0?action('payment',l.id,'किराया जमा करें'):'पूरा जमा'
      ]));
    body += toolbar('शुरुआती बकाया') + table(['दुकान','किरायेदार','कुल बकाया','जमा','बाकी',''],
      openingRows().filter(({l})=>inMarket(shop(l.shop_id))).map(({l,paid,balance})=>[
        escape(shopLabel(shop(l.shop_id))),escape(l.tenant),money(l.opening),money(paid),money(balance),
        balance>0?action('opening-payment',l.id,'बकाया जमा करें'):'पूरा जमा'
      ]));
  } else if (route === 'receipts') {
    body = toolbar('किराये की रसीदें',marketPicker()) + table(['भुगतान की तारीख','दुकान','किरायेदार','किराये का महीना','राशि','भुगतान का तरीका','ट्रांज़ैक्शन आईडी',''],ledger.payments.filter(p=>inMarket(shop(lease(p.lease_id).shop_id))).map(p=>[
      showDate(p.paid_on),escape(shopLabel(shop(lease(p.lease_id).shop_id))),escape(lease(p.lease_id).tenant),
      paymentPeriod(p),money(p.amount),escape(methods[p.method]),escape(p.transaction_id || '—'),action('print',p.id,'प्रिंट करें')
    ]));
  } else {
    const collected = prefix => ledger.payments.filter(p=>p.paid_on.startsWith(prefix)).reduce((sum,p)=>sum+p.amount,0);
    const metrics = [['आज की वसूली',collected(ledger.today)],['इस महीने की वसूली',collected(current)],
      ['पिछले महीनों का बकाया',overdue()],['इस महीने का बाकी किराया',rentRows(current).reduce((sum,r)=>sum+r.balance,0)]];
    const cards = [['मार्केट',ledger.markets.length+' मार्केट · '+ledger.shops.length+' दुकानें','▦','markets'],['दुकानें','दुकान नंबर और पते का रिकॉर्ड','⌂','shops'],['किरायेदार','एक किरायेदार के नाम कई दुकानें','♙','tenants'],
      ['मासिक किराया','किराया जमा करें और बकाया देखें','₹','rent'],['किराये की रसीदें','भुगतान देखें और रसीद प्रिंट करें','▤','receipts']];
    root.innerHTML = '<div class="hero"><h1>दुकान किराया प्रबंधन</h1><p>मासकॉम इन्फोटेक सॉल्यूशंस</p></div>'+
      '<section class="panel">'+toolbar('किराये का सारांश','<a href="#rent" class="button primary">किराया जमा करें</a>')+'<div class="metrics">'+
      metrics.map(([name,value])=>'<div class="metric">'+name+'<strong>'+money(value)+'</strong></div>').join('')+'</div></section>'+
      '<div class="grid">'+cards.map(([title,description,icon,target])=>'<a class="card" href="#'+target+'"><span class="icon" aria-hidden="true">'+icon+'</span><h2>'+title+'</h2><p>'+description+'</p></a>').join('')+
      '<section class="card"><span class="icon" aria-hidden="true">◷</span><h2>डिजिटल घड़ी</h2><time id="clock"></time><p id="date"></p></section></div>';
    const tick = ()=>{const now=new Date();document.querySelector('#clock').textContent=clockFormat.format(now);document.querySelector('#date').textContent=dateFormat.format(now);};
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
    await api(route,convert(values));
    modal.close();
    await load();
  });
  modal.showModal();
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
  if (name==='tenant') {
    dialog('किरायेदार जोड़ें','<label>किरायेदार का नाम<input name="name" maxlength="120" required></label>'+
      '<label>फ़ोन<input name="phone" type="tel" maxlength="32"></label>','tenants',d=>d);
  }
  if (name==='shop') {
    const s=shop(id);
    dialog(s?'दुकान संपादित करें':'दुकान जोड़ें','<label>मार्केट<select name="market_id">'+marketOptions(s?.market_id || (!s && marketFilter !== 'unassigned' ? marketFilter : ''))+'</select></label>'+
      '<label>दुकान का नंबर या नाम<input name="code" maxlength="40" required value="'+escape(s ? shopNumber(s) : '')+'"></label>'+
      '<label>पता<input name="address" maxlength="240" value="'+escape(s?.address)+'"></label>','shops',d=>({...d,id}));
  }
  if (name==='lease') {
    const options=ledger.shops.filter(s=>!ledger.leases.some(l=>l.shop_id===s.id&&!l.end_month));
    dialog('दुकान आवंटित करें','<label>किरायेदार<select name="tenant_id" required><option value="">किरायेदार चुनें</option>'+
      ledger.tenants.map(t=>'<option value="'+escape(t.id)+'"'+(t.id===id?' selected':'')+'>'+escape(t.name+(t.phone?' · '+t.phone:''))+'</option>').join('')+
      '</select></label><label>मार्केट<select name="market_id" required><option value="">मार्केट चुनें</option>'+
      ledger.markets.map(m=>'<option value="'+escape(m.id)+'">'+escape(m.name)+'</option>').join('')+
      (options.some(s=>!s.market_id)?'<option value="unassigned">बिना मार्केट</option>':'')+'</select></label>'+
      '<label>दुकान<select name="shop_id" required><option value="">पहले मार्केट चुनें</option></select></label>'+

      '<label>मासिक किराया (₹)<input type="number" name="rent" min=".01" step=".01" required></label>'+
      '<label>किराया शुरू होने का महीना<select name="start_month" required><option value="">महीना चुनें</option>'+
      startMonthOptions(ledger.today)+'</select></label>'+
      '<label>शुरुआती बकाया (₹)<input type="number" name="opening" min="0" step=".01" value="0"></label>'+
      '<label>जमा सुरक्षा राशि (₹)<input type="number" name="deposit" min="0" step=".01" value="0"></label>',
      'leases',({market_id,...d})=>({...d,rent:minor(d.rent),opening:minor(d.opening),deposit:minor(d.deposit)}));
    const marketSelect = modal.querySelector('[name="market_id"]');
    const shopSelect = modal.querySelector('[name="shop_id"]');
    marketSelect.addEventListener('change',()=>{
      const selected = marketSelect.value;
      const shops = options.filter(s=>(s.market_id || 'unassigned')===selected);
      const prompt = !selected ? 'पहले मार्केट चुनें' : shops.length ? 'दुकान चुनें' : 'कोई दुकान उपलब्ध नहीं है';
      shopSelect.replaceChildren(new Option(prompt,''));
      for (const s of shops) shopSelect.add(new Option(shopNumber(s),s.id));
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
    const period = opening ? 'opening' : month;
    const balance=(opening ? openingRows() : rentRows(month)).find(r=>r.l.id===id).balance/100;
    const paymentId=crypto.randomUUID();
    dialog(opening?'शुरुआती बकाया जमा करें':'किराया जमा करें','<p>'+escape(shopLabel(shop(lease(id).shop_id)))+' · '+escape(lease(id).tenant)+' · '+(opening?'शुरुआती बकाया':showMonth(month))+'</p>'+
      '<label>राशि (₹)<input type="number" step=".01" min=".01" max="'+balance+'" value="'+balance+'" name="amount" required></label>'+
      '<label>भुगतान की तारीख<input type="date" name="paid_on" value="'+ledger.today+'" max="'+ledger.today+'" required></label>'+
      '<label>भुगतान का तरीका<select name="method"><option value="Cash">नकद</option><option value="UPI">यूपीआई</option></select></label>'+
      '<label id="transaction-field" hidden>यूपीआई ट्रांज़ैक्शन आईडी<input name="transaction_id" maxlength="100" disabled></label>',
      'payments',d=>({...d,id:paymentId,lease_id:id,month:period,amount:minor(d.amount)}),'भुगतान सेव करें');
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
    const p=ledger.payments.find(item=>item.id===id);
    const l=lease(p.lease_id);
    document.querySelector('#print').innerHTML='<h1>किराये की रसीद</h1><p>मासकॉम इन्फोटेक सॉल्यूशंस</p><p>रसीद क्रमांक '+escape(p.id)+
      '</p><hr><p>दुकान '+escape(shopLabel(shop(l.shop_id)))+'</p><p>इनसे प्राप्त हुआ '+escape(l.tenant)+'</p><p>किराये का महीना '+paymentPeriod(p)+
      '</p><p>भुगतान की तारीख '+showDate(p.paid_on)+'</p><p>भुगतान का तरीका '+escape(methods[p.method])+'</p>'+(p.transaction_id?'<p>यूपीआई ट्रांज़ैक्शन आईडी '+escape(p.transaction_id)+'</p>':'')+'<h2>'+money(p.amount)+'</h2><p>अधिकृत हस्ताक्षर ____________________</p>';
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
