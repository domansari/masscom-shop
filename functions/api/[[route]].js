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
    if (['ledger','shops','archive-shop','edit-allocation','leases'].includes(route)) {
      await db.prepare('CREATE TABLE IF NOT EXISTS archived_shops (shop_id TEXT PRIMARY KEY REFERENCES shops(id))').run();
    }
    if (method === 'GET' && route === 'ledger') {
      const [shops, leases, payments, markets, tenants] = await db.batch([
        db.prepare('SELECT shops.*, archived_shops.shop_id IS NOT NULL AS is_archived FROM shops LEFT JOIN archived_shops ON archived_shops.shop_id=shops.id ORDER BY code COLLATE NOCASE'),
        db.prepare('SELECT * FROM leases ORDER BY start_month DESC'),
        db.prepare('SELECT * FROM payments ORDER BY paid_on DESC, rowid DESC'),
        db.prepare('SELECT * FROM markets ORDER BY rowid'),
        db.prepare('SELECT id,name,father_name,phone,address,business,tenant_id_number,photo IS NOT NULL AS has_photo,is_active FROM tenants ORDER BY name COLLATE NOCASE')
      ]);
      return send({shops:shops.results, leases:leases.results, payments:payments.results, markets:markets.results, tenants:tenants.results, today:day()});
    }
    if (method === 'POST' && route === 'markets') {
      const name = text(data.name,120).normalize('NFC');
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
        ? await db.prepare('SELECT * FROM markets WHERE id=?').bind(data.market_id).first()
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
        const result = await db.prepare('UPDATE shops SET code=?, address=?, market_id=?, is_blocked=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM archived_shops WHERE shop_id=shops.id)')
          .bind(code,text(data.address,240),selectedMarket?.id ?? null,blocked,text(data.id)).run();
        if (!result.meta.changes) return send({error:'दुकान नहीं मिली।'},404);
      } else {
        await db.prepare('INSERT INTO shops (id,code,address,market_id) VALUES (?,?,?,?)')
          .bind(crypto.randomUUID(),code,text(data.address,240),selectedMarket?.id ?? null).run();
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
            WHERE id=? AND NOT EXISTS (${conflict})`)
          .bind(name,phone,address,business,tenantIdNumber,fatherName,photo ?? null,tenantId,...match).run()
        : await db.prepare(`INSERT INTO tenants (id,name,phone,address,business,tenant_id_number,father_name,photo)
            SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (${conflict})`)
          .bind(crypto.randomUUID(),name,phone,address,business,tenantIdNumber,fatherName,photo ?? null,...match).run();
      if (!result.meta.changes) return send({error:duplicateTenant},409);
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
      await db.prepare('UPDATE tenants SET is_active=? WHERE id=?').bind(active,tenantId).run();
      return send({ok:true});
    }
    if (method === 'POST' && route === 'edit-allocation') {
      const {rent,opening,deposit} = data;
      const shopId = text(data.shop_id,120);
      const allocation = await db.prepare('SELECT id,shop_id,start_month,deposit,deposit_receipt_number,deposit_paid_on FROM leases WHERE id=? AND end_month IS NULL')
        .bind(text(data.id)).first();
      if (!allocation) return send({error:'यह आवंटन अब संशोधित नहीं किया जा सकता।'},409);
      if (!shopId || !validAmount(rent) || ![opening,deposit].every(n=>n===0 || validAmount(n))) {
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
      const result = await db.prepare(`UPDATE leases SET shop_id=?, rent=?, opening=?, deposit=?, deposit_receipt_number=?, deposit_paid_on=?
        WHERE id=? AND end_month IS NULL AND (deposit_returned_on IS NULL OR deposit=?)
          AND (shop_id=? OR (EXISTS (SELECT 1 FROM shops WHERE id=? AND is_blocked=0)
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
      if (!tenant || tenant.is_active!==1 || !validAmount(data.rent) || ![opening,deposit].every(n=>n===0 || validAmount(n))) {
        return send({error:'किरायेदार चुनें और किराया, पिछला बकाया व सुरक्षा राशि सही दर्ज करें।'},400);
      }
      const shopIds = data.shop_ids ?? [data.shop_id];
      if (!Array.isArray(shopIds) || !shopIds.length || shopIds.length>127 ||
          shopIds.some(id=>typeof id!=='string' || !id || id.length>120) ||
          new Set(shopIds).size!==shopIds.length) return send({error:'कम से कम एक सही दुकान चुनें।'},400);
      const requested = shopIds.map(shop_id=>({id:crypto.randomUUID(),shop_id,
        deposit_receipt_number:deposit>0?'SD-'+crypto.randomUUID().toUpperCase():null}));
      const result = await db.prepare(`WITH requested AS (
        SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.shop_id') AS shop_id,
          json_extract(value,'$.deposit_receipt_number') AS deposit_receipt_number FROM json_each(?)
      ), available AS (
        SELECT requested.* FROM requested JOIN shops ON shops.id=requested.shop_id
        WHERE shops.is_blocked=0
          AND NOT EXISTS (SELECT 1 FROM archived_shops WHERE shop_id=shops.id)
          AND NOT EXISTS (SELECT 1 FROM leases WHERE leases.shop_id=requested.shop_id AND (end_month IS NULL OR end_month>=?))
      ) INSERT INTO leases (id,shop_id,tenant,phone,rent,start_month,tenant_id,opening,deposit,deposit_receipt_number,deposit_paid_on)
      SELECT id,shop_id,?,?,?,?,?,?,?,deposit_receipt_number,? FROM available
      WHERE (SELECT count(*) FROM available)=(SELECT count(*) FROM requested)`)
        .bind(JSON.stringify(requested),startMonth,tenant.name,tenant.phone,data.rent,startMonth,tenant.id,opening,deposit,deposit>0?day():null).run();
      if (!result.meta.changes) return send({error:'चुनी गई किसी दुकान का इस महीने से आवंटन उपलब्ध नहीं है। दुकानें दोबारा चुनें।'},409);
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
    if (String(error).includes('UNIQUE constraint failed: shops.code')) return send({error:'यह दुकान नंबर पहले से दर्ज है।'},409);
    if (/UNIQUE constraint failed: payments\.receipt_number|payments_receipt_number_unique/.test(String(error))) {
      return send({error:'यह रसीद नंबर पहले से दर्ज है। दूसरा नंबर डालें।'},409);
    }
    console.error('Shop API request failed', route, error.name);
    return send({error:'काम पूरा नहीं हो सका। कृपया फिर कोशिश करें।'},500);
  }
}
