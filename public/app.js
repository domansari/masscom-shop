const root = document.querySelector('#app');
const modal = document.querySelector('#modal');
const logout = document.querySelector('#logout');
const money = amount => (amount/100).toLocaleString('en-IN',{style:'currency',currency:'INR'});
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const table = (headers,rows) => rows.length ? '<div class="table"><table><thead><tr>'+
  headers.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+
  rows.map(cells=>'<tr>'+cells.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>' :
  '<p>No records to show.</p>';
let ledger, month, clock;
const shop = id => ledger.shops.find(s=>s.id===id);
const lease = id => ledger.leases.find(l=>l.id===id);
const includesMonth = (l,m) => l.start_month <= m && (!l.end_month || l.end_month >= m);
const action = (name,id,label) => '<button type="button" data-action="'+name+'" data-id="'+escape(id)+'">'+label+'</button>';
const dateFormat = new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'full'});
const clockFormat = new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',timeStyle:'medium',hourCycle:'h23'});

async function api(route,data) {
  const response = await fetch('/api/'+route,data === undefined ? {} : {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error),{status:response.status});
  return result;
}
async function load() {
  try {
    ledger = await api('ledger');
    month ??= ledger.today.slice(0,7);
    render();
  } catch (error) {
    ledger = null;
    render(error.status === 401 ? '' : error.message);
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
    root.innerHTML = '<section class="login panel"><h1>Admin Sign In</h1><form id="login"><label>Password<input type="password" name="password" minlength="8" maxlength="20" autocomplete="current-password" required></label><p class="error" role="alert">'+escape(error)+'</p><button class="primary">Sign In</button></form></section>';
    document.querySelector('#login').addEventListener('submit',e=>submit(e,async d=>{await api('login',d);await load();}));
    return;
  }
  const route = location.hash.slice(1);
  const toolbar = (title,tools='')=>'<div class="toolbar"><h2>'+title+'</h2><div>'+tools+'</div></div>';
  let body;
  if (route === 'shops') {
    body = toolbar('Shops',action('shop','','Add Shop')) + table(['Shop','Address','Status',''],ledger.shops.map(s=>[
      escape(s.code),escape(s.address),ledger.leases.some(l=>l.shop_id===s.id && includesMonth(l,ledger.today.slice(0,7)))?'Occupied':'Vacant',
      action('shop',s.id,'Edit')
    ]));
  } else if (route === 'tenants') {
    body = toolbar('Tenancies',action('lease','','Add Tenancy')) + table(['Shop','Tenant','Phone','Monthly Rent','From','Through',''],ledger.leases.map(l=>[
      escape(shop(l.shop_id).code),escape(l.tenant),escape(l.phone),money(l.rent),escape(l.start_month),
      escape(l.end_month||'Open'),l.end_month?'':action('end',l.id,'End')
    ]));
  } else if (route === 'rent') {
    body = toolbar('Monthly Rent','<label>Rent month<input id="month" type="month" value="'+escape(month)+'" required></label>') +
      table(['Shop','Tenant','Rent','Paid','Balance',''],rentRows(month).map(({l,paid,balance})=>[
        escape(shop(l.shop_id).code),escape(l.tenant),money(l.rent),money(paid),money(balance),
        balance>0?action('payment',l.id,'Collect Rent'):'Paid'
      ]));
  } else if (route === 'receipts') {
    body = toolbar('Rent Receipts') + table(['Payment Date','Shop','Tenant','Rent Month','Amount','Method',''],ledger.payments.map(p=>[
      escape(p.paid_on),escape(shop(lease(p.lease_id).shop_id).code),escape(lease(p.lease_id).tenant),
      escape(p.month),money(p.amount),escape(p.method),action('print',p.id,'Print')
    ]));
  } else {
    const current = ledger.today.slice(0,7);
    const collected = prefix => ledger.payments.filter(p=>p.paid_on.startsWith(prefix)).reduce((sum,p)=>sum+p.amount,0);
    const metrics = [['Today’s Collection',collected(ledger.today)],['This Month’s Collection',collected(current)],
      ['Earlier Months’ Arrears',overdue()],['This Month’s Balance',rentRows(current).reduce((sum,r)=>sum+r.balance,0)]];
    const cards = [['Shops','Manage shop numbers and addresses','⌂','shops'],['Tenancies','Manage tenants and monthly rent','♙','tenants'],
      ['Monthly Rent','Collect rent and check balances','₹','rent'],['Rent Receipts','Review and print payments','▤','receipts']];
    root.innerHTML = '<div class="hero"><h1>Shop Rent Management</h1><p>Masscom Infotech Solutions</p></div>'+
      '<section class="panel">'+toolbar('Rent Overview','<a href="#rent" class="button primary">Collect Rent</a>')+'<div class="metrics">'+
      metrics.map(([name,value])=>'<div class="metric">'+name+'<strong>'+money(value)+'</strong></div>').join('')+'</div></section>'+
      '<div class="grid">'+cards.map(([title,description,icon,target])=>'<a class="card" href="#'+target+'"><span class="icon" aria-hidden="true">'+icon+'</span><h2>'+title+'</h2><p>'+description+'</p></a>').join('')+
      '<section class="card"><span class="icon" aria-hidden="true">◷</span><h2>Digital Clock</h2><time id="clock"></time><p id="date"></p></section></div>';
    const tick = ()=>{const now=new Date();document.querySelector('#clock').textContent=clockFormat.format(now);document.querySelector('#date').textContent=dateFormat.format(now);};
    tick();
    clock = setInterval(tick,1000);
    return;
  }
  root.innerHTML = '<div class="toolbar"><a class="button" href="#dashboard">← Dashboard</a></div><section class="panel">'+body+'</section>';
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
  catch (failure) {error.textContent=failure.message;}
  finally {button.disabled=false;}
}
function dialog(title,fields,route,convert,button='Save') {
  modal.innerHTML='<h2>'+title+'</h2><form>'+fields+'<p class="error" role="alert"></p>'+
    '<div class="toolbar"><button type="button" id="cancel">Cancel</button><button class="primary" type="submit">'+button+'</button></div></form>';
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
    dialog(s?'Edit Shop':'Add Shop','<label>Shop number or name<input name="code" maxlength="40" required value="'+escape(s?.code)+'"></label>'+
      '<label>Address<input name="address" maxlength="240" value="'+escape(s?.address)+'"></label>','shops',d=>({...d,id}));
  }
  if (name==='lease') {
    const options=ledger.shops.filter(s=>!ledger.leases.some(l=>l.shop_id===s.id&&!l.end_month));
    dialog('Add Tenancy','<label>Shop<select name="shop_id" required><option value="">Choose a shop</option>'+
      options.map(s=>'<option value="'+s.id+'">'+escape(s.code)+'</option>').join('')+'</select></label>'+
      '<label>Tenant name<input name="tenant" maxlength="120" required></label><label>Phone<input name="phone" type="tel" maxlength="32"></label>'+
      '<label>Monthly rent (₹)<input type="number" name="rent" min=".01" step=".01" required></label>'+
      '<label>First billable month<input type="month" name="start_month" value="'+month+'" required></label>','leases',d=>({...d,rent:minor(d.rent)}));
  }
  if (name==='end') {
    dialog('End Tenancy','<label>Last billable month<input type="month" name="end_month" min="'+lease(id).start_month+
      '" value="'+ledger.today.slice(0,7)+'" required></label>','end-lease',d=>({...d,id}),'End Tenancy');
  }
  if (name==='payment') {
    const balance=rentRows(month).find(r=>r.l.id===id).balance/100;
    const paymentId=crypto.randomUUID();
    dialog('Collect Rent','<p>'+escape(shop(lease(id).shop_id).code)+' · '+escape(lease(id).tenant)+' · '+month+'</p>'+
      '<label>Amount (₹)<input type="number" step=".01" min=".01" max="'+balance+'" value="'+balance+'" name="amount" required></label>'+
      '<label>Payment date<input type="date" name="paid_on" value="'+ledger.today+'" max="'+ledger.today+'" required></label>'+
      '<label>Method<select name="method"><option>Cash</option><option>UPI</option><option>Bank Transfer</option><option>Cheque</option></select></label>',
      'payments',d=>({...d,id:paymentId,lease_id:id,month,amount:minor(d.amount)}),'Save Payment');
  }
  if (name==='print') {
    const p=ledger.payments.find(item=>item.id===id);
    const l=lease(p.lease_id);
    document.querySelector('#print').innerHTML='<h1>Rent Receipt</h1><p>Masscom Infotech Solutions</p><p>Receipt ID '+escape(p.id)+
      '</p><hr><p>Shop '+escape(shop(l.shop_id).code)+'</p><p>Received from '+escape(l.tenant)+'</p><p>Rent month '+escape(p.month)+
      '</p><p>Paid on '+escape(p.paid_on)+'</p><p>Payment method '+escape(p.method)+'</p><h2>'+money(p.amount)+'</h2><p>Authorized signature ____________________</p>';
    window.print();
  }
});
logout.onclick=async ()=>{
  logout.disabled=true;
  try { await api('logout',{}); }
  catch (error) { if(error.status!==401){window.alert(error.message);return;} }
  finally {logout.disabled=false;}
  ledger=null;
  month=null;
  location.hash='dashboard';
  render();
};
window.addEventListener('hashchange',()=>{if(ledger)render();});
load();
