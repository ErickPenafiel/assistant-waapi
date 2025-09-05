const { AssistantService } = require("./assistant-service");
const { ChatHistoryService } = require("./chat-history-service");
const { MessageWasendService } = require("./message-wasend-servide");

class MessageProcessorService {
  static async processMessages(formattedPhone) {
    const { data: dataHistory } = await ChatHistoryService.getChatHistory({
      userId: formattedPhone,
    });

    const currentChat = Array.isArray(dataHistory?.chat)
      ? dataHistory.chat
      : [];

    if (currentChat.length === 0) {
      console.warn(`No hay mensajes para procesar: ${formattedPhone}`);
      return;
    }
    const { status } = await AssistantService.getStatusAssistant({
      name: process.env.NAME_ASSISTANT,
    });

    if (!status?.automaticSend) {
      console.log("Envío automático desactivado");
      return;
    }
    const { config } = await AssistantService.getConfigAssistant({
      name: process.env.NAME_ASSISTANT,
    });
    const systemPrompt = config?.prompt || "";
    const promptSystem = {
      role: "user",
      content: [{ type: "text", text: systemPrompt }],
    };
    const { response } = await AssistantService.chatWithDocument({
      chat: promptSystem ? [promptSystem, ...currentChat] : currentChat,
    });

    if (!Array.isArray(response?.content)) {
      console.warn("Respuesta no válida");
      return;
    }
    await MessageWasendService.sendMessage({
      phone: formattedPhone,
      message: response.content[0]?.text || "Sin respuesta",
    });
    const finalChatHistory = [
      ...currentChat,
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
      data: { chat: finalChatHistory },
    });

    console.log(`Respuesta enviada a: ${formattedPhone}`);
  }
}

module.exports = MessageProcessorService;
