require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const port = process.env.PORT || 5500;

const { AssistantService } = require("./src/services/assistant-service");
const { ChatHistoryService } = require("./src/services/chat-history-service");
const { FormatNumber } = require("./src/helpers/FormatNumber");
const {
	MessageWasendService,
} = require("./src/services/message-wasend-servide");
const { wasender } = require("./src/config/clients/wasenderapi-client");

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
					return res.sendStatus(200);
				}

				const text =
					message.conversation ||
					(message.extendedTextMessage?.text ?? "") ||
					"";

				if (!text.trim()) {
					console.warn("⚠️ Texto vacío, se ignora el mensaje");
					return res.sendStatus(200);
				}

				const phone = remoteJid.replace("@s.whatsapp.net", "");
				const formattedPhone = FormatNumber.formatBoliviaNumber(phone);

				if (fromMe) {
					console.log("📩 Mensaje enviado por nosotros, ignorando:", key.id);
					return res.sendStatus(200);
				}

				const newMessage = {
					role: "user",
					content: [{ type: "text", text: text.trim() }],
				};

				const { data: dataHistory } = await ChatHistoryService.getChatHistory({
					userId: formattedPhone,
				});

				const currentChat = Array.isArray(dataHistory?.chat)
					? dataHistory.chat
					: [];

				await ChatHistoryService.updateChatHistory({
					userId: formattedPhone,
					data: { chat: [...currentChat, newMessage] },
				});

				console.log(
					`📥 Mensaje recibido de: ${formattedPhone}`,
					newMessage,
					currentChat
				);

				const { status } = await AssistantService.getStatusAssistant({
					name: process.env.NAME_ASSISTANT,
				});

				if (!status?.automaticSend) {
					console.log(
						"⚠️ Envío automático desactivado para el asistente:",
						process.env.NAME_ASSISTANT
					);
					return res.sendStatus(200);
				}

				const data = await AssistantService.getConfigAssistant({});

				const systemPrompt = data?.prompt || "";

				const promptSystem = {
					role: "user",
					content: systemPrompt,
				};

				console.log({
					promptSystem,
				});

				const { response } = await AssistantService.chatWithDocument({
					chat: promptSystem ? [promptSystem, newMessage] : [newMessage],
				});

				if (!Array.isArray(response?.content)) {
					console.warn("⚠️ La respuesta no tiene contenido válido:", response);
					return res.sendStatus(200);
				}

				await MessageWasendService.sendMessage({
					phone: formattedPhone,
					message: response.content[0]?.text || "Sin respuesta",
				});

				console.log(
					`📞 Mensaje procesado y respuesta enviada a: ${formattedPhone}`
				);

				const chatHistoryUpdate = [
					...currentChat,
					newMessage,
					{
						role: response.role || "assistant",
						content:
							response.content.length > 0
								? response.content
								: [{ type: "text", text: "Sin respuesta" }],
					},
				];

				await ChatHistoryService.updateChatHistory({
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
