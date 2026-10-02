import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import pg from "pg";
import { MercadoPagoConfig, Preference } from "mercadopago";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_DAYS = 30;

const plans = {
  monthly: { title: "Studios HomeWork PRO - 1 mes", price: 3990, months: 1 },
  quarterly: { title: "Studios HomeWork PRO - 3 meses", price: 9000, months: 3 },
  annual: { title: "Studios HomeWork PRO - 1 año", price: 33900, months: 12 }
};

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined
    })
  : null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  res.setHeader(
    "Set-Cookie",
    `shw_session=${encodeURIComponent(token)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "shw_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax" +
      (process.env.NODE_ENV === "production" ? "; Secure" : "")
  );
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
  return `${salt}:${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [salt, hashHex] = String(stored || "").split(":");
  if (!salt || !hashHex) return false;
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
  const a = Buffer.from(hashHex, "hex");
  const b = Buffer.from(derived);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function initDb() {
  if (!pool) throw new Error("DATABASE_URL no está configurada.");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      pro_plan TEXT,
      pro_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id BIGSERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      payment_id TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      amount NUMERIC(12,2),
      external_reference TEXT,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions(token);
    CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id);
  `);
}

async function getCurrentUser(req) {
  if (!pool) return null;
  const token = parseCookies(req).shw_session;
  if (!token) return null;

  const result = await pool.query(
    `SELECT u.id, u.email, u.pro_plan, u.pro_expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );

  if (!result.rows[0]) return null;
  const u = result.rows[0];
  const isPro = Boolean(u.pro_expires_at && new Date(u.pro_expires_at).getTime() > Date.now());

  return {
    id: u.id,
    email: u.email,
    isPro,
    proPlan: isPro ? u.pro_plan : null,
    proExpiresAt: isPro ? u.pro_expires_at : null
  };
}

async function requireUser(req, res, next) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Debés iniciar sesión." });
    req.user = user;
    next();
  } catch (error) {
    console.error("Auth error:", error);
    res.status(500).json({ error: "No se pudo consultar la cuenta." });
  }
}

app.get("/health", async (req, res) => {
  let db = false;
  if (pool) {
    try {
      await pool.query("SELECT 1");
      db = true;
    } catch {}
  }
  res.json({
    ok: true,
    database_configured: Boolean(DATABASE_URL),
    database_connected: db,
    mercadopago_configured: Boolean(MP_ACCESS_TOKEN)
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !email.includes("@")) return res.status(400).json({ error: "Email inválido." });
    if (password.length < 8) return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });

    const passwordHash = await hashPassword(password);
    const created = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       RETURNING id, email`,
      [email, passwordHash]
    );

    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [token, created.rows[0].id]
    );
    setSessionCookie(res, token, SESSION_DAYS * 86400);

    res.json({ ok: true, email: created.rows[0].email, isPro: false });
  } catch (error) {
    if (error?.code === "23505") return res.status(409).json({ error: "Ese email ya está registrado." });
    console.error("Register error:", error);
    res.status(500).json({ error: "No se pudo crear la cuenta." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT id, email, password_hash FROM users WHERE email = $1`,
      [email]
    );
    const user = result.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "Email o contraseña incorrectos." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [token, user.id]
    );
    setSessionCookie(res, token, SESSION_DAYS * 86400);

    res.json({ ok: true, email: user.email });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "No se pudo iniciar sesión." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = parseCookies(req).shw_session;
    if (token && pool) await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    console.error("Logout error:", error);
    clearSessionCookie(res);
    res.json({ ok: true });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.json({ loggedIn: false, isPro: false, email: "" });
    res.json({
      loggedIn: true,
      isPro: user.isPro,
      email: user.email,
      proPlan: user.proPlan,
      proExpiresAt: user.proExpiresAt
    });
  } catch (error) {
    console.error("Me error:", error);
    res.status(500).json({ error: "Base de datos no disponible." });
  }
});

app.post("/api/create-preference", requireUser, async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: "Mercado Pago no está configurado en el servidor." });
    }

    const planKey = String(req.body.plan || "");
    const selectedPlan = plans[planKey];
    if (!selectedPlan) return res.status(400).json({ error: "Plan inválido." });

    const random = crypto.randomBytes(8).toString("hex");
    const externalReference = `shw:${req.user.id}:${planKey}:${random}`;

    const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    const preference = new Preference(client);

    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const baseUrl = `${protocol}://${req.get("host")}`;

    const response = await preference.create({
      body: {
        items: [{
          id: `shw-${planKey}`,
          title: selectedPlan.title,
          quantity: 1,
          currency_id: "ARS",
          unit_price: selectedPlan.price
        }],
        external_reference: externalReference,
        back_urls: {
          success: `${baseUrl}/?payment=success`,
          failure: `${baseUrl}/?payment=failure`,
          pending: `${baseUrl}/?payment=pending`
        },
        auto_return: "approved",
        notification_url: `${baseUrl}/api/mercadopago/webhook`
      }
    });

    res.json({ id: response.id, init_point: response.init_point });
  } catch (error) {
    console.error("Mercado Pago preference error:", error);
    res.status(500).json({ error: "No se pudo crear el checkout de Mercado Pago." });
  }
});

async function fetchMercadoPagoPayment(paymentId) {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
  });
  if (!response.ok) throw new Error(`Mercado Pago respondió ${response.status}`);
  return response.json();
}

app.post("/api/mercadopago/webhook", async (req, res) => {
  // Respond quickly; Mercado Pago retries notifications when it does not receive a 2xx.
  res.sendStatus(200);

  try {
    if (!MP_ACCESS_TOKEN || !pool) return;

    const paymentId =
      req.body?.data?.id ||
      req.body?.id ||
      req.query?.["data.id"] ||
      req.query?.id;

    if (!paymentId) return;

    const payment = await fetchMercadoPagoPayment(paymentId);
    const status = String(payment.status || "");
    const externalReference = String(payment.external_reference || "");

    const match = externalReference.match(/^shw:(\d+):(monthly|quarterly|annual):([a-f0-9]+)$/);
    if (!match) return;

    const userId = Number(match[1]);
    const planKey = match[2];
    const selectedPlan = plans[planKey];
    if (!selectedPlan) return;

    await pool.query(
      `INSERT INTO payments
        (payment_id, user_id, plan, status, amount, external_reference, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = 'approved' THEN NOW() ELSE NULL END)
       ON CONFLICT (payment_id)
       DO UPDATE SET status = EXCLUDED.status,
                     amount = EXCLUDED.amount,
                     external_reference = EXCLUDED.external_reference,
                     approved_at = CASE
                       WHEN EXCLUDED.status = 'approved' THEN COALESCE(payments.approved_at, NOW())
                       ELSE payments.approved_at
                     END`,
      [String(payment.id), userId, planKey, status, Number(payment.transaction_amount || selectedPlan.price), externalReference]
    );

    if (status !== "approved") return;

    await pool.query(
      `UPDATE users
          SET pro_plan = $1,
              pro_expires_at = CASE
                WHEN pro_expires_at IS NOT NULL AND pro_expires_at > NOW()
                  THEN pro_expires_at + ($2 || ' months')::interval
                ELSE NOW() + ($2 || ' months')::interval
              END
        WHERE id = $3`,
      [planKey, String(selectedPlan.months), userId]
    );

    console.log(`PRO activado: user=${userId}, plan=${planKey}, payment=${payment.id}`);
  } catch (error) {
    console.error("Mercado Pago webhook error:", error);
  }
});

// Compatible con Express 5.
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api/") || req.path === "/health") return next();
  res.sendFile(path.join(__dirname, "index.html"));
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Studios HomeWork escuchando en el puerto ${PORT}`);
    });
  } catch (error) {
    console.error("No se pudo iniciar la base de datos:", error);
    process.exit(1);
  }
}

start();
