const { wasender } = require("../config/clients/wasenderapi-client");
const { FormatNumber } = require("../helpers/FormatNumber");
const { ChatHistoryService } = require("../services/chat-history-service");
const MessageQueueService = require("../services/messagesQueueService");

class WebhookController {
  static async handleWebhook(req, res) {
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

      switch (webhookEvent.event) {
        case "messages.upsert":
          await WebhookController.handleMessageUpsert(
            webhookEvent.data.messages
          );
          break;
        default:
          console.warn("Evento no manejado:", webhookEvent.event);
      }

      res.sendStatus(200);
    } catch (error) {
      console.error("Error en webhook:", error);
      res.sendStatus(500);
    }
  }

  static async handleMessageUpsert(messageData) {
    const { key, message } = messageData;
    const { fromMe, remoteJid } = key;

    if (!message) {
      console.warn("Mensaje no válido:", key.id);
      return;
    }

    const text =
      message.conversation || message.extendedTextMessage?.text || "";
    if (!text.trim()) {
      console.warn("Texto vacío, ignorando mensaje");
      return;
    }

    const phone = remoteJid.replace("@s.whatsapp.net", "");
    const formattedPhone = FormatNumber.formatBoliviaNumber(phone);

    if (fromMe) {
      return;
    }
    const newMessage = {
      role: "user",
      content: [{ type: "text", text: text.trim() }],
    };
    try {
      const { data: dataHistory } = await ChatHistoryService.getChatHistory({
        userId: formattedPhone,
      });

      const currentChat = Array.isArray(dataHistory?.chat)
        ? dataHistory.chat
        : [];
      const updatedChat = [...currentChat, newMessage];

      await ChatHistoryService.updateChatHistory({
        userId: formattedPhone,
        data: { chat: updatedChat },
      });

      MessageQueueService.addToQueue(formattedPhone, newMessage);
    } catch (error) {
      console.error(`Error procesando mensaje de ${formattedPhone}:`, error);
    }
  }
}

module.exports = WebhookController;
