require("dotenv").config();
const express = require("express");
const { AssistantService } = require("./src/services/assistant-service");
const app = express();
const port = 5500;

app.use(express.json());

app.post("/", async (req, res) => {
	try {
		console.log("📨 Petición recibida:", req.body);
		const { phone, text } = req.body;

		if (!phone || !text) {
			console.warn("❌ Petición inválida:", req.body);
			return res.sendStatus(400);
		}

		const response = await AssistantService.chatWithDocument({ phone, text });

		if (response.error) {
			console.error("❌ Error en el servicio:", response.error);
			return res.status(500).json({ error: response.error });
		}

		console.log("✅ Respuesta generada:", response);
		res.json(response);
	} catch (error) {
		console.error("❌ Error procesando la petición:", error);
		res.sendStatus(500);
	}
});

app.post("/webhooks/:security_token", async (req, res) => {
	try {
		const securityToken = req.params.security_token;
		const { instanceId, event, data } = req.body;

		if (!instanceId || !event || !data) {
			console.warn("❌ Petición inválida:", req.body);
			return res.sendStatus(400);
		}

		const envKey = `ST_${instanceId}`;
		const expectedToken = process.env[envKey];

		if (!expectedToken || expectedToken.trim() !== securityToken) {
			console.warn("❌ Token inválido para instancia:", instanceId);
			return res.sendStatus(401);
		}

		console.log(`📨 Evento recibido: ${event} para instancia ${instanceId}`);

		if (event === "message") {
			const message = data.message;

			if (!message || !message.from || !message.body || !message.timestamp) {
				// console.warn("⚠️ Mensaje malformado:", message);
				return res.sendStatus(400);
			}

			const phone = message.from.replace("@c.us", "");
			const text = message.body;
			const timestamp = new Date(message.timestamp * 1000);

			console.log(`✅ Mensaje de ${phone}: "${text}" a las ${timestamp}`);
		} else {
			console.log(`⚠️ Evento no manejado: ${event}`);
		}

		res.sendStatus(200);
	} catch (error) {
		console.error("❌ Error procesando el webhook:", error);
		res.sendStatus(500);
	}
});

app.listen(port, () => {
	console.log(`🚀 Webhook escuchando en http://localhost:${port}`);
});
