import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MercadoPagoConfig, Preference } from "mercadopago";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

const plans = {
  monthly: { title: "Studios HomeWork PRO - 1 mes", price: 3990 },
  quarterly: { title: "Studios HomeWork PRO - 3 meses", price: 9000 },
  annual: { title: "Studios HomeWork PRO - 1 año", price: 33900 }
};

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Studios HomeWork",
    mercadopagoConfigured: Boolean(MP_ACCESS_TOKEN)
  });
});

app.post("/api/create-preference", async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: "Falta configurar MP_ACCESS_TOKEN en Render." });
    }

    const planKey = String(req.body?.plan || "");
    const plan = plans[planKey];
    if (!plan) return res.status(400).json({ error: "Plan inválido." });

    const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    const preference = new Preference(client);
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const result = await preference.create({
      body: {
        items: [{
          title: plan.title,
          quantity: 1,
          currency_id: "ARS",
          unit_price: plan.price
        }],
        external_reference: `studios-homework-${planKey}-${Date.now()}`,
        back_urls: {
          success: `${baseUrl}/?payment=success&plan=${planKey}`,
          failure: `${baseUrl}/?payment=failure&plan=${planKey}`,
          pending: `${baseUrl}/?payment=pending&plan=${planKey}`
        },
        auto_return: "approved"
      }
    });

    res.json({ id: result.id, init_point: result.init_point });
  } catch (error) {
    console.error("Mercado Pago preference error:", error);
    res.status(500).json({ error: "Mercado Pago no pudo crear la preferencia." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Studios HomeWork escuchando en el puerto ${PORT}`);
});
