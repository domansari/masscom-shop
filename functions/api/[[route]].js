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

export async function onRequest({request,env}) {
  const url = new URL(request.url);
  const route = url.pathname.slice(5);
  const method = request.method;
  const db = env.SHOP_DB;
  if (!db || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 20) return send({error:'Cloudflare setup is pending.'},503);
  if (method !== 'GET' && (method !== 'POST' || request.headers.get('Origin') !== url.origin)) {
    return send({error:'Request blocked.'},403);
  }
  try {
    let data = {};
    if (method === 'POST') {
      try { data = await request.json(); } catch { return send({error:'Invalid request.'},400); }
      if (!data || typeof data !== 'object') return send({error:'Invalid request.'},400);
    }
    if (method === 'POST' && route === 'login') {
      if (typeof data.password !== 'string' || data.password.length > 512 ||
          !await matches(data.password,env.ADMIN_PASSWORD)) return send({error:'Incorrect password.'},401);
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
      return send({error:'Please sign in.'},401);
    }
    if (method === 'POST' && route === 'logout') {
      await db.prepare('DELETE FROM sessions WHERE id=?').bind(id).run();
      return send({ok:true},200,'');
    }
    if (method === 'GET' && route === 'ledger') {
      const [shops, leases, payments] = await db.batch([
        db.prepare('SELECT * FROM shops ORDER BY code COLLATE NOCASE'),
        db.prepare('SELECT * FROM leases ORDER BY start_month DESC'),
        db.prepare('SELECT * FROM payments ORDER BY paid_on DESC, rowid DESC')
      ]);
      return send({shops:shops.results, leases:leases.results, payments:payments.results, today:day()});
    }
    if (method === 'POST' && route === 'shops') {
      const code = text(data.code,40);
      if (!code) return send({error:'Enter a shop number or name.'},400);
      if (data.id) {
        await db.prepare('UPDATE shops SET code=?, address=? WHERE id=?').bind(code,text(data.address,240),data.id).run();
      } else {
        await db.prepare('INSERT INTO shops VALUES (?,?,?)').bind(crypto.randomUUID(),code,text(data.address,240)).run();
      }
      return send({ok:true});
    }
    if (method === 'POST' && route === 'leases') {
      const tenant = text(data.tenant);
      if (!tenant || !monthValid(data.start_month) || !validAmount(data.rent)) {
        return send({error:'Enter a tenant, start month and valid monthly rent.'},400);
      }
      const result = await db.prepare(`INSERT INTO leases (id,shop_id,tenant,phone,rent,start_month)
        SELECT ?,id,?,?,?,? FROM shops WHERE id=? AND NOT EXISTS (
          SELECT 1 FROM leases WHERE shop_id=shops.id AND (end_month IS NULL OR end_month>=?)
        )`).bind(crypto.randomUUID(),tenant,text(data.phone,32),data.rent,data.start_month,data.shop_id,data.start_month).run();
      if (!result.meta.changes) return send({error:'This shop already has a tenancy covering that start month.'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'end-lease') {
      if (!monthValid(data.end_month)) return send({error:'Select the last billable month.'},400);
      const result = await db.prepare(`UPDATE leases SET end_month=? WHERE id=? AND end_month IS NULL AND start_month<=?
        AND NOT EXISTS (SELECT 1 FROM payments WHERE lease_id=leases.id AND month>?)`)
        .bind(data.end_month,data.id,data.end_month,data.end_month).run();
      if (!result.meta.changes) return send({error:'The last month must include the start month and every payment already recorded.'},409);
      return send({ok:true});
    }
    if (method === 'POST' && route === 'payments') {
      if (!monthValid(data.month) || !validAmount(data.amount) ||
          !['Cash','UPI','Bank Transfer','Cheque'].includes(data.method) ||
          !dateValid(data.paid_on) || data.paid_on > day() || !/^[a-f0-9-]{36}$/.test(data.id)) {
        return send({error:'Enter a valid amount, payment date and method.'},400);
      }
      if (await db.prepare('SELECT id FROM payments WHERE id=?').bind(data.id).first()) return send({ok:true});
      const result = await db.prepare(`INSERT INTO payments (id,lease_id,month,amount,method,paid_on)
        SELECT ?,id,?,?,?,? FROM leases WHERE id=? AND start_month<=? AND (end_month IS NULL OR end_month>=?)
        AND rent - COALESCE((SELECT SUM(amount) FROM payments WHERE lease_id=leases.id AND month=?),0)>=?
        ON CONFLICT(id) DO NOTHING`).bind(data.id,data.month,data.amount,data.method,data.paid_on,
          data.lease_id,data.month,data.month,data.month,data.amount).run();
      if (!result.meta.changes && !await db.prepare('SELECT id FROM payments WHERE id=?').bind(data.id).first()) {
        return send({error:'The payment exceeds the remaining rent or falls outside the tenancy.'},409);
      }
      return send({ok:true});
    }
    return send({error:'Page not found.'},404);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: shops.code')) return send({error:'That shop number already exists.'},409);
    console.error('Shop API request failed', route, error.name);
    return send({error:'Could not complete the request. Please try again.'},500);
  }
}
