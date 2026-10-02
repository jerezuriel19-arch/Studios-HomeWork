STUDIOS HOMEWORK — CUENTAS + PRO

IMPORTANTE: index.html es la versión sana original. No editarlo.

Render:
Build Command: npm install
Start Command: npm start

Variables:
DATABASE_URL = la URL de PostgreSQL de Render (idealmente vinculada al servicio)
MP_ACCESS_TOKEN = tu Access Token de Mercado Pago
MP_WEBHOOK_SECRET = la clave secreta de Webhooks de Mercado Pago
APP_URL = https://studios-homework.onrender.com
NODE_ENV = production

Mercado Pago Webhook:
https://studios-homework.onrender.com/api/mercadopago/webhook
Activar evento Payments en la aplicación de Mercado Pago.

La cuenta se guarda en PostgreSQL. PRO se activa únicamente cuando el backend recibe y valida el webhook de Mercado Pago y consulta el pago aprobado.
