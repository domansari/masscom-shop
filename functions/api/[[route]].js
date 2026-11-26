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
async function matches(input, secret) {
  const [a,b] = await Promise.all([digest(input),digest(secret)]);
  let difference = 0;
  for (let i=0; i<a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function text(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0,max) : '';
}
const validAmount = amount => Number.isSafeInteger(amount) && amount > 0 && amount <= 10000000000;

async function verifyPassword(db,request,password,secret) {
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
  if (!await matches(password,secret)) {
    return send({error:'पासवर्ड गलत है।'},401);
  }
  await db.prepare('DELETE FROM login_attempts WHERE client=? OR expires<=?').bind(client,time).run();
  return null;
}

export async function onRequest({request,env}) {
  const url = new URL(request.url);
  const route = url.pathname.slice(5);
  const method = request.method;
  const db = env.SHOP_DB;
  if (!db || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8 || env.ADMIN_PASSWORD.length > 20) return send({error:'Cloudflare का सेटअप अभी बाकी है।'},503);
  if (method !== 'GET' && (method !== 'POST' || request.headers.get('Origin') !== url.origin)) {
    return send({error:'यह अनुरोध स्वीकार नहीं किया गया।'},403);
  }
  try {
    let data = {};
    if (method === 'POST') {
      try { data = await request.json(); } catch { return send({error:'अनुरोध अमान्य है।'},400); }
      if (!data || typeof data !== 'object') return send({error:'Invalid request.'},400);
    }
    if (method === 'POST' && route === 'login') {
      const failure = await verifyPassword(db,request,data.password,env.ADMIN_PASSWORD);
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
    if (method === 'GET' && route === 'ledger') {
      const [shops, leases, payments, markets, tenants] = await db.batch([
        db.prepare('SELECT * FROM shops ORDER BY code COLLATE NOCASE'),
        db.prepare('SELECT * FROM leases ORDER BY start_month DESC'),
        db.prepare('SELECT * FROM payments ORDER BY paid_on DESC, rowid DESC'),
        db.prepare('SELECT * FROM markets ORDER BY rowid'),
        db.prepare('SELECT * FROM tenants ORDER BY name COLLATE NOCASE')
      ]);
      return send({shops:shops.results, leases:leases.results, payments:payments.results, markets:markets.results, tenants:tenants.results, today:day()});
    }
    if (method === 'POST' && route === 'shops') {
      const number = text(data.code,40);
      const selectedMarket = data.market_id
        ? await db.prepare('SELECT * FROM markets WHERE id=?').bind(data.market_id).first()
        : null;
      if (data.market_id && !selectedMarket) return send({error:'सही मार्केट चुनें।'},400);
      const code = selectedMarket && number ? selectedMarket.prefix+'-'+number : number;
      if (!code) return send({error:'दुकान का नंबर या नाम दर्ज करें।'},400);
      if (data.id) {
        await db.prepare('UPDATE shops SET code=?, address=?, market_id=? WHERE id=?').bind(code,text(data.address,240),selectedMarket?.id ?? null,data.id).run();
      } else {
        await db.prepare('INSERT INTO shops (id,code,address,market_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(),code,text(data.address,240),selectedMarket?.id ?? null).run();
      }
      return send({ok:true});
    }
    if (method === 'POST' && route === 'tenants') {
      const name = text(data.name);
      if (!name) return send({error:'किरायेदार का नाम दर्ज करें।'},400);
      const phone = typeof data.phone === 'string' ? data.phone.trim() : '';
      const aadhaarLast4 = typeof data.aadhaar_last4 === 'string' ? data.aadhaar_last4.trim() : '';
      if (!/^[0-9]{10}$/.test(phone)) return send({error:'10 अंकों का मोबाइल नंबर दर्ज करें।'},400);
      if (aadhaarLast4 && !/^[0-9]{4}$/.test(aadhaarLast4)) return send({error:'आधार के आखिरी चार अंक दर्ज करें।'},400);
      await db.prepare('INSERT INTO tenants (id,name,phone,address,business,aadhaar_last4) VALUES (?,?,?,?,?,?)')
        .bind(crypto.randomUUID(),name,phone,text(data.address,240),text(data.business,120),aadhaarLast4).run();
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
      if (!tenant || !validAmount(data.rent) || ![opening,deposit].every(n=>n===0 || validAmount(n))) {
        return send({error:'किरायेदार चुनें और किराया, पिछला बकाया व सुरक्षा राशि सही दर्ज करें।'},400);
      }
      const result = await db.prepare(`INSERT INTO leases (id,shop_id,tenant,phone,rent,start_month,tenant_id,opening,deposit)
        SELECT ?,id,?,?,?,?,?,?,? FROM shops WHERE id=? AND NOT EXISTS (
          SELECT 1 FROM leases WHERE shop_id=shops.id AND (end_month IS NULL OR end_month>=?)
        )`).bind(crypto.randomUUID(),tenant.name,tenant.phone,data.rent,startMonth,tenant.id,opening,deposit,data.shop_id,startMonth).run();
      if (!result.meta.changes) return send({error:'इस दुकान के लिए उस महीने से किरायेदारी पहले से दर्ज है।'},409);
      return send({ok:true});
    }
    if (method === 'POST' && ['return-deposit','end-lease'].includes(route)) {
      const failure = await verifyPassword(db,request,data.password,env.ADMIN_PASSWORD);
      if (failure) return failure;
    }
    if (method === 'POST' && route === 'return-deposit') {
      if (!dateValid(data.returned_on) || data.returned_on>day()) {
        return send({error:'वापसी की सही तारीख चुनें।'},400);
      }
      const result = await db.prepare(`UPDATE leases SET deposit_returned_on=? WHERE id=?
        AND deposit>0 AND deposit_returned_on IS NULL AND end_month IS NULL
        AND start_month<=substr(?,1,7)`).bind(data.returned_on,data.id,data.returned_on).run();
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
    if (method === 'POST' && route === 'payments') {
      const receiptNumber = typeof data.receipt_number==='string' ? data.receipt_number.trim() : '';
      if (!receiptNumber || receiptNumber.length>60) {
        return send({error:'रसीद नंबर दर्ज करें (अधिकतम 60 अक्षर)।'},400);
      }
      const transactionId = typeof data.transaction_id==='string' ? data.transaction_id.trim() : '';
      if (data.method==='UPI' && (!transactionId || transactionId.length>100)) {
        return send({error:'यूपीआई भुगतान के लिए ट्रांज़ैक्शन आईडी दर्ज करें (अधिकतम 100 अक्षर)।'},400);
      }
      if ((data.month!=='opening' && !monthValid(data.month)) || !validAmount(data.amount) ||
          !['Cash','UPI'].includes(data.method) ||
          !dateValid(data.paid_on) || data.paid_on > day() || !/^[a-f0-9-]{36}$/.test(data.id)) {
        return send({error:'सही राशि, भुगतान की तारीख और तरीका दर्ज करें।'},400);
      }
      if (await db.prepare('SELECT id FROM payments WHERE id=?').bind(data.id).first()) return send({ok:true});
      const result = await db.prepare(`INSERT INTO payments (id,lease_id,month,amount,method,paid_on,transaction_id,receipt_number)
        SELECT ?,id,?,?,?,?,?,? FROM leases WHERE id=? AND (?='opening' OR (start_month<=? AND (end_month IS NULL OR end_month>=?)))
        AND (CASE WHEN ?='opening' THEN opening ELSE rent END) - COALESCE((SELECT SUM(amount) FROM payments WHERE lease_id=leases.id AND month=?),0)>=?
        ON CONFLICT(id) DO NOTHING`).bind(data.id,data.month,data.amount,data.method,data.paid_on,data.method==='UPI'?transactionId:null,receiptNumber,
          data.lease_id,data.month,data.month,data.month,data.month,data.month,data.amount).run();
      if (!result.meta.changes && !await db.prepare('SELECT id FROM payments WHERE id=?').bind(data.id).first()) {
        return send({error:'राशि बाकी किराये से अधिक है या चुना हुआ महीना किरायेदारी की अवधि से बाहर है।'},409);
      }
      return send({ok:true});
    }
    return send({error:'पेज नहीं मिला।'},404);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: shops.code')) return send({error:'यह दुकान नंबर पहले से दर्ज है।'},409);
    if (/UNIQUE constraint failed: payments\.receipt_number|payments_receipt_number_unique/.test(String(error))) {
      return send({error:'यह रसीद नंबर पहले से दर्ज है। दूसरा नंबर डालें।'},409);
    }
    console.error('Shop API request failed', route, error.name);
    return send({error:'काम पूरा नहीं हो सका। कृपया फिर कोशिश करें।'},500);
  }
}
