import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import pg from "pg";
import bcrypt from "bcryptjs";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || "";

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const plans = {
  monthly: { title: "Studios HomeWork PRO - 1 mes", price: 3990, months: 1 },
  quarterly: { title: "Studios HomeWork PRO - 3 meses", price: 9000, months: 3 },
  annual: { title: "Studios HomeWork PRO - 1 año", price: 33900, months: 12 }
};

function requireDb(res) {
  if (!pool) {
    res.status(503).json({ error: "La base de datos todavía no está configurada en Render." });
    return false;
  }
  return true;
}

function cookieToken(req) {
  const raw = req.headers.cookie || "";
  const m = raw.match(/(?:^|;\s*)shw_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function getUser(req) {
  if (!pool) return null;
  const token = cookieToken(req);
  if (!token) return null;
  const { rows } = await pool.query(`
    SELECT u.id, u.email, u.pro_until, s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=$1 AND s.expires_at > NOW()
  `, [token]);
  if (!rows[0]) return null;
  const u = rows[0];
  const proUntil = u.pro_until ? new Date(u.pro_until) : null;
  return {
    id: u.id,
    email: u.email,
    proActive: !!(proUntil && proUntil > new Date()),
    proUntil: proUntil ? proUntil.toISOString() : null
  };
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, proActive: u.proActive, proUntil: u.proUntil };
}

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query("INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')", [token, userId]);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `shw_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
}

async function initDb() {
  if (!pool) {
    console.warn("DATABASE_URL no configurada: cuentas y PRO persistente estarán deshabilitados.");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      pro_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      payment_id TEXT UNIQUE NOT NULL,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      plan TEXT,
      status TEXT,
      amount NUMERIC(12,2),
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

app.get("/health", (req, res) => {
  res.json({ ok: true, mercadopago_configured: Boolean(MP_ACCESS_TOKEN), database_configured: Boolean(DATABASE_URL) });
});

app.get("/api/auth/me", async (req, res) => {
  if (!requireDb(res)) return;
  try { res.json({ user: publicUser(await getUser(req)) }); }
  catch (e) { console.error(e); res.status(500).json({ error: "No se pudo consultar la cuenta." }); }
});

app.post("/api/auth/register", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return res.status(400).json({ error: "Ingresá un correo válido." });
    if (password.length < 8) return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email,pro_until", [email, hash]);
    await createSession(rows[0].id, res);
    res.status(201).json({ user: { id: rows[0].id, email: rows[0].email, proActive: false, proUntil: null } });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Ese correo ya está registrado." });
    console.error(e); res.status(500).json({ error: "No se pudo crear la cuenta." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const { rows } = await pool.query("SELECT id,email,password_hash,pro_until FROM users WHERE email=$1", [email]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error: "Correo o contraseña incorrectos." });
    await createSession(rows[0].id, res);
    const until = rows[0].pro_until ? new Date(rows[0].pro_until) : null;
    res.json({ user: { id: rows[0].id, email: rows[0].email, proActive: !!(until && until > new Date()), proUntil: until ? until.toISOString() : null } });
  } catch (e) { console.error(e); res.status(500).json({ error: "No se pudo iniciar sesión." }); }
});

app.post("/api/auth/logout", async (req, res) => {
  if (pool) { const token = cookieToken(req); if (token) await pool.query("DELETE FROM sessions WHERE token=$1", [token]); }
  res.setHeader("Set-Cookie", "shw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

app.post("/api/create-preference", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: "Mercado Pago no está configurado." });
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Iniciá sesión antes de comprar PRO." });
    if (user.proActive) return res.status(409).json({ error: "Tu cuenta ya tiene PRO activo." });
    const planKey = String(req.body.plan || "");
    const plan = plans[planKey];
    if (!plan) return res.status(400).json({ error: "Plan inválido." });
    const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    const preference = new Preference(client);
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const baseUrl = `${protocol}://${req.get("host")}`;
    const response = await preference.create({ body: {
      items: [{ id: `shw-${planKey}`, title: plan.title, quantity: 1, currency_id: "ARS", unit_price: plan.price }],
      external_reference: `shw:${user.id}:${planKey}:${crypto.randomUUID()}`,
      back_urls: { success: `${baseUrl}/?payment=success`, failure: `${baseUrl}/?payment=failure`, pending: `${baseUrl}/?payment=pending` },
      auto_return: "approved"
    }});
    res.json({ id: response.id, init_point: response.init_point });
  } catch (e) { console.error("Mercado Pago preference error:", e); res.status(500).json({ error: "No se pudo crear el checkout de Mercado Pago." }); }
});

function validWebhook(req) {
  if (!MP_WEBHOOK_SECRET) return true;
  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];
  const dataId = String(req.body?.data?.id || req.query?.data_id || "");
  if (!signature || !requestId || !dataId) return false;
  const parts = Object.fromEntries(String(signature).split(",").map(x => x.split("=")).filter(x => x.length === 2));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac("sha256", MP_WEBHOOK_SECRET).update(manifest).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1)); } catch { return false; }
}

app.post("/api/mercadopago/webhook", async (req, res) => {
  try {
    if (!pool || !MP_ACCESS_TOKEN) return res.sendStatus(200);
    if (!validWebhook(req)) return res.status(401).send("invalid signature");
    const type = req.body?.type || req.query?.type;
    const paymentId = String(req.body?.data?.id || req.query?.data_id || "");
    if (type && type !== "payment") return res.sendStatus(200);
    if (!paymentId) return res.sendStatus(200);
    const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    const paymentApi = new Payment(client);
    const payment = await paymentApi.get({ id: paymentId });
    const external = String(payment.external_reference || "");
    const m = external.match(/^shw:(\d+):(monthly|quarterly|annual):/);
    const userId = m ? Number(m[1]) : null;
    const planKey = m ? m[2] : null;
    const status = String(payment.status || "");
    await pool.query(`INSERT INTO payments(payment_id,user_id,plan,status,amount,raw) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(payment_id) DO UPDATE SET status=EXCLUDED.status, raw=EXCLUDED.raw`, [paymentId, userId, planKey, status, payment.transaction_amount || null, payment]);
    if (status === "approved" && userId && planKey) {
      const months = plans[planKey].months;
      await pool.query(`UPDATE users SET pro_until = GREATEST(COALESCE(pro_until,NOW()),NOW()) + ($2 || ' months')::interval WHERE id=$1`, [userId, String(months)]);
    }
    res.sendStatus(200);
  } catch (e) { console.error("Webhook error:", e); res.sendStatus(200); }
});

app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api/") || req.path === "/health") return next();
  res.sendFile(path.join(__dirname, "index.html"));
});

initDb().then(() => app.listen(PORT, "0.0.0.0", () => console.log(`Studios HomeWork escuchando en ${PORT}`))).catch(err => { console.error("Database initialization failed:", err); process.exit(1); });
