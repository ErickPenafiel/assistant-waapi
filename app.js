const { AssistantService } = require("./src/services/assistant-service");
require("dotenv").config();
const express = require("express");
const app = express();
const port = 5500;

const securityTokens = {
	41632: "Pm9z2ZENJ4u3eyjTNO3JNpuNMGSmIIP0",
};

app.use(express.json());

app.post("/webhooks/:security_token", async (req, res) => {
	try {
		const securityToken = req.params.security_token;
		const { instanceId, event, data } = req.body;

		if (!instanceId || !event || !data) {
			console.warn("❌ Error al conectar a la instancia:", req.body);
			return res.sendStatus(400);
		}

		// const securityTokenEnv = process.env[instanceId];
		// if (!securityTokenEnv) {
		// 	console.warn("Unauhtorized access", instanceId);
		// 	return res.sendStatus(401);
		// }

		// const expectedToken = securityTokenEnv.trim();
		const expectedToken = securityTokens[instanceId];

		if (!expectedToken || expectedToken !== securityToken) {
			console.warn("❌ Token inválido para instancia:", instanceId);
			return res.sendStatus(401);
		}

		console.log(`📨 Evento recibido: ${event} para instancia ${instanceId}`);
		console.log("📝 Cuerpo completo:", JSON.stringify(req.body, null, 2));

		if (event === "message") {
			const message = data.message;

			if (!message || !message.from || !message.body || !message.timestamp) {
				console.warn("⚠️ Mensaje malformado:", message);
				return res.sendStatus(400);
			}

			const phone = message.from.replace("@c.us", "");
			const text = message.body;
			const timestamp = new Date(message.timestamp * 1000);

			console.log(`✅ Mensaje de ${phone}: "${text}" a las ${timestamp}`);
		} else {
			// Puedes manejar más eventos si quieres (qr, ready, etc.)
			console.log(`⚠️ Evento no manejado: ${event}`);
		}

		// ✅ Todo fue bien
		res.sendStatus(200);
	} catch (error) {
		console.error("❌ Error procesando el webhook:", error);
		res.sendStatus(500);
	}
});

app.listen(port, () => {
	console.log(`🚀 Webhook escuchando en http://localhost:${port}`);
});
