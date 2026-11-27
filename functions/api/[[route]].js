const sessionCookie = 'shop_session';
const day = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata'}).format(new Date());
const monthValid = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const dateValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;

function send(body, status = 200, cookie) {
  const headers = {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'};
  if (cookie !== undefined) headers['Set-Cookie'] = sessionCookie + '=' + cookie +
    '; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + (cookie ? 28800 : 0);
  return Response.json(body, {status, headers});
}
async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
const hex = bytes => Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
function randomHex(size) {
  const bytes=new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}
async function passwordHash(password,saltHex) {
  const salt=Uint8Array.from(saltHex.match(/.{2}/g)||[],part=>parseInt(part,16));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},key,256);
  return hex(new Uint8Array(bits));
}
function constantTimeTextEqual(a,b) {
  if (typeof a!=='string' || typeof b!=='string') return false;
  let difference=a.length^b.length;
  for (let i=0;i<Math.max(a.length,b.length);i++) difference|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);
  return difference===0;
}
async function ensureAuthTables(db,initialPassword) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS login_attempts (client TEXT PRIMARY KEY, expires INTEGER NOT NULL, attempts INTEGER NOT NULL)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_credentials (
      id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_password_resets (
      token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, used_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS password_reset_requests (
      client TEXT PRIMARY KEY, window_started INTEGER NOT NULL, attempts INTEGER NOT NULL
    )`)
  ]);
  if (await db.prepare('SELECT id FROM admin_credentials WHERE id=1').first()) return;
  if (typeof initialPassword!=='string' || initialPassword.length<8 || initialPassword.length>20) {
    throw new Error('Cloudflare का ADMIN_PASSWORD secret सेट करें।');
  }
  const salt=randomHex(16);
  const hash=await passwordHash(initialPassword,salt);
  await db.prepare('INSERT OR IGNORE INTO admin_credentials (id,salt,password_hash) VALUES (1,?,?)').bind(salt,hash).run();
}
function text(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0,max) : '';
}
const validAmount = amount => Number.isSafeInteger(amount) && amount > 0 && amount <= 10000000000;

async function verifyPassword(db,request,password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 20) {
    return send({error:'8 से 20 अक्षरों का पासवर्ड डालें।'},400);
  }
  await db.prepare('CREATE TABLE IF NOT EXISTS login_attempts (client TEXT PRIMARY KEY, expires INTEGER NOT NULL, attempts INTEGER NOT NULL)').run();
  const client = request.headers.get('CF-Connecting-IP') || 'unknown';
  const time = Date.now();
  const attempt = await db.prepare(`INSERT INTO login_attempts VALUES (?, ?, 1)
    ON CONFLICT(client) DO UPDATE SET
    attempts=CASE WHEN expires<=? THEN 1 ELSE attempts+1 END,
    expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END
    WHERE expires<=? OR attempts<10
    RETURNING attempts`).bind(client,time+900000,time,time,time).first();
  if (!attempt) return send({error:'बहुत ज़्यादा कोशिशें हुई हैं। 15 मिनट बाद फिर कोशिश करें।'},429);
  const credential=await db.prepare('SELECT salt,password_hash FROM admin_credentials WHERE id=1').first();
  const candidate=credential ? await passwordHash(password,credential.salt) : '';
  if (!credential || !constantTimeTextEqual(candidate,credential.password_hash)) {
    return send({error:'पासवर्ड गलत है।'},401);
  }
  await db.prepare('DELETE FROM login_attempts WHERE client=? OR expires<=?').bind(client,time).run();
  return null;
}


// D1 applies the table replacement and all index changes in one transaction.
async function ensureZeroRent(db) {
  const allowsZero = async () => {
    const table = await db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='leases'").first();
    return /CHECK\s*\(\s*rent\s*>=\s*0\s*\)/i.test(table?.sql || '');
  };
  if (await allowsZero()) return;
  try {
    await db.batch([
      `CREATE TABLE leases_zero_rent (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL REFERENCES shops(id),
      tenant TEXT NOT NULL,
      phone TEXT NOT NULL,
      rent INTEGER NOT NULL CHECK(rent >= 0),
      start_month TEXT NOT NULL,
      end_month TEXT CHECK(end_month >= start_month),
      tenant_id TEXT REFERENCES tenants(id),
      opening INTEGER NOT NULL DEFAULT 0 CHECK(opening >= 0),
      deposit INTEGER NOT NULL DEFAULT 0 CHECK(deposit >= 0),
      deposit_returned_on TEXT,
      deposit_receipt_number TEXT,
      deposit_paid_on TEXT
    )`,
      `CREATE TABLE payments_zero_rent (
      id TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL REFERENCES leases_zero_rent(id),
      month TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      method TEXT NOT NULL CHECK(method IN ('Cash','UPI','Bank Transfer','Cheque')),
      paid_on TEXT NOT NULL,
      transaction_id TEXT,
      receipt_group TEXT,
      receipt_number TEXT
    )`,
      `INSERT INTO leases_zero_rent SELECT id,shop_id,tenant,phone,rent,start_month,end_month,tenant_id,opening,deposit,deposit_returned_on,deposit_receipt_number,deposit_paid_on FROM leases`,
      `INSERT INTO payments_zero_rent SELECT id,lease_id,month,amount,method,paid_on,transaction_id,receipt_group,receipt_number FROM payments ORDER BY rowid`,
      `DROP TABLE payments`,
      `DROP TABLE leases`,
      `ALTER TABLE leases_zero_rent RENAME TO leases`,
      `ALTER TABLE payments_zero_rent RENAME TO payments`,
      `CREATE UNIQUE INDEX one_current_lease ON leases(shop_id) WHERE end_month IS NULL`,
      `CREATE INDEX leases_tenant ON leases(tenant_id)`,
      `CREATE INDEX payment_month ON payments(lease_id,month)`,
      `CREATE UNIQUE INDEX payments_receipt_number_unique ON payments(receipt_number COLLATE NOCASE) WHERE receipt_number IS NOT NULL`
    ].map(statement=>db.prepare(statement)));
  } catch (error) {
    if (!await allowsZero()) throw error;
  }
}

const tenantPhone = value => /^[0-9]{5}-?[0-9]{5}$/.test(value) ? value.replace('-','') : '';
const tenantNumber = value => /^(?:[0-9]{12}|[0-9]{4}-[0-9]{4}-[0-9]{4})$/.test(value) ? value.replaceAll('-','') : '';
const missingPhone = '0000000000';
const missingNumber = '000000000000';
const duplicateTenant = 'यह मोबाइल नंबर या किरायेदार आईडी पहले से दर्ज है।';

export async function onRequest({request,env}) {
  const url = new URL(request.url);
  const route = url.pathname.slice(5);
  const method = request.method;
  const db = env.SHOP_DB;
  if (!db) return send({error:'Cloudflare का D1 सेटअप अभी बाकी है।'},503);
  if (method !== 'GET' && (method !== 'POST' || request.headers.get('Origin') !== url.origin)) {
    return send({error:'यह अनुरोध स्वीकार नहीं किया गया।'},403);
  }
  try {
    await ensureAuthTables(db,env.ADMIN_PASSWORD);
    let data = {};
    if (method === 'POST') {
      try { data = await request.json(); } catch { return send({error:'अनुरोध अमान्य है।'},400); }
      if (!data || typeof data !== 'object') return send({error:'Invalid request.'},400);
    }
    if (method === 'POST' && route === 'forgot-password') {
      const now=Date.now();
      const client=request.headers.get('CF-Connecting-IP')||'unknown';
      const allowed=await db.prepare(`INSERT INTO password_reset_requests (client,window_started,attempts)
        VALUES (?,?,1) ON CONFLICT(client) DO UPDATE SET
        attempts=CASE WHEN window_started<=? THEN 1 ELSE attempts+1 END,
        window_started=CASE WHEN window_started<=? THEN excluded.window_started ELSE window_started END
        WHERE window_started<=? OR attempts<3 RETURNING attempts`)
        .bind(client,now,now-3600000,now-3600000,now-3600000).first();
      if (!allowed) return send({error:'कई बार अनुरोध हुआ है। एक घंटे बाद फिर कोशिश करें।'},429);
      const accountId=text(env.CF_ACCOUNT_ID,64);
      const apiToken=env.CF_EMAIL_API_TOKEN;
      const sender=text(env.ADMIN_EMAIL_FROM,160);
      if (!/^[a-f0-9]{32}$/i.test(accountId) || typeof apiToken!=='string' || apiToken.length<20 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
        return send({error:'पासवर्ड रीसेट ईमेल सेवा अभी सेटअप नहीं है।'},503);
      }
      const token=randomHex(32);
      const tokenHash=hex(await digest(token));
      let base;
      try { base=new URL(env.APP_BASE_URL||'https://shop.masscom.co.in'); }
      catch { return send({error:'पासवर्ड रीसेट लिंक सेटअप जाँचें।'},503); }
      if (base.protocol!=='https:') return send({error:'पासवर्ड रीसेट लिंक सेटअप जाँचें।'},503);
      const resetUrl=new URL('/#reset-password/'+token,base.origin).toString();
      await db.batch([
        db.prepare('DELETE FROM admin_password_resets'),
        db.prepare('INSERT INTO admin_password_resets (token_hash,expires,created_at) VALUES (?,?,?)').bind(tokenHash,now+1800000,now)
      ]);
      try {
        const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+accountId+'/email/sending/send',{
          method:'POST',headers:{'Authorization':'Bearer '+apiToken,'Content-Type':'application/json'},
          body:JSON.stringify({to:'info@masscom.co.in',from:sender,subject:'दुकान किराया प्रबंधन पासवर्ड रीसेट',
            text:'आपके पासवर्ड रीसेट का अनुरोध मिला है। नया पासवर्ड सेट करने के लिए यह लिंक 30 मिनट के भीतर खोलें: '+resetUrl+'\n\nयदि आपने अनुरोध नहीं किया, तो इस ईमेल को अनदेखा करें।',
            html:'<p>आपके पासवर्ड रीसेट का अनुरोध मिला है।</p><p><a href="'+resetUrl+'">नया पासवर्ड सेट करें</a></p><p>यह लिंक 30 मिनट बाद समाप्त हो जाएगा और एक ही बार इस्तेमाल किया जा सकता है। यदि आपने अनुरोध नहीं किया, तो इस ईमेल को अनदेखा करें।</p>'})
        });
        const result=await response.json().catch(()=>({}));
        if (!response.ok || result.success!==true) throw new Error('Email service rejected the reset request.');
      } catch (error) {
        await db.prepare('DELETE FROM admin_password_resets WHERE token_hash=?').bind(tokenHash).run();
        console.error('Password reset email failed',error.name);
        return send({error:'रीसेट ईमेल भेजा नहीं जा सका। ईमेल सेवा सेटअप जाँचकर फिर कोशिश करें।'},502);
      }
      return send({ok:true});
    }
    if (method === 'POST' && route === 'reset-password') {
      const token=typeof data.token==='string' && /^[a-f0-9]{64}$/.test(data.token) ? data.token : '';
      const password=data.password;
      if (typeof password!=='string' || password.length<8 || password.length>20) return send({error:'नया पासवर्ड 8 से 20 अक्षरों का रखें।'},400);
      if (!token) return send({error:'यह रीसेट लिंक अमान्य या समाप्त हो गया है। नया लिंक मँगाएँ।'},400);
      const tokenHash=hex(await digest(token));
      const now=Date.now();
      const valid=await db.prepare(`SELECT token_hash FROM admin_password_resets
        WHERE token_hash=? AND expires>? AND used_at IS NULL AND attempts<5`).bind(tokenHash,now).first();
      if (!valid) return send({error:'यह रीसेट लिंक अमान्य या समाप्त हो गया है। नया लिंक मँगाएँ।'},400);
      const salt=randomHex(16);
      const hash=await passwordHash(password,salt);
      const [updated]=await db.batch([
        db.prepare(`UPDATE admin_credentials SET salt=?,password_hash=?,updated_at=CURRENT_TIMESTAMP
          WHERE id=1 AND EXISTS (SELECT 1 FROM admin_password_resets WHERE token_hash=? AND expires>? AND used_at IS NULL AND attempts<5)`)
          .bind(salt,hash,tokenHash,now),
        db.prepare(`UPDATE admin_password_resets SET used_at=?,attempts=attempts+1
          WHERE token_hash=? AND expires>? AND used_at IS NULL AND attempts<5`).bind(now,tokenHash,now),
        db.prepare('DELETE FROM sessions'),
        db.prepare('DELETE FROM login_attempts')
      ]);
      if (!updated.meta.changes) return send({error:'यह रीसेट लिंक इस्तेमाल हो चुका है। नया लिंक मँगाएँ।'},400);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'login') {
      const failure = await verifyPassword(db,request,data.password);
      if (failure) return failure;
      const id = crypto.randomUUID();
      const now = Date.now();
      await db.batch([
        db.prepare('DELETE FROM sessions WHERE expires <= ?').bind(now),
        db.prepare('INSERT INTO sessions VALUES (?, ?)').bind(id,now + 28800000)
      ]);
      return send({ok:true},200,id);
    }
    const id = request.headers.get('Cookie')?.match(/(?:^|; )shop_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
    if (!id || !await db.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').bind(id,Date.now()).first()) {
      return send({error:'कृपया लॉगिन करें।'},401);
    }
    if (method === 'POST' && route === 'logout') {
      await db.prepare('DELETE FROM sessions WHERE id=?').bind(id).run();
      return send({ok:true},200,'');
    }
    if (['ledger','markets','archive-market','shops','archive-shop','edit-allocation','leases'].includes(route)) {
      await db.prepare('CREATE TABLE IF NOT EXISTS archived_markets (market_id TEXT PRIMARY KEY REFERENCES markets(id))').run();
      await db.prepare('CREATE TABLE IF NOT EXISTS archived_shops (shop_id TEXT PRIMARY KEY REFERENCES shops(id))').run();
    }
    if (['ledger','tenants','tenant-status','archive-tenant'].includes(route)) {
      await db.prepare('CREATE TABLE IF NOT EXISTS archived_tenants (tenant_id TEXT PRIMARY KEY REFERENCES tenants(id))').run();
    }
    if (route === 'ledger' || route === 'shops') {
      await db.prepare('CREATE TABLE IF NOT EXISTS archived_shop_codes (shop_id TEXT PRIMARY KEY REFERENCES shops(id), code TEXT NOT NULL)').run();
    }
    if (route === 'ledger' || route === 'return-deposit' || route === 'deposit-return-file') {
      await db.prepare(`CREATE TABLE IF NOT EXISTS deposit_returns (
        lease_id TEXT PRIMARY KEY REFERENCES leases(id), returned_on TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', attachment_data TEXT, attachment_name TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`).run();
    }
    if (method === 'GET' && route === 'ledger') {
      const [shops, leases, payments, markets, tenants, depositReturns] = await db.batch([
        db.prepare('SELECT shops.*, archived_shop_codes.code AS original_code, (archived_shops.shop_id IS NOT NULL OR archived_markets.market_id IS NOT NULL) AS is_archived FROM shops LEFT JOIN archived_shops ON archived_shops.shop_id=shops.id LEFT JOIN archived_markets ON archived_markets.market_id=shops.market_id LEFT JOIN archived_shop_codes ON archived_shop_codes.shop_id=shops.id ORDER BY COALESCE(archived_shop_codes.code,shops.code) COLLATE NOCASE'),
        db.prepare('SELECT * FROM leases ORDER BY start_month DESC'),
        db.prepare('SELECT * FROM payments ORDER BY paid_on DESC, rowid DESC'),
        db.prepare('SELECT markets.*, archived_markets.market_id IS NOT NULL AS is_archived FROM markets LEFT JOIN archived_markets ON archived_markets.market_id=markets.id ORDER BY markets.rowid'),
        db.prepare('SELECT id,name,father_name,phone,address,business,tenant_id_number,photo IS NOT NULL AS has_photo,is_active, archived_tenants.tenant_id IS NOT NULL AS is_archived FROM tenants LEFT JOIN archived_tenants ON archived_tenants.tenant_id=tenants.id ORDER BY name COLLATE NOCASE'),
        db.prepare('SELECT lease_id,returned_on,description,attachment_name,created_at FROM deposit_returns')
      ]);
      return send({shops:shops.results.map(({original_code,...shop})=>({...shop,code:original_code ?? shop.code})), leases:leases.results, payments:payments.results, markets:markets.results, tenants:tenants.results, deposit_returns:depositReturns.results, today:day()});
    }
    if (method === 'GET' && route === 'deposit-return-file') {
      const row = await db.prepare('SELECT attachment_data,attachment_name FROM deposit_returns WHERE lease_id=?').bind(url.searchParams.get('id')||'').first();
      if (!row?.attachment_data) return send({error:'वापसी की रसीद नहीं मिली।'},404);
      const match=row.attachment_data.match(/^data:([^;]+);base64,(.*)$/);
      if (!match) return send({error:'वापसी की रसीद नहीं खुली।'},500);
      const bytes=Uint8Array.from(atob(match[2]),character=>character.charCodeAt(0));
      const safeName=String(row.attachment_name||'receipt').replace(/[\r\n"\\]/g,'_');
      return new Response(bytes,{headers:{'Content-Type':match[1],'Content-Disposition':'inline; filename="'+safeName+'"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if (method === 'POST' && route === 'verify-admin') {
      const failure = await verifyPassword(db,request,data.password);
      if (failure) return failure;
      return send({ok:true});
    }
    if (method === 'POST' && route === 'send-rent-reminder') {
      const asOf=text(data.as_of,7);
      if (!monthValid(asOf) || asOf>day().slice(0,7) || !['tenant','lease'].includes(data.kind) ||
          typeof data.id!=='string' || !/^[a-f0-9-]{36}$/i.test(data.id)) {
        return send({error:'किरायेदार और बकाया स्थिति माह दोबारा चुनें।'},400);
      }
      const accessToken=env.WHATSAPP_ACCESS_TOKEN;
      const phoneNumberId=text(env.WHATSAPP_PHONE_NUMBER_ID,64);
      const templateName=text(env.WHATSAPP_TEMPLATE_NAME || 'rent_reminder_hi',512);
      const templateLanguage=text(env.WHATSAPP_TEMPLATE_LANGUAGE || 'hi',32);
      const graphVersion=text(env.WHATSAPP_GRAPH_API_VERSION || 'v27.0',12);
      if (typeof accessToken!=='string' || accessToken.length<20 || !/^\d{5,30}$/.test(phoneNumberId) ||
          !/^[a-z0-9_]{1,512}$/.test(templateName) || !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(templateLanguage) ||
          !/^v\d+\.\d+$/.test(graphVersion)) {
        return send({error:'WhatsApp संदेश सेवा अभी कनेक्ट नहीं है। Cloudflare में WhatsApp API secrets सेट करने के बाद फिर कोशिश करें।'},503);
      }
      let targetTenant=null;
      let leases=[];
      if (data.kind==='tenant') {
        targetTenant=await db.prepare('SELECT id,name,phone FROM tenants WHERE id=?').bind(data.id).first();
        if (targetTenant) leases=(await db.prepare(`SELECT leases.*,shops.code AS shop_code,markets.name AS market_name
          FROM leases JOIN shops ON shops.id=leases.shop_id LEFT JOIN markets ON markets.id=shops.market_id
          WHERE leases.tenant_id=? AND leases.start_month<=?`).bind(data.id,asOf).all()).results;
      } else {
        const anchor=await db.prepare('SELECT tenant_id FROM leases WHERE id=?').bind(data.id).first();
        if (anchor?.tenant_id) {
          targetTenant=await db.prepare('SELECT id,name,phone FROM tenants WHERE id=?').bind(anchor.tenant_id).first();
          if (targetTenant) leases=(await db.prepare(`SELECT leases.*,shops.code AS shop_code,markets.name AS market_name
            FROM leases JOIN shops ON shops.id=leases.shop_id LEFT JOIN markets ON markets.id=shops.market_id
            WHERE leases.tenant_id=? AND leases.start_month<=?`).bind(anchor.tenant_id,asOf).all()).results;
        } else {
          const row=await db.prepare(`SELECT leases.*,shops.code AS shop_code,markets.name AS market_name
            FROM leases JOIN shops ON shops.id=leases.shop_id LEFT JOIN markets ON markets.id=shops.market_id
            WHERE leases.id=? AND leases.start_month<=?`).bind(data.id,asOf).first();
          if (row) {
            leases=[row];
            targetTenant={id:null,name:row.tenant,phone:row.phone};
          }
        }
      }
      if (!targetTenant || !leases.length) return send({error:'इस किरायेदार के लिए बकाया रिकॉर्ड नहीं मिला।'},404);
      const phone=String(targetTenant.phone||'').replace(/\D/g,'');
      if (!/^\d{10}$/.test(phone) || /^0{10}$/.test(phone)) return send({error:'किरायेदार का सही 10 अंकों का मोबाइल नंबर दर्ज करें।'},400);
      const duePeriods=new Map();
      const dueShops=[];
      for (const lease of leases) {
        const payments=(await db.prepare('SELECT month,SUM(amount) AS amount FROM payments WHERE lease_id=? GROUP BY month').bind(lease.id).all()).results;
        const paid=new Map(payments.map(payment=>[payment.month,Number(payment.amount)||0]));
        let shopDue=Math.max(0,Number(lease.opening||0)-(paid.get('opening')||0));
        if (shopDue) duePeriods.set('opening',(duePeriods.get('opening')||0)+shopDue);
        const last=lease.end_month && lease.end_month<asOf ? lease.end_month : asOf;
        const cursor=new Date(lease.start_month+'-01T00:00:00Z');
        for (let period=lease.start_month;period<=last;period=cursor.toISOString().slice(0,7)) {
          const balance=Math.max(0,Number(lease.rent)-(paid.get(period)||0));
          if (balance) {
            duePeriods.set(period,(duePeriods.get(period)||0)+balance);
            shopDue+=balance;
          }
          cursor.setUTCMonth(cursor.getUTCMonth()+1);
        }
        if (shopDue) {
          const code=String(lease.shop_code||'');
          const prefix=code.includes('-')?code.slice(0,code.lastIndexOf('-')):'';
          const shopNo=prefix?code.slice(prefix.length+1):code;
          dueShops.push((lease.market_name||'बिना मार्केट')+' — दुकान नं. '+shopNo+': '+
            (shopDue/100).toLocaleString('hi-IN',{maximumFractionDigits:2,minimumFractionDigits:0}));
        }
      }
      const total=[...duePeriods.values()].reduce((sum,value)=>sum+value,0);
      if (!total) return send({error:'इस किरायेदार का चुने गए माह तक कोई बकाया नहीं है।'},409);
      const months=[...duePeriods.keys()].filter(value=>value!=='opening').sort();
      const monthLabel=value=>new Intl.DateTimeFormat('hi-IN',{timeZone:'UTC',month:'long',year:'numeric'}).format(new Date(value+'-01T00:00:00Z'));
      const range=months.length>1 ? monthLabel(months[0])+' से '+monthLabel(months[months.length-1]) :
        months.length===1 ? monthLabel(months[0]) : '';
      const periodLabel=(duePeriods.has('opening')?'शुरुआती बकाया':'')+
        (duePeriods.has('opening')&&range?' एवं ':'')+range;
      const periodCount=months.length+(duePeriods.has('opening')?1:0);
      const shopList=dueShops.join('; ').slice(0,700);
      const parameters=[targetTenant.name,shopList,
        (total/100).toLocaleString('hi-IN',{maximumFractionDigits:2,minimumFractionDigits:0}),periodLabel,String(periodCount)];
      const response=await fetch('https://graph.facebook.com/'+graphVersion+'/'+phoneNumberId+'/messages',{
        method:'POST',headers:{'Authorization':'Bearer '+accessToken,'Content-Type':'application/json'},
        body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:'91'+phone,
          type:'template',template:{name:templateName,language:{code:templateLanguage},components:[{
            type:'body',parameters:parameters.map(value=>({type:'text',text:String(value)}))
          }]}})
      });
      const result=await response.json().catch(()=>({}));
      if (!response.ok || result.error || !result.messages?.[0]?.id) {
        console.error('WhatsApp rent reminder rejected',response.status,result.error?.code||'unknown');
        return send({error:'WhatsApp संदेश नहीं भेजा गया। नंबर, template approval और API access token जाँचें।'},502);
      }
      return send({ok:true,message_id:result.messages[0].id});
    }
    if (method === 'POST' && route === 'markets') {
      const name = text(data.name,120).normalize('NFC');
      const marketId = text(data.id);
      if (marketId) {
        if (!name) return send({error:'मार्केट का नाम दर्ज करें।'},400);
        const result = await db.prepare(`UPDATE markets SET name=? WHERE id=?
          AND NOT EXISTS (SELECT 1 FROM archived_markets WHERE market_id=markets.id)
          AND NOT EXISTS (SELECT 1 FROM markets AS other WHERE other.id<>markets.id AND other.name=? COLLATE NOCASE)`)
          .bind(name,marketId,name).run();
        if (!result.meta.changes) return send({error:'मार्केट उपलब्ध नहीं है या यह नाम पहले से दर्ज है।'},409);
        return send({ok:true});
      }
      const prefix = text(data.prefix,12).toUpperCase();
      if (!name || !/^[A-Z0-9]{1,12}$/.test(prefix)) {
        return send({error:'मार्केट का नाम और अंग्रेज़ी अक्षरों या अंकों में कोड दर्ज करें।'},400);
      }
      const result = await db.prepare(`INSERT INTO markets (id,name,prefix)
        SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM markets WHERE name=? COLLATE NOCASE)
        ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(),name,prefix,name).run();
      if (!result.meta.changes) return send({error:'यह मार्केट नाम या कोड पहले से दर्ज है।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'archive-market') {
      const result = await db.prepare(`INSERT INTO archived_markets (market_id)
        SELECT markets.id FROM markets WHERE markets.id=?
          AND NOT EXISTS (
            SELECT 1 FROM shops WHERE shops.market_id=markets.id
              AND (shops.is_blocked=1 OR EXISTS (
                SELECT 1 FROM leases WHERE leases.shop_id=shops.id AND (end_month IS NULL OR end_month>=?)
              ))
          )
        ON CONFLICT DO NOTHING`).bind(text(data.id),day().slice(0,7)).run();
      if (!result.meta.changes) return send({error:'मार्केट हटाने के लिए उसकी सभी दुकानें खाली होनी चाहिए।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'archive-shop') {
      const result = await db.prepare(`INSERT INTO archived_shops (shop_id)
        SELECT shops.id FROM shops WHERE shops.id=? AND shops.is_blocked=0
          AND NOT EXISTS (SELECT 1 FROM leases WHERE leases.shop_id=shops.id AND (end_month IS NULL OR end_month>=?))
        ON CONFLICT DO NOTHING`).bind(text(data.id),day().slice(0,7)).run();
      if (!result.meta.changes) return send({error:'सिर्फ खाली और बिना आगामी आवंटन वाली दुकान हटाई जा सकती है।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'shops') {
      const number = text(data.code,40);
      const selectedMarket = data.market_id
        ? await db.prepare('SELECT * FROM markets WHERE id=? AND NOT EXISTS (SELECT 1 FROM archived_markets WHERE market_id=markets.id)').bind(data.market_id).first()
        : null;
      if (data.market_id && !selectedMarket) return send({error:'सही मार्केट चुनें।'},400);
      const code = selectedMarket && number ? selectedMarket.prefix+'-'+number : number;
      if (!code) return send({error:'दुकान का नंबर या नाम दर्ज करें।'},400);
      if (data.id) {
        const blocked = data.is_blocked==='1' ? 1 : 0;
        if (blocked) {
          const current = await db.prepare('SELECT 1 FROM leases WHERE shop_id=? AND (end_month IS NULL OR end_month>=?) LIMIT 1')
            .bind(text(data.id),day().slice(0,7)).first();
          if (current) return send({error:'किरायेदारी पूरी होने तक इस दुकान को ब्लॉक नहीं किया जा सकता।'},409);
        }
        const result = await db.prepare('UPDATE shops SET code=?, address=?, market_id=?, is_blocked=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM archived_shops WHERE shop_id=shops.id) AND NOT EXISTS (SELECT 1 FROM archived_markets WHERE market_id IN (shops.market_id,?))')
          .bind(code,text(data.address,240),selectedMarket?.id ?? null,blocked,text(data.id),selectedMarket?.id ?? null).run();
        if (!result.meta.changes) return send({error:'दुकान नहीं मिली।'},404);
      } else {
        const marketId = selectedMarket?.id ?? null;
        // Keep the old shop ID and printed number while freeing the unique catalog code.
        const [, , result] = await db.batch([
          db.prepare(`INSERT INTO archived_shop_codes (shop_id,code)
            SELECT shops.id,shops.code FROM shops WHERE shops.code=?
              AND (EXISTS (SELECT 1 FROM archived_shops WHERE shop_id=shops.id)
                OR EXISTS (SELECT 1 FROM archived_markets WHERE market_id=shops.market_id))
            ON CONFLICT DO NOTHING`).bind(code),
          db.prepare(`UPDATE shops SET code=? || id WHERE code=?
            AND EXISTS (SELECT 1 FROM archived_shop_codes WHERE shop_id=shops.id)`)
            .bind('~'.repeat(64),code),
          db.prepare('INSERT INTO shops (id,code,address,market_id) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM archived_markets WHERE market_id=?)')
            .bind(crypto.randomUUID(),code,text(data.address,240),marketId,marketId)
        ]);
        if (!result.meta.changes) return send({error:'यह मार्केट अब उपलब्ध नहीं है।'},409);
      }
      return send({ok:true});
    }
    if (method === 'GET' && route === 'tenant-photo') {
      const row = await db.prepare('SELECT photo FROM tenants WHERE id=?').bind(url.searchParams.get('id') || '').first();
      if (!row?.photo) return send({error:'फ़ोटो उपलब्ध नहीं है।'},404);
      return new Response(Uint8Array.from(atob(row.photo),c=>c.charCodeAt(0)),{
        headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}
      });
    }
    if (method === 'POST' && route === 'import-tenants') {
      const rows = data.rows;
      if (!Array.isArray(rows) || !rows.length || rows.length>500) return send({error:'फ़ाइल में 1 से 500 किरायेदार रखें।'},400);
      const tenants = [];
      const ids = new Set();
      const phones = new Set();
      for (const row of rows) {
        const name = text(row?.name);
        const phone = tenantPhone(text(row?.phone,32));
        const idNumber = tenantNumber(text(row?.tenant_id_number,32));
        if (!name || !phone || !idNumber) {
          return send({error:'पंक्ति '+Number(row?.line)+' में नाम, 10 अंकों का मोबाइल और 12 अंकों की आईडी जाँचें।'},400);
        }
        if (ids.has(idNumber) || phones.has(phone)) return send({error:'पंक्ति '+Number(row.line)+' में मोबाइल नंबर या आईडी दोबारा दर्ज है।'},409);
        if (idNumber!==missingNumber) ids.add(idNumber);
        if (phone!==missingPhone) phones.add(phone);
        tenants.push({id:crypto.randomUUID(),name,phone,idNumber,address:text(row.address,240),business:text(row.business,120),fatherName:text(row.father_name)});
      }
      const result = await db.prepare(`WITH imported AS (
        SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.name') AS name,json_extract(value,'$.phone') AS phone,
          json_extract(value,'$.idNumber') AS id_number,json_extract(value,'$.address') AS address,json_extract(value,'$.business') AS business,
          json_extract(value,'$.fatherName') AS father_name
        FROM json_each(?)
      ) INSERT INTO tenants (id,name,phone,tenant_id_number,address,business,father_name)
      SELECT id,name,phone,id_number,address,business,father_name FROM imported
      WHERE NOT EXISTS (SELECT 1 FROM imported JOIN tenants ON
        (imported.id_number<>? AND replace(tenants.tenant_id_number,'-','')=imported.id_number) OR
        (imported.phone<>? AND replace(tenants.phone,'-','')=imported.phone))`)
        .bind(JSON.stringify(tenants),missingNumber,missingPhone).run();
      if (!result.meta.changes) return send({error:'फ़ाइल में कोई मोबाइल नंबर या आईडी पहले से ऐप में दर्ज है।'},409);
      return send({ok:true,count:result.meta.changes});
    }
    if (method === 'POST' && route === 'tenants') {
      const name = text(data.name);
      if (!name) return send({error:'किरायेदार का नाम दर्ज करें।'},400);
      const phone = tenantPhone(text(data.phone,32));
      const tenantIdNumber = tenantNumber(text(data.tenant_id_number,32));
      if (!phone) return send({error:'10 अंकों का मोबाइल नंबर दर्ज करें।'},400);
      if (!tenantIdNumber) return send({error:'12 अंकों का किरायेदार आईडी नंबर दर्ज करें।'},400);
      const photo = data.photo;
      if (photo != null && (typeof photo !== 'string' || photo.length>240000 ||
          !/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(photo) || photo.length%4!==0)) {
        return send({error:'सही फ़ोटो चुनें।'},400);
      }
      const address = text(data.address,240);
      const business = text(data.business,120);
      const fatherName = text(data.father_name);
      const tenantId = text(data.id);
      const conflict = `SELECT 1 FROM tenants WHERE id<>? AND
        ((?<>? AND replace(phone,'-','')=?) OR (?<>? AND replace(tenant_id_number,'-','')=?))`;
      const match = [tenantId,phone,missingPhone,phone,tenantIdNumber,missingNumber,tenantIdNumber];
      const result = tenantId
        ? await db.prepare(`UPDATE tenants SET name=?,phone=?,address=?,business=?,tenant_id_number=?,father_name=?,photo=COALESCE(?,photo)
            WHERE id=? AND NOT EXISTS (SELECT 1 FROM archived_tenants WHERE tenant_id=tenants.id) AND NOT EXISTS (${conflict})`)
          .bind(name,phone,address,business,tenantIdNumber,fatherName,photo ?? null,tenantId,...match).run()
        : await db.prepare(`INSERT INTO tenants (id,name,phone,address,business,tenant_id_number,father_name,photo)
            SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (${conflict})`)
          .bind(crypto.randomUUID(),name,phone,address,business,tenantIdNumber,fatherName,photo ?? null,...match).run();
      if (!result.meta.changes) return send({error:duplicateTenant},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'archive-tenant') {
      const result = await db.prepare(`INSERT INTO archived_tenants (tenant_id)
        SELECT tenants.id FROM tenants WHERE tenants.id=? AND tenants.is_active=0
          AND NOT EXISTS (SELECT 1 FROM leases WHERE leases.tenant_id=tenants.id AND (end_month IS NULL OR end_month>=?))
        ON CONFLICT DO NOTHING`).bind(text(data.id),day().slice(0,7)).run();
      if (!result.meta.changes) return send({error:'सिर्फ निष्क्रिय किरायेदार हटाया जा सकता है जिसकी चालू या आगामी किरायेदारी बाकी न हो।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'tenant-status') {
      const tenantId=text(data.id);
      const active=data.is_active===1 || data.is_active==='1' ? 1 :
        data.is_active===0 || data.is_active==='0' ? 0 : null;
      if (!tenantId || active===null) return send({error:'किरायेदार की स्थिति सही चुनें।'},400);
      const tenant=await db.prepare('SELECT id FROM tenants WHERE id=?').bind(tenantId).first();
      if (!tenant) return send({error:'किरायेदार नहीं मिला।'},404);
      if (!active) {
        const openLease=await db.prepare('SELECT 1 FROM leases WHERE tenant_id=? AND (end_month IS NULL OR end_month>=?) LIMIT 1')
          .bind(tenantId,day().slice(0,7)).first();
        if (openLease) return send({error:'पहले इस किरायेदार की सभी चालू और आगे की किरायेदारियाँ समाप्त करें।'},409);
      }
      const result = await db.prepare(`UPDATE tenants SET is_active=? WHERE id=?
        AND NOT EXISTS (SELECT 1 FROM archived_tenants WHERE tenant_id=tenants.id)
        AND (?=1 OR NOT EXISTS (
          SELECT 1 FROM leases WHERE leases.tenant_id=tenants.id AND (end_month IS NULL OR end_month>=?)
        ))`).bind(active,tenantId,active,day().slice(0,7)).run();
      if (!result.meta.changes) return send({error:'किरायेदार की स्थिति नहीं बदली जा सकी।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'edit-allocation') {
      const {rent,opening,deposit} = data;
      const shopId = text(data.shop_id,120);
      const allocation = await db.prepare('SELECT id,shop_id,start_month,deposit,deposit_receipt_number,deposit_paid_on FROM leases WHERE id=? AND end_month IS NULL')
        .bind(text(data.id)).first();
      if (!allocation) return send({error:'यह आवंटन अब संशोधित नहीं किया जा सकता।'},409);
      if (!shopId || !(rent===0 || validAmount(rent)) || ![opening,deposit].every(n=>n===0 || validAmount(n))) {
        return send({error:'दुकान चुनें और किराया, शुरुआती बकाया व सुरक्षा राशि सही दर्ज करें।'},400);
      }
      if (shopId!==allocation.shop_id) {
        const targetShop = await db.prepare('SELECT id FROM shops WHERE id=?').bind(shopId).first();
        if (!targetShop) return send({error:'चुनी गई दुकान उपलब्ध नहीं है।'},404);
        const conflict = await db.prepare(`SELECT 1 FROM leases
          WHERE shop_id=? AND id<>? AND (end_month IS NULL OR end_month>=?) LIMIT 1`)
          .bind(shopId,allocation.id,allocation.start_month).first();
        if (conflict) return send({error:'यह दुकान किसी दूसरी किरायेदारी में आवंटित है। खाली दुकान चुनें।'},409);
      }
      const depositReceiptNumber = deposit>0
        ? allocation.deposit_receipt_number || (allocation.deposit===0 ? 'SD-'+crypto.randomUUID().toUpperCase() : null)
        : null;
      const depositPaidOn = deposit>0
        ? allocation.deposit_paid_on || (allocation.deposit===0 ? day() : null)
        : null;
      if (rent===0) await ensureZeroRent(db);
      const result = await db.prepare(`UPDATE leases SET shop_id=?, rent=?, opening=?, deposit=?, deposit_receipt_number=?, deposit_paid_on=?
        WHERE id=? AND end_month IS NULL AND (deposit_returned_on IS NULL OR deposit=?)
          AND (shop_id=? OR (EXISTS (SELECT 1 FROM shops WHERE id=? AND is_blocked=0
            AND NOT EXISTS (SELECT 1 FROM archived_markets WHERE market_id=shops.market_id))
            AND NOT EXISTS (SELECT 1 FROM archived_shops WHERE shop_id=?)
            AND NOT EXISTS (
            SELECT 1 FROM leases AS other WHERE other.shop_id=? AND other.id<>leases.id
              AND (other.end_month IS NULL OR other.end_month>=leases.start_month)
          )))
          AND NOT EXISTS (
            SELECT 1 FROM payments WHERE lease_id=leases.id GROUP BY month
            HAVING SUM(amount)>CASE WHEN month='opening' THEN ? ELSE ? END
          )`).bind(shopId,rent,opening,deposit,depositReceiptNumber,depositPaidOn,text(data.id),deposit,shopId,shopId,shopId,shopId,opening,rent).run();
      if (!result.meta.changes) return send({error:'आवंटन बंद है, दुकान उपलब्ध नहीं है, राशि दर्ज भुगतान से कम है या सुरक्षा राशि पहले ही लौटाई जा चुकी है।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'leases') {
      const tenant = await db.prepare('SELECT * FROM tenants WHERE id=?').bind(text(data.tenant_id)).first();
      const opening = data.opening ?? 0;
      const deposit = data.deposit ?? 0;
      const startMonth = data.start_month;
      if (typeof startMonth !== 'string' || !monthValid(startMonth) || startMonth < day().slice(0,7)) {
        return send({error:'किराया शुरू होने के लिए इस महीने या आगे का कोई महीना चुनें।'},400);
      }
      if (!tenant || tenant.is_active!==1 || !(data.rent===0 || validAmount(data.rent)) || ![opening,deposit].every(n=>n===0 || validAmount(n))) {
        return send({error:'किरायेदार चुनें और किराया, पिछला बकाया व सुरक्षा राशि सही दर्ज करें।'},400);
      }
      const shopIds = data.shop_ids ?? [data.shop_id];
      if (!Array.isArray(shopIds) || !shopIds.length || shopIds.length>127 ||
          shopIds.some(id=>typeof id!=='string' || !id || id.length>120) ||
          new Set(shopIds).size!==shopIds.length) return send({error:'कम से कम एक सही दुकान चुनें।'},400);
      const requested = shopIds.map(shop_id=>({id:crypto.randomUUID(),shop_id,
        deposit_receipt_number:deposit>0?'SD-'+crypto.randomUUID().toUpperCase():null}));
      if (data.rent===0) await ensureZeroRent(db);
      const result = await db.prepare(`WITH requested AS (
        SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.shop_id') AS shop_id,
          json_extract(value,'$.deposit_receipt_number') AS deposit_receipt_number FROM json_each(?)
      ), available AS (
        SELECT requested.* FROM requested JOIN shops ON shops.id=requested.shop_id
        WHERE shops.is_blocked=0
          AND NOT EXISTS (SELECT 1 FROM archived_markets WHERE market_id=shops.market_id)
          AND NOT EXISTS (SELECT 1 FROM archived_shops WHERE shop_id=shops.id)
          AND NOT EXISTS (SELECT 1 FROM leases WHERE leases.shop_id=requested.shop_id AND (end_month IS NULL OR end_month>=?))
      ) INSERT INTO leases (id,shop_id,tenant,phone,rent,start_month,tenant_id,opening,deposit,deposit_receipt_number,deposit_paid_on)
      SELECT id,shop_id,?,?,?,?,?,?,?,deposit_receipt_number,? FROM available
      WHERE (SELECT count(*) FROM available)=(SELECT count(*) FROM requested)
        AND EXISTS (SELECT 1 FROM tenants WHERE id=? AND is_active=1)`)
        .bind(JSON.stringify(requested),startMonth,tenant.name,tenant.phone,data.rent,startMonth,tenant.id,opening,deposit,deposit>0?day():null,tenant.id).run();
      if (!result.meta.changes) return send({error:'चुनी गई किसी दुकान का इस महीने से आवंटन उपलब्ध नहीं है। दुकानें दोबारा चुनें।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && ['return-deposit','end-lease'].includes(route)) {
      const failure = await verifyPassword(db,request,data.password);
      if (failure) return failure;
    }
    if (method === 'POST' && route === 'edit-deposit') {
      const amount = data.deposit;
      if (!(amount===0 || validAmount(amount))) return send({error:'सुरक्षा राशि की सही रकम दर्ज करें।'},400);
      const result = await db.prepare(`UPDATE leases SET deposit=?,
        deposit_receipt_number=CASE WHEN ?>0 AND deposit_receipt_number IS NULL THEN ? ELSE deposit_receipt_number END,
        deposit_paid_on=CASE WHEN ?>0 AND deposit_paid_on IS NULL THEN ? ELSE deposit_paid_on END
        WHERE id=? AND deposit_returned_on IS NULL AND end_month IS NULL`)
        .bind(amount,amount,'SD-'+crypto.randomUUID().toUpperCase(),amount,day(),data.id).run();
      if (!result.meta.changes) return send({error:'यह जमा रिकॉर्ड संशोधित नहीं हो सका। वापसी हो चुकी हो तो बदलाव नहीं किया जा सकता।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'return-deposit') {
      const description = text(data.description,1000);
      const attachment = typeof data.attachment_data==='string' ? data.attachment_data : '';
      const attachmentName = text(data.attachment_name,120);
      if (!dateValid(data.returned_on) || data.returned_on>day()) {
        return send({error:'वापसी की सही तारीख चुनें।'},400);
      }
      if (description.length<3 || !attachment || attachment.length>260000 || !/^data:(image\/(jpeg|png|webp)|application\/pdf);base64,[A-Za-z0-9+/]+=*$/.test(attachment) || !attachmentName) {
        return send({error:'वापसी का विवरण लिखें और हस्ताक्षरित रसीद की JPG, PNG, WebP या PDF फ़ाइल जोड़ें (छोटी फ़ाइल, अधिकतम लगभग 190 KB)।'},400);
      }
      const [result] = await db.batch([
        db.prepare(`UPDATE leases SET deposit_returned_on=? WHERE id=?
          AND deposit>0 AND deposit_returned_on IS NULL AND end_month IS NULL
          AND start_month<=substr(?,1,7)`).bind(data.returned_on,data.id,data.returned_on),
        db.prepare(`INSERT INTO deposit_returns (lease_id,returned_on,description,attachment_data,attachment_name)
          SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM leases WHERE id=? AND deposit_returned_on=? AND deposit>0)
          AND NOT EXISTS (SELECT 1 FROM deposit_returns WHERE lease_id=?)`)
          .bind(data.id,data.returned_on,description,attachment,attachmentName,data.id,data.returned_on,data.id)
      ]);
      if (!result.meta.changes) return send({error:'वापसी दर्ज नहीं हुई। किरायेदारी और तारीख जाँचें।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'end-lease') {
      const active = await db.prepare('SELECT deposit,deposit_returned_on FROM leases WHERE id=? AND end_month IS NULL').bind(data.id).first();
      if (active?.deposit>0 && !active.deposit_returned_on) return send({error:'पहले सुरक्षा राशि की वापसी दर्ज करें।'},409);
      if (!monthValid(data.end_month)) return send({error:'किराये का अंतिम महीना चुनें।'},400);
      const result = await db.prepare(`UPDATE leases SET end_month=? WHERE id=? AND end_month IS NULL AND start_month<=?
        AND (deposit=0 OR deposit_returned_on IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM payments WHERE lease_id=leases.id AND month!='opening' AND month>?)`)
        .bind(data.end_month,data.id,data.end_month,data.end_month).run();
      if (!result.meta.changes) return send({error:'अंतिम महीना, शुरुआती महीने और दर्ज भुगतानों के महीनों से पहले का नहीं हो सकता।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'edit-receipt') {
      const id = text(data.id);
      const receiptNumber = typeof data.receipt_number==='string' ? data.receipt_number.trim() : '';
      const transactionId = typeof data.transaction_id==='string' ? data.transaction_id.trim() : '';
      const items = data.items;
      if (!id || receiptNumber.length>60 || !dateValid(data.paid_on) || data.paid_on>day() ||
          !['Cash','UPI','Bank Transfer','Cheque'].includes(data.method) ||
          (data.method==='UPI' && (!transactionId || transactionId.length>100)) ||
          !Array.isArray(items) || !items.length || items.length>1200 ||
          items.some(item=>!item || typeof item.id!=='string' || !item.id || !validAmount(item.amount)) ||
          new Set(items.map(item=>item.id)).size!==items.length) {
        return send({error:'रसीद की राशि, तारीख और भुगतान का विवरण जाँचें।'},400);
      }
      const result = await db.prepare(`WITH requested AS (
        SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.amount') AS amount
        FROM json_each(?)
      ), receipt AS MATERIALIZED (
        SELECT p.id,p.lease_id,p.month FROM payments AS p
        WHERE p.receipt_group=? OR (p.receipt_group IS NULL AND p.id=?)
      ), totals AS (
        SELECT receipt.lease_id,receipt.month,SUM(requested.amount) AS amount
        FROM receipt JOIN requested USING(id) GROUP BY receipt.lease_id,receipt.month
      )
      UPDATE payments SET amount=(SELECT amount FROM requested WHERE requested.id=payments.id),
        method=?,paid_on=?,transaction_id=?,receipt_number=CASE WHEN id=? THEN ? END
      WHERE id IN (SELECT id FROM receipt)
        AND (SELECT COUNT(*) FROM receipt JOIN requested USING(id))=(SELECT COUNT(*) FROM requested)
        AND (SELECT COUNT(*) FROM receipt)=(SELECT COUNT(*) FROM requested)
        AND NOT EXISTS (
          SELECT 1 FROM totals JOIN leases ON leases.id=totals.lease_id
          WHERE totals.amount + COALESCE((
            SELECT SUM(other.amount) FROM payments AS other
            WHERE other.lease_id=totals.lease_id AND other.month=totals.month
              AND other.id NOT IN (SELECT id FROM receipt)
          ),0) > CASE WHEN totals.month='opening' THEN leases.opening ELSE leases.rent END
        )`)
        .bind(JSON.stringify(items),id,id,data.method,data.paid_on,data.method==='UPI'?transactionId:null,id,receiptNumber || null).run();
      if (!result.meta.changes) return send({error:'रसीद नहीं मिली या संशोधित राशि देय किराये से अधिक है।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'payments') {
      const receiptNumber = typeof data.receipt_number==='string' ? data.receipt_number.trim() : '';
      if (!receiptNumber || receiptNumber.length>60) {
        return send({error:'रसीद नंबर दर्ज करें (अधिकतम 60 अक्षर)।'},400);
      }
      const transactionId = typeof data.transaction_id==='string' ? data.transaction_id.trim() : '';
      if (data.method==='UPI' && (!transactionId || transactionId.length>100)) {
        return send({error:'यूपीआई भुगतान के लिए ट्रांज़ैक्शन आईडी दर्ज करें (अधिकतम 100 अक्षर)।'},400);
      }
      const rawItems = data.items ?? [{month:data.month,amount:data.amount}];
      const items = Array.isArray(rawItems) ? rawItems.map(item=>item && ({
        lease_id:item.lease_id ?? data.lease_id, month:item.month, amount:item.amount
      })) : null;
      if (!Array.isArray(items) || !items.length || items.length>1200 ||
          items.some(item=>!item || typeof item.lease_id!=='string' || !item.lease_id || typeof item.month!=='string' ||
            (item.month!=='opening' && !monthValid(item.month)) || !validAmount(item.amount)) ||
          new Set(items.map(item=>JSON.stringify([item.lease_id,item.month]))).size!==items.length ||
          !['Cash','UPI'].includes(data.method) ||
          !dateValid(data.paid_on) || data.paid_on > day() || !/^[a-f0-9-]{36}$/.test(data.id)) {
        return send({error:'सही राशि, भुगतान की तारीख और तरीका दर्ज करें।'},400);
      }
      if (await db.prepare('SELECT id FROM payments WHERE id=?').bind(data.id).first()) return send({ok:true});
      const allocations = items.map((item,index)=>({...item,id:index?crypto.randomUUID():data.id}));
      const result = await db.prepare(`WITH requested AS (
        SELECT key AS position, json_extract(value,'$.id') AS id,
          json_extract(value,'$.lease_id') AS lease_id,
          json_extract(value,'$.month') AS month, json_extract(value,'$.amount') AS amount
        FROM json_each(?)
      ), payable AS (
        SELECT requested.* FROM requested JOIN leases ON leases.id=requested.lease_id
        JOIN leases AS anchor ON anchor.id=?
        WHERE (leases.id=anchor.id OR leases.tenant_id=anchor.tenant_id)
          AND (requested.month='opening' OR (leases.start_month<=requested.month AND (leases.end_month IS NULL OR leases.end_month>=requested.month)))
          AND (CASE WHEN requested.month='opening' THEN leases.opening ELSE leases.rent END) -
              COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.lease_id=leases.id AND p.month=requested.month),0)>=requested.amount
      )
      INSERT INTO payments (id,lease_id,month,amount,method,paid_on,transaction_id,receipt_number,receipt_group)
      SELECT id,lease_id,month,amount,?,?,?,CASE WHEN position=0 THEN ? END,?
      FROM payable WHERE (SELECT count(*) FROM payable)=(SELECT count(*) FROM requested)
        AND NOT EXISTS (SELECT 1 FROM payments WHERE id=?)`).bind(JSON.stringify(allocations),items[0].lease_id,
          data.method,data.paid_on,data.method==='UPI'?transactionId:null,receiptNumber,data.id,data.id).run();
      if (!result.meta.changes && !await db.prepare('SELECT id FROM payments WHERE id=?').bind(data.id).first()) {
        return send({error:'राशि बाकी किराये से अधिक है या चुना हुआ महीना किरायेदारी की अवधि से बाहर है।'},409);
      }
      return send({ok:true});
    }
    return send({error:'पेज नहीं मिला।'},404);
  } catch (error) {
    if (String(error).includes('Cloudflare का ADMIN_PASSWORD secret सेट करें।')) return send({error:'Cloudflare में ADMIN_PASSWORD secret सेट करें।'},503);
    if (String(error).includes('UNIQUE constraint failed: shops.code')) return send({error:'यह दुकान नंबर पहले से दर्ज है।'},409);
    if (/UNIQUE constraint failed: payments\.receipt_number|payments_receipt_number_unique/.test(String(error))) {
      return send({error:'यह रसीद नंबर पहले से दर्ज है। दूसरा नंबर डालें।'},409);
    }
    console.error('Shop API request failed', route, error.name);
    return send({error:'काम पूरा नहीं हो सका। कृपया फिर कोशिश करें।'},500);
  }
}
