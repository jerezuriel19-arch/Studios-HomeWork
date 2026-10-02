import express from 'express';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
}) : null;

const PLANS = {
  monthly: { title: 'Studios HomeWork PRO · 1 mes', amount: 3990, months: 1 },
  quarterly: { title: 'Studios HomeWork PRO · 3 meses', amount: 9000, months: 3 },
  annual: { title: 'Studios HomeWork PRO · 1 año', amount: 33900, months: 12 }
};

function cleanEmail(v) { return String(v || '').trim().toLowerCase(); }
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }
function sha256(v) { return crypto.createHash('sha256').update(v).digest('hex'); }
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `shw_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'shw_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}
async function dbReady() {
  if (!pool) throw new Error('DATABASE_URL no está configurada.');
}
async function initDb() {
  if (!pool) return;
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
      token_hash TEXT NOT NULL UNIQUE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      payment_id TEXT UNIQUE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL,
      external_reference TEXT,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
async function currentUser(req) {
  if (!pool) return null;
  const token = parseCookies(req).shw_session;
  if (!token) return null;
  const { rows } = await pool.query(`
    SELECT u.id, u.email, u.pro_plan, u.pro_expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at > NOW()
  `, [sha256(token)]);
  return rows[0] || null;
}
function publicUser(u) {
  if (!u) return { loggedIn: false, isPro: false, email: null, plan: null, expiresAt: null };
  const isPro = !!u.pro_expires_at && new Date(u.pro_expires_at).getTime() > Date.now();
  return { loggedIn: true, isPro, email: u.email, plan: isPro ? u.pro_plan : null, expiresAt: isPro ? u.pro_expires_at : null };
}
async function requireUser(req, res) {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ ok: false, error: 'Necesitás iniciar sesión.' }); return null; }
  return user;
}

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', async (req, res) => {
  let database = 'not_configured';
  if (pool) {
    try { await pool.query('SELECT 1'); database = 'ok'; } catch { database = 'error'; }
  }
  res.json({ ok: true, database, mercadoPago: !!MP_ACCESS_TOKEN });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    await dbReady();
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Ingresá un email válido.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email,pro_plan,pro_expires_at', [email, hash]);
    const token = randomToken();
    await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL \'30 days\')', [sha256(token), rows[0].id]);
    setSessionCookie(res, token);
    res.json({ ok: true, user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'Ese email ya tiene una cuenta.' });
    console.error(e); res.status(500).json({ ok: false, error: 'No se pudo crear la cuenta.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    await dbReady();
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    const { rows } = await pool.query('SELECT id,email,password_hash,pro_plan,pro_expires_at FROM users WHERE email=$1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ ok: false, error: 'Email o contraseña incorrectos.' });
    const token = randomToken();
    await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL \'30 days\')', [sha256(token), user.id]);
    setSessionCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'No se pudo iniciar sesión.' }); }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    if (pool) { const token = parseCookies(req).shw_session; if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(token)]); }
  } catch {}
  clearSessionCookie(res); res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  try { res.json({ ok: true, user: publicUser(await currentUser(req)) }); }
  catch (e) { res.status(500).json({ ok: false, error: 'No se pudo consultar la cuenta.' }); }
});

app.post('/api/create-preference', async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    if (!MP_ACCESS_TOKEN) return res.status(503).json({ ok: false, error: 'Mercado Pago todavía no está configurado en el servidor.' });
    const planKey = String(req.body.plan || '');
    const plan = PLANS[planKey];
    if (!plan) return res.status(400).json({ ok: false, error: 'Plan inválido.' });
    const externalReference = `shw:${user.id}:${planKey}:${randomToken(10)}`;
    const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    const preference = new Preference(client);
    const created = await preference.create({ body: {
      items: [{ title: plan.title, quantity: 1, currency_id: 'ARS', unit_price: plan.amount }],
      external_reference: externalReference,
      notification_url: `${BASE_URL}/api/mercadopago/webhook`,
      back_urls: { success: `${BASE_URL}/?payment=success`, failure: `${BASE_URL}/?payment=failure`, pending: `${BASE_URL}/?payment=pending` },
      auto_return: 'approved'
    }});
    res.json({ ok: true, init_point: created.init_point, preference_id: created.id });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'No se pudo crear el pago.' }); }
});

async function verifyWebhook(req) {
  if (!MP_WEBHOOK_SECRET) return false;
  const sig = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'] || '';
  const dataId = String(req.query['data.id'] || '').toLowerCase();
  if (!sig || !dataId) return false;
  let ts = '', v1 = '';
  for (const part of String(sig).split(',')) {
    const [k, ...rest] = part.split('=');
    const v = rest.join('=').trim();
    if (k?.trim() === 'ts') ts = v;
    if (k?.trim() === 'v1') v1 = v;
  }
  if (!ts || !v1) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'utf8'), b = Buffer.from(v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/mercadopago/webhook', async (req, res) => {
  try {
    if (!MP_WEBHOOK_SECRET || !(await verifyWebhook(req))) return res.status(401).json({ ok: false });
    const type = req.body?.type || req.query?.type;
    if (type !== 'payment') return res.status(200).json({ ok: true });
    const paymentId = String(req.body?.data?.id || req.query['data.id'] || '');
    if (!paymentId || !MP_ACCESS_TOKEN) return res.status(200).json({ ok: true });
    const mp = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } });
    if (!mp.ok) return res.status(200).json({ ok: true });
    const payment = await mp.json();
    const reference = String(payment.external_reference || '');
    const match = reference.match(/^shw:(\d+):(monthly|quarterly|annual):/);
    if (!match) return res.status(200).json({ ok: true });
    const userId = Number(match[1]);
    const planKey = match[2];
    const plan = PLANS[planKey];
    if (Number(payment.transaction_amount) !== plan.amount) return res.status(200).json({ ok: true });
    await pool.query(`
      INSERT INTO payments(payment_id,user_id,plan,amount,status,external_reference,approved_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(payment_id) DO UPDATE SET status=EXCLUDED.status, approved_at=EXCLUDED.approved_at
    `, [paymentId, userId, planKey, plan.amount, payment.status || 'unknown', reference, payment.status === 'approved' ? new Date(payment.date_approved || Date.now()) : null]);
    if (payment.status === 'approved') {
      await pool.query(`
        UPDATE users SET pro_plan=$1,
          pro_expires_at=GREATEST(COALESCE(pro_expires_at,NOW()),NOW()) + ($2 || ' months')::interval
        WHERE id=$3
      `, [planKey, String(plan.months), userId]);
    }
    res.status(200).json({ ok: true });
  } catch (e) { console.error('webhook', e); res.status(200).json({ ok: true }); }
});

app.use(express.static(__dirname));
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health') return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb().then(() => app.listen(PORT, () => console.log(`Studios HomeWork escuchando en ${PORT}`))).catch(err => { console.error('DB init error:', err); app.listen(PORT, () => console.log(`Studios HomeWork escuchando en ${PORT} (DB pendiente)`)); });
