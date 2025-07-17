require("dotenv").config();
const express = require("express");
const { AssistantService } = require("./src/services/assistant-service");
const { ChatHistoryService } = require("./src/services/chat-history-service");
const { FormatNumber } = require("./src/helpers/FormatNumber");
const { MessageService } = require("./src/services/message-service");
const app = express();
const port = 5500;

app.use(express.json({ limit: "5mb" }));

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

app.listen(port, () => {
	console.log(`🚀 Webhook escuchando en http://localhost:${port}`);
});
