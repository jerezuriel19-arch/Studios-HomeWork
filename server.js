import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { MercadoPagoConfig, Preference } from "mercadopago";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const plans = {
  monthly: { title: "Studios HomeWork PRO - 1 mes", price: 3990 },
  quarterly: { title: "Studios HomeWork PRO - 3 meses", price: 9000 },
  annual: { title: "Studios HomeWork PRO - 1 año", price: 33900 }
};

app.get("/health", (req, res) => {
  res.json({ ok: true, mercadopago_configured: Boolean(MP_ACCESS_TOKEN) });
});

app.post("/api/create-preference", async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: "Mercado Pago no está configurado en el servidor." });
    }

    const selectedPlan = plans[req.body.plan];

    if (!selectedPlan) {
      return res.status(400).json({ error: "Plan inválido." });
    }

    const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    const preference = new Preference(client);

    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const baseUrl = `${protocol}://${req.get("host")}`;

    const response = await preference.create({
      body: {
        items: [{
          id: `shw-${req.body.plan}`,
          title: selectedPlan.title,
          quantity: 1,
          currency_id: "ARS",
          unit_price: selectedPlan.price
        }],
        external_reference: `studios-homework-${req.body.plan}-${Date.now()}`,
        back_urls: {
          success: `${baseUrl}/?payment=success`,
          failure: `${baseUrl}/?payment=failure`,
          pending: `${baseUrl}/?payment=pending`
        },
        auto_return: "approved"
      }
    });

    return res.json({ id: response.id, init_point: response.init_point });
  } catch (error) {
    console.error("Mercado Pago error:", error);
    return res.status(500).json({ error: "No se pudo crear el checkout de Mercado Pago." });
  }
});

// Fallback compatible con Express 5.
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api/") || req.path === "/health") return next();
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Studios HomeWork escuchando en el puerto ${PORT}`);
});
