const root = document.querySelector('#app');
const modal = document.querySelector('#modal');
const logout = document.querySelector('#logout');
const methods = {Cash:'नकद',UPI:'यूपीआई','Bank Transfer':'बैंक ट्रांसफ़र',Cheque:'चेक'};
const shortDate = new Intl.DateTimeFormat('hi-IN',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
const monthDate = new Intl.DateTimeFormat('hi-IN',{timeZone:'UTC',month:'long',year:'numeric'});
const showDate = value => shortDate.format(new Date(value));
const showMonth = value => monthDate.format(new Date(value+'-01'));
const money = amount => (amount/100).toLocaleString('hi-IN',{style:'currency',currency:'INR'});
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const table = (headers,rows) => rows.length ? '<div class="table"><table><thead><tr>'+
  headers.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+
  rows.map(cells=>'<tr>'+cells.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>' :
  '<p>अभी कोई रिकॉर्ड नहीं है।</p>';
let ledger, month, clock;
const shop = id => ledger.shops.find(s=>s.id===id);
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
function overdue() {
  const current = ledger.today.slice(0,7);
  let amount = 0;
  for (const l of ledger.leases) {
    const until = l.end_month && l.end_month < current ? l.end_month : current;
    const serial = m => Number(m.slice(0,4))*12+Number(m.slice(5));
    const count = Math.max(0,serial(until)-serial(l.start_month)+(until < current ? 1 : 0));
    amount += count*l.rent;
  }
  return amount-ledger.payments.filter(p=>p.month<current).reduce((sum,p)=>sum+p.amount,0);
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
  if (route === 'shops') {
    body = toolbar('दुकानें',action('shop','','दुकान जोड़ें')) + table(['दुकान','पता','स्थिति',''],ledger.shops.map(s=>[
      escape(s.code),escape(s.address),ledger.leases.some(l=>l.shop_id===s.id && includesMonth(l,ledger.today.slice(0,7)))?'किराये पर':'खाली',
      action('shop',s.id,'संपादित करें')
    ]));
  } else if (route === 'tenants') {
    body = toolbar('किरायेदारी',action('lease','','किरायेदारी जोड़ें')) + table(['दुकान','किरायेदार','फ़ोन','मासिक किराया','शुरुआती माह','अंतिम माह',''],ledger.leases.map(l=>[
      escape(shop(l.shop_id).code),escape(l.tenant),escape(l.phone),money(l.rent),showMonth(l.start_month),
      l.end_month ? showMonth(l.end_month) : 'जारी',l.end_month?'':action('end',l.id,'समाप्त करें')
    ]));
  } else if (route === 'rent') {
    body = toolbar('मासिक किराया','<label>किराये का महीना<input id="month" type="month" value="'+escape(month)+'" required></label>') +
      table(['दुकान','किरायेदार','किराया','जमा','बाकी',''],rentRows(month).map(({l,paid,balance})=>[
        escape(shop(l.shop_id).code),escape(l.tenant),money(l.rent),money(paid),money(balance),
        balance>0?action('payment',l.id,'किराया जमा करें'):'पूरा जमा'
      ]));
  } else if (route === 'receipts') {
    body = toolbar('किराये की रसीदें') + table(['भुगतान की तारीख','दुकान','किरायेदार','किराये का महीना','राशि','भुगतान का तरीका',''],ledger.payments.map(p=>[
      showDate(p.paid_on),escape(shop(lease(p.lease_id).shop_id).code),escape(lease(p.lease_id).tenant),
      showMonth(p.month),money(p.amount),escape(methods[p.method]),action('print',p.id,'प्रिंट करें')
    ]));
  } else {
    const current = ledger.today.slice(0,7);
    const collected = prefix => ledger.payments.filter(p=>p.paid_on.startsWith(prefix)).reduce((sum,p)=>sum+p.amount,0);
    const metrics = [['आज की वसूली',collected(ledger.today)],['इस महीने की वसूली',collected(current)],
      ['पिछले महीनों का बकाया',overdue()],['इस महीने का बाकी किराया',rentRows(current).reduce((sum,r)=>sum+r.balance,0)]];
    const cards = [['दुकानें','दुकान नंबर और पते का रिकॉर्ड','⌂','shops'],['किरायेदारी','किरायेदार और मासिक किराये का रिकॉर्ड','♙','tenants'],
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
  if (name==='shop') {
    const s=shop(id);
    dialog(s?'दुकान संपादित करें':'दुकान जोड़ें','<label>दुकान का नंबर या नाम<input name="code" maxlength="40" required value="'+escape(s?.code)+'"></label>'+
      '<label>पता<input name="address" maxlength="240" value="'+escape(s?.address)+'"></label>','shops',d=>({...d,id}));
  }
  if (name==='lease') {
    const options=ledger.shops.filter(s=>!ledger.leases.some(l=>l.shop_id===s.id&&!l.end_month));
    dialog('किरायेदारी जोड़ें','<label>दुकान<select name="shop_id" required><option value="">दुकान चुनें</option>'+
      options.map(s=>'<option value="'+s.id+'">'+escape(s.code)+'</option>').join('')+'</select></label>'+
      '<label>किरायेदार का नाम<input name="tenant" maxlength="120" required></label><label>फ़ोन<input name="phone" type="tel" maxlength="32"></label>'+
      '<label>मासिक किराया (₹)<input type="number" name="rent" min=".01" step=".01" required></label>'+
      '<label>किराया शुरू होने का महीना<input type="month" name="start_month" value="'+month+'" required></label>','leases',d=>({...d,rent:minor(d.rent)}));
  }
  if (name==='end') {
    dialog('किरायेदारी समाप्त करें','<label>किराये का अंतिम महीना<input type="month" name="end_month" min="'+lease(id).start_month+
      '" value="'+ledger.today.slice(0,7)+'" required></label>','end-lease',d=>({...d,id}),'किरायेदारी समाप्त करें');
  }
  if (name==='payment') {
    const balance=rentRows(month).find(r=>r.l.id===id).balance/100;
    const paymentId=crypto.randomUUID();
    dialog('किराया जमा करें','<p>'+escape(shop(lease(id).shop_id).code)+' · '+escape(lease(id).tenant)+' · '+showMonth(month)+'</p>'+
      '<label>राशि (₹)<input type="number" step=".01" min=".01" max="'+balance+'" value="'+balance+'" name="amount" required></label>'+
      '<label>भुगतान की तारीख<input type="date" name="paid_on" value="'+ledger.today+'" max="'+ledger.today+'" required></label>'+
      '<label>भुगतान का तरीका<select name="method">'+Object.entries(methods).map(([value,label])=>'<option value="'+value+'">'+label+'</option>').join('')+'</select></label>',
      'payments',d=>({...d,id:paymentId,lease_id:id,month,amount:minor(d.amount)}),'भुगतान सेव करें');
  }
  if (name==='print') {
    const p=ledger.payments.find(item=>item.id===id);
    const l=lease(p.lease_id);
    document.querySelector('#print').innerHTML='<h1>किराये की रसीद</h1><p>मासकॉम इन्फोटेक सॉल्यूशंस</p><p>रसीद क्रमांक '+escape(p.id)+
      '</p><hr><p>दुकान '+escape(shop(l.shop_id).code)+'</p><p>इनसे प्राप्त हुआ '+escape(l.tenant)+'</p><p>किराये का महीना '+showMonth(p.month)+
      '</p><p>भुगतान की तारीख '+showDate(p.paid_on)+'</p><p>भुगतान का तरीका '+escape(methods[p.method])+'</p><h2>'+money(p.amount)+'</h2><p>अधिकृत हस्ताक्षर ____________________</p>';
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
