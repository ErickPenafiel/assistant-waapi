require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const express = require("express");
const { AssistantService } = require("./src/services/assistant-service");
const { ChatHistoryService } = require("./src/services/chat-history-service");
const { FormatNumber } = require("./src/helpers/FormatNumber");
const { MessageService } = require("./src/services/message-service");
const { wasender } = require("./src/config/clients/wasenderapi-client");
const app = express();
const port = process.env.PORT || 5500;
const bodyParser = require("body-parser");
const {
	MessageWasendService,
} = require("./src/services/message-wasend-servide");

app.get("/", (req, res) => {
	res.send(`🚀 Webhook is running! ${process.env.NAME_ASSISTANT}`);
});

app.use("/webhook", bodyParser.raw({ type: "*/*" }));

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

				if (!message) {
					console.warn("⚠️ Mensaje no válido:", key.id);
					return;
				}

				const text =
					message.conversation || message.extendedTextMessage.text || "";
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

				const { data: dataHistory } = await ChatHistoryService.getChatHistory({
					userId: formattedPhone,
				});

				await ChatHistoryService.updateChatHistory({
					userId: formattedPhone,
					data: { chat: [...dataHistory.chat, newMessage] },
				});

				const { chat } = dataHistory;

				console.log(
					`📥 Mensaje recibido de: ${formattedPhone}`,
					newMessage,
					chat
				);

				const { status } = await AssistantService.getStatusAssistant({
					name: process.env.NAME_ASSISTANT,
				});

				if (status.automaticSend === false) {
					console.log(
						"⚠️ Envío automático desactivado para el asistente:",
						name
					);
					return res.sendStatus(200);
				}

				const { response } = await AssistantService.chatWithDocument({
					chat: [newMessage],
				});

				const responseMessage = await MessageWasendService.sendMessage({
					phone: formattedPhone,
					message: response.content[0].text,
				});

				console.log(
					`📞 Mensaje procesado y respuesta enviada a: ${formattedPhone}`
				);

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
					userId: formattedPhone,
					data: { chat: chatHistoryUpdate },
				});

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
