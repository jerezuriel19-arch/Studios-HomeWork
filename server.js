import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const { Pool } = pg;
const PORT = process.env.PORT || 10000;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';

const plans = {
  monthly: { label: '1 mes', amount: 3990, months: 1 },
  quarterly: { label: '3 meses', amount: 9000, months: 3 },
  annual: { label: '1 año', amount: 33900, months: 12 }
};

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
}) : null;

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');
const passwordHash = async (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const derived = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (e, k) => e ? reject(e) : resolve(k.toString('hex'))));
  return `${salt}:${derived}`;
};
const passwordVerify = async (password, stored) => {
  const [salt, key] = String(stored || '').split(':');
  if (!salt || !key) return false;
  const derived = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (e, k) => e ? reject(e) : resolve(k.toString('hex'))));
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
};
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

async function dbReady() {
  if (!pool) throw new Error('DATABASE_URL no configurada');
}

async function initDb() {
  await dbReady();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      pro_plan TEXT,
      pro_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      payment_id TEXT UNIQUE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL,
      external_reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);
  `);
}

function cookieOptions(maxAge) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function currentUser(req) {
  await dbReady();
  const token = parseCookies(req).shw_session;
  if (!token) return null;
  const { rows } = await pool.query(`SELECT u.id,u.email,u.pro_plan,u.pro_expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()`, [hash(token)]);
  if (!rows[0]) return null;
  return rows[0];
}

function requireFields(body, fields) {
  for (const f of fields) if (!body?.[f]) return f;
  return null;
}

app.use('/api', express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/health', async (_req, res) => {
  try { await dbReady(); await pool.query('SELECT 1'); res.json({ ok: true, database: true }); }
  catch (e) { res.status(503).json({ ok: false, database: false, error: e.message }); }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const u = await currentUser(req);
    if (!u) return res.json({ loggedIn: false });
    const isPro = !!u.pro_expires_at && new Date(u.pro_expires_at) > new Date();
    res.json({ loggedIn: true, email: u.email, isPro, plan: u.pro_plan || null, expiresAt: u.pro_expires_at || null });
  } catch (e) { res.status(503).json({ error: 'Base de datos no disponible' }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    await dbReady();
    const email = normalizeEmail(req.body.email), password = String(req.body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Ingresá un email válido.' });
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    const ph = await passwordHash(password);
    const r = await pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email', [email, ph]);
    const token = randomToken();
    await pool.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')`, [r.rows[0].id, hash(token)]);
    res.setHeader('Set-Cookie', `shw_session=${encodeURIComponent(token)}; ${cookieOptions(60*60*24*30)}`);
    res.json({ ok: true, email });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ese email ya está registrado.' });
    console.error(e); res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    await dbReady();
    const email = normalizeEmail(req.body.email), password = String(req.body.password || '');
    const r = await pool.query('SELECT id,email,password_hash FROM users WHERE email=$1', [email]);
    if (!r.rows[0] || !(await passwordVerify(password, r.rows[0].password_hash))) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    const token = randomToken();
    await pool.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')`, [r.rows[0].id, hash(token)]);
    res.setHeader('Set-Cookie', `shw_session=${encodeURIComponent(token)}; ${cookieOptions(60*60*24*30)}`);
    res.json({ ok: true, email });
  } catch (e) { console.error(e); res.status(503).json({ error: 'Base de datos no disponible.' }); }
});

app.post('/api/auth/logout', async (req, res) => {
  try { if (pool) { const t=parseCookies(req).shw_session; if(t) await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hash(t)]); } } catch {}
  res.setHeader('Set-Cookie', `shw_session=; ${cookieOptions(0)}`);
  res.json({ ok: true });
});

app.post('/api/create-preference', async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) return res.status(503).json({ error: 'Mercado Pago no está configurado.' });
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'INICIAR_SESION' });
    const plan = String(req.body.plan || '');
    if (!plans[plan]) return res.status(400).json({ error: 'Plan inválido.' });
    const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    const preference = new Preference(mp);
    const reference = `shw:${u.id}:${plan}:${crypto.randomUUID()}`;
    const base = APP_URL || `${req.protocol}://${req.get('host')}`;
    const result = await preference.create({ body: {
      items: [{ id: `shw-${plan}`, title: `Studios HomeWork PRO · ${plans[plan].label}`, quantity: 1, unit_price: plans[plan].amount, currency_id: 'ARS' }],
      external_reference: reference,
      metadata: { user_id: String(u.id), plan },
      back_urls: { success: `${base}/?payment=success`, failure: `${base}/?payment=failure`, pending: `${base}/?payment=pending` },
      auto_return: 'approved',
      notification_url: `${base}/api/mercadopago/webhook`
    }});
    res.json({ init_point: result.init_point });
  } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudo crear el pago.' }); }
});

function verifySignature(req) {
  if (!MP_WEBHOOK_SECRET) return process.env.NODE_ENV !== 'production';
  const sig = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '');
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();
  let ts='', v1='';
  for (const p of sig.split(',')) { const [k,...v]=p.split('='); if(k==='ts') ts=v.join('='); if(k==='v1') v1=v.join('='); }
  if (!ts || !v1 || !dataId || !requestId) return false;
  const template = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(template).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); } catch { return false; }
}

app.post('/api/mercadopago/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    if (!verifySignature(req) || !MP_ACCESS_TOKEN) return;
    const type = String(req.body?.type || req.query?.type || '');
    if (type !== 'payment') return;
    const paymentId = String(req.body?.data?.id || req.query?.['data.id'] || '');
    if (!paymentId) return;
    const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    const payment = await new Payment(mp).get({ id: paymentId });
    if (!['approved'].includes(payment.status)) return;
    const reference = String(payment.external_reference || '');
    const m = reference.match(/^shw:(\d+):(monthly|quarterly|annual):/);
    if (!m) return;
    const userId = Number(m[1]), plan = m[2], p = plans[plan];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT id FROM payments WHERE payment_id=$1', [paymentId]);
      if (!exists.rows[0]) {
        const old = await client.query('SELECT pro_expires_at FROM users WHERE id=$1 FOR UPDATE', [userId]);
        if (!old.rows[0]) { await client.query('ROLLBACK'); return; }
        const current = old.rows[0].pro_expires_at && new Date(old.rows[0].pro_expires_at) > new Date() ? new Date(old.rows[0].pro_expires_at) : new Date();
        current.setMonth(current.getMonth() + p.months);
        await client.query('UPDATE users SET pro_plan=$1,pro_expires_at=$2 WHERE id=$3', [plan, current, userId]);
        await client.query(`INSERT INTO payments(payment_id,user_id,plan,amount,status,external_reference,approved_at) VALUES($1,$2,$3,$4,'approved',$5,NOW())`, [paymentId,userId,plan,p.amount,reference]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } catch (e) { console.error('Webhook:', e); }
});

app.get('/account-layer.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'account-layer.js'));
});

app.get('/', (_req, res) => {
  const file = path.join(__dirname, 'index.html');
  res.sendFile(file, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }, (err) => {
    if (err && !res.headersSent) res.status(500).send('No se pudo cargar Studios HomeWork.');
  });
});
app.use(express.static(__dirname, { index: false }));
app.use((req,res,next)=>{ if(req.method!=='GET') return next(); if(req.path.startsWith('/api/')||req.path==='/health'||req.path==='/account-layer.js') return next(); res.sendFile(path.join(__dirname,'index.html')); });

if (pool) initDb().then(()=>app.listen(PORT,()=>console.log(`Studios HomeWork escuchando en ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
else app.listen(PORT,()=>console.log(`Studios HomeWork escuchando en ${PORT} (DATABASE_URL pendiente)`));
