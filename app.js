require("dotenv").config();
const express = require("express");
const { AssistantService } = require("./src/services/assistant-service");
const { ChatHistoryService } = require("./src/services/chat-history-service");
const { FormatNumber } = require("./src/helpers/FormatNumber");
const { MessageService } = require("./src/services/message-service");
const { wasender } = require("./src/config/clients/wasenderapi-client");
const app = express();
const port = 5500;
const bodyParser = require("body-parser");
const {
	MessageWasendService,
} = require("./src/services/message-wasend-servide");

// app.use(express.json({ limit: "5mb" }));

app.use("/webhook", bodyParser.raw({ type: "*/*" }));

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

		if (event === "message") {
			const message = data.message;

			if (!message || !message.from || !message.body || !message.timestamp) {
				return res.sendStatus(400);
			}

			if (message.hasMedia || message.type !== "chat") {
				console.warn("⚠️ Mensaje con medios no manejado:", message);
				return res.sendStatus(200);
			}

			const phone = FormatNumber.formatBoliviaNumber(
				message.from.replace("@c.us", "")
			);
			const text = message.body;

			const newMessage = {
				role: "user",
				content: [{ type: "text", text: text.trim() }],
			};

			console.log(`📞 Procesando mensaje de: ${phone} con texto: "${text}"`);

			const { data: dataHistory } = await ChatHistoryService.getChatHistory({
				userId: phone,
			});

			if (dataHistory.error) {
				console.error(
					"❌ Error al obtener el historial de chat:",
					dataHistory.error
				);
				return res.status(500).json({ error: dataHistory.error });
			}

			const { automaticSend, chat } = dataHistory;

			await ChatHistoryService.updateChatHistory({
				userId: phone,
				data: { chat: [...dataHistory.chat, newMessage] },
			});

			if (automaticSend) {
				const { response } = await AssistantService.chatWithDocument({
					chat: [...chat, newMessage],
				});

				const responseMessage = await MessageService.sendMessage({
					phone: phone + "@c.us",
					message: response.content[0].text,
					instanceId: instanceId,
				});

				const chatHistoryUpdate = [
					...chat,
					newMessage,
					{
						role: response.role || "assistant",
						content: response.content || [
							{ type: "text", text: "Sin respuesta" },
						],
					},
				];

				const updateResponse = await ChatHistoryService.updateChatHistory({
					userId: phone,
					data: { chat: chatHistoryUpdate },
				});

				if (response.error) {
					console.error("❌ Error en el servicio:", response.error);
					return res.status(500).json({ error: response.error });
				}
			}
		} else {
			console.log(`⚠️ Evento no manejado: ${event}`);
		}

		res.sendStatus(200);
	} catch (error) {
		console.error("❌ Error procesando el webhook:", error);
		res.sendStatus(500);
	}
});

app.post("/webhook", async (req, res) => {
	if (!process.env.WASENDER_WEBHOOK_SECRET) {
		console.error("Webhook secret not configured.");
		return res.status(500).send("Webhook secret not configured.");
	}

	const adapter = {
		getHeader: (name) => req.header(name) || "",
		getRawBody: () => req.body.toString("utf8"),
	};

	try {
		const webhookEvent = await wasender.handleWebhookEvent(adapter);

		console.log("📦 Webhook recibido:", webhookEvent.event);

		switch (webhookEvent.event) {
			case "messages.upsert":
				const { key, message } = webhookEvent.data.messages;
				const { fromMe, remoteJid } = key;

				if (!message || !message.conversation) {
					console.warn("⚠️ Mensaje no válido:", key.id);
					return;
				}

				const text = message.conversation || "";
				const phone = remoteJid.replace("@s.whatsapp.net", "");

				if (fromMe) {
					console.log("📩 Mensaje enviado por nosotros, ignorando:", key.id);
					return res.sendStatus(200);
				}

				const formattedPhone = FormatNumber.formatBoliviaNumber(phone);

				const newMessage = {
					role: "user",
					content: [{ type: "text", text: text.trim() }],
				};

				const { response } = await AssistantService.chatWithDocument({
					chat: [newMessage],
				});

				console.log("🤖 Respuesta del asistente:", response);

				const responseMessage = await MessageWasendService.sendMessage({
					phone: formattedPhone,
					message: response.content[0].text,
				});

				console.log(
					`📞 Mensaje procesado y respuesta enviada a: ${formattedPhone}`
				);

				break;

			default:
				console.warn("⚠️ Evento no manejado:", webhookEvent.event);
		}

		res.sendStatus(200);
	} catch (error) {
		console.error("❌ Error genérico al procesar webhook:", error);
		res.sendStatus(500);
	}
});

app.listen(port, () => {
	console.log(`🚀 Webhook escuchando en http://localhost:${port}`);
});
