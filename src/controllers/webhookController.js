const { wasender } = require("../config/clients/wasenderapi-client");
const { FormatNumber } = require("../helpers/FormatNumber");
const { ChatHistoryService } = require("../services/chat-history-service");
const { AudioService } = require("../services/audio-service");
const MessageQueueService = require("../services/messagesQueueService");

const webhookSecret =
  process.env.WHATSAPP_WEBHOOK_SECRET || process.env.WASENDER_WEBHOOK_SECRET;

class WebhookController {
  static async handleWebhook(req, res) {
    if (!webhookSecret) {
      console.error("Webhook secret not configured.");
      return res.status(500).send("Webhook secret not configured.");
    }

    const adapter = {
      getHeader: (name) => req.header(name) || "",
      getRawBody: () => req.body,
    };

    try {
      const webhookEvent = await wasender.handleWebhookEvent(adapter);
      console.log("Evento recibido:", webhookEvent?.event);

      switch (webhookEvent.event) {
        case "message.received":
          await WebhookController.handleMessageReceived(webhookEvent.data);
          break;
        case "messages.upsert":
          await WebhookController.handleLegacyUpsert(webhookEvent.data?.messages);
          break;
        case "message.sent":
        case "message.status":
          console.log(
            `Evento ${webhookEvent.event} recibido para mensaje ${
              webhookEvent.data?.messageId || "desconocido"
            }`
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

  static async handleMessageReceived(messageData) {
    if (!messageData) {
      console.warn("Payload de message.received vacío");
      return;
    }

    if (messageData.direction && messageData.direction !== "inbound") {
      console.log("Mensaje no inbound, se ignora:", messageData.direction);
      return;
    }

    const rawPhone = String(messageData.fromNumber || "")
      .replace("@c.us", "")
      .replace("@s.whatsapp.net", "")
      .replace(/\s+/g, "");

    const formattedPhone = FormatNumber.formatBoliviaNumber(rawPhone);

    if (!formattedPhone) {
      console.warn("No se pudo formatear el número", messageData.fromNumber);
      return;
    }

    const messageType = messageData.messageType || "text";
    let userMessage = null;

    if (messageType === "audio") {
      try {
        const content = messageData.content || {};
        const audioMessage = {
          base64Data: content.base64Data,
          mediaUrl: content.mediaUrl,
          url: content.mediaUrl,
          mimetype: content.mimeType || content.mimetype,
          fileName: content.fileName,
        };

        const transcribedText = await AudioService.processIncomingAudio({
          audioMessage,
          messageId: messageData.messageId || messageData.id,
        });

        if (!transcribedText) {
          console.warn("No se pudo transcribir el audio entrante");
          return;
        }

        userMessage = {
          role: "user",
          content: [{ type: "text", text: transcribedText }],
        };
      } catch (error) {
        console.error(
          `Error procesando audio de ${formattedPhone}:`,
          error
        );
        return;
      }
    } else {
      const text =
        messageData.content?.text ||
        messageData.body ||
        messageData.message ||
        "";

      if (!text || !text.trim()) {
        console.warn("Texto vacío en message.received, se omite");
        return;
      }

      userMessage = {
        role: "user",
        content: [{ type: "text", text: text.trim() }],
      };
    }

    try {
      const { data: dataHistory } = await ChatHistoryService.getChatHistory({
        userId: formattedPhone,
      });

      const currentChat = Array.isArray(dataHistory?.chat)
        ? dataHistory.chat
        : [];
      const updatedChat = [...currentChat, userMessage];

      await ChatHistoryService.updateChatHistory({
        userId: formattedPhone,
        data: { chat: updatedChat },
      });

      MessageQueueService.addToQueue(formattedPhone, userMessage, {
        originalMessageType: messageType,
      });
    } catch (error) {
      console.error(
        `Error persistiendo mensaje de ${formattedPhone}:`,
        error
      );
    }
  }

  static async handleLegacyUpsert(messageData) {
    if (!messageData) {
      return;
    }

    const { key, message } = messageData;
    const { fromMe, remoteJid } = key || {};

    if (!message) {
      console.warn("Mensaje legacy inválido:", key?.id);
      return;
    }

    const phone = (remoteJid || "").replace("@s.whatsapp.net", "");
    const formattedPhone = FormatNumber.formatBoliviaNumber(phone);

    if (fromMe) {
      return;
    }

    let newMessage;
    let messageType = "text";

    if (message.audioMessage) {
      messageType = "audio";
      try {
        const transcribedText = await AudioService.processIncomingAudio({
          audioMessage: message.audioMessage,
          messageId: key?.id,
        });

        if (!transcribedText) {
          console.warn("No se pudo transcribir el audio");
          return;
        }

        newMessage = {
          role: "user",
          content: [{ type: "text", text: transcribedText }],
        };
      } catch (error) {
        console.error(`Error procesando audio de ${formattedPhone}:`, error);
        return;
      }
    } else {
      const text =
        message.conversation || message.extendedTextMessage?.text || "";
      if (!text.trim()) {
        console.warn("Texto vacío, ignorando mensaje legacy");
        return;
      }

      newMessage = {
        role: "user",
        content: [{ type: "text", text: text.trim() }],
      };
    }

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

      MessageQueueService.addToQueue(formattedPhone, newMessage, {
        originalMessageType: messageType,
      });
    } catch (error) {
      console.error(`Error procesando mensaje legacy de ${formattedPhone}:`, error);
    }
  }
}

module.exports = WebhookController;
