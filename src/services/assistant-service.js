require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const { cohereClient } = require("../config/clients/cohere-client.js");
const { qdrantClient } = require("../config/clients/qdrant-client.js");
const { ChatHistoryService } = require("./chat-history-service.js");
const { EmbeddingsService } = require("./embeddings-service.js");
const { randomUUID } = require("crypto");
const { db } = require("../config/firebase/config.js");
function formatForWhatsApp(text) {
  if (!text) return text;
  console.log("Texto original:", text);
  console.log(typeof text);
  // Limpiar headers de markdown (##, ###, etc.)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // Convertir texto en negrita (**texto**) a mayúsculas o dejarlo sin formato
  text = text.replace(/\*\*(.+?)\*\*/g, "$1"); // Quita los asteriscos
  // O si prefieres mayúsculas: text = text.replace(/\*\*(.+?)\*\*/g, (match, p1) => p1.toUpperCase());

  // Limpiar texto en cursiva (*texto*)
  text = text.replace(/\*(.+?)\*/g, "$1");

  // Limpiar listas con guiones o asteriscos al inicio
  text = text.replace(/^[\s]*[-\*\+]\s+(.+)$/gm, "• $1");

  // Limpiar listas numeradas
  text = text.replace(/^[\s]*\d+\.\s+(.+)$/gm, "• $1");

  // Limpiar bloques de código
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/`(.+?)`/g, "$1");

  // Limpiar enlaces [texto](url)
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");

  // Limpiar líneas horizontales
  text = text.replace(/^[-\*_]{3,}$/gm, "");

  // Limpiar espacios extra y saltos de línea múltiples
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

// Función para extraer texto de un mensaje
function extractTextFromMessage(message) {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .filter((text) => text && text.trim() !== "")
      .join("\n");
  }

  if (
    typeof message.content === "object" &&
    message.content !== null &&
    "text" in message.content
  ) {
    return message.content.text || "";
  }

  return "";
}

// Función para concatenar mensajes de usuario sin responder
function getUnrespondedUserMessages(messages) {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  if (lastAssistantIndex === -1) {
    const userMessages = messages.filter((m) => m.role === "user");
    if (userMessages.length === 0) return "";

    const lastUserMessage = userMessages[userMessages.length - 1];
    return extractTextFromMessage(lastUserMessage);
  }

  const unrespondedMessages = messages
    .slice(lastAssistantIndex + 1)
    .filter((m) => m.role === "user")
    .map(extractTextFromMessage)
    .filter((text) => text.trim() !== "");

  if (unrespondedMessages.length === 0) {
    return "";
  }

  if (unrespondedMessages.length > 1) {
    return unrespondedMessages
      .map((msg, index) => `Mensaje ${index + 1}: ${msg}`)
      .join("\n\n");
  }

  return unrespondedMessages[0];
}

class AssistantService {
  static async chatWithDocument({ chat }) {
    if (!chat || !Array.isArray(chat) || chat.length === 0) {
      return { error: "El chat debe ser un array no vacío" };
    }

    try {
      const messages = chat;
      const model = "command-a-03-2025";
      const collection = process.env.COLLECTION_QT || "documentos";

      try {
        // USAR CONCATENACIÓN EN LUGAR DEL ÚLTIMO MENSAJE
        const concatenatedUserText = getUnrespondedUserMessages(messages);

        if (!concatenatedUserText) {
          return {
            error: "No se encontraron mensajes del usuario sin responder",
          };
        }

        console.log("Texto concatenado para procesar:", concatenatedUserText);

        const { embedding, response, hash } =
          await EmbeddingsService.getEmbeddingOrCachedResponse({
            text: concatenatedUserText,
          });

        if (!embedding) {
          return {
            error: "No se pudo obtener el embedding del texto",
          };
        }

        let contextDocuments = [];
        try {
          const searchResults = await qdrantClient.search(collection, {
            vector: embedding,
            limit: 10,
            with_payload: true,
          });
          contextDocuments = searchResults.map((item) => ({
            id: randomUUID(),
            data: {
              text:
                item.payload?.contenido ||
                item.payload?.descripcion ||
                item.payload?.text ||
                "Sin contenido",
            },
          }));

          console.log(
            `Encontrados ${contextDocuments.length} documentos de contexto`
          );
        } catch (e) {
          console.error(`Error buscando en ${collection}:`, e.message);
        }

        const normalizedMessages = messages.map((m) => ({
          role: m.role,
          content: extractTextFromMessage(m),
        }));

        console.log(`Enviando ${normalizedMessages.length} mensajes a Cohere`);

        let cohereResponse;

        try {
          cohereResponse = await cohereClient.chat({
            model,
            documents: contextDocuments,
            messages: normalizedMessages,
            maxTokens: 200,
          });
        } catch (error) {
          console.error("Error en la llamada a Cohere:", error);
          return { error: "Error al procesar el chat con Cohere" };
        }

        const { message: responseMessage } = cohereResponse;

        const cleanedResponse = formatForWhatsApp(
          responseMessage.content[0].text
        );
        responseMessage.content[0].text = cleanedResponse;

        return {
          response: responseMessage,
        };
      } catch (error) {
        console.error("Error en chat:", error);
        return {
          error: "Error procesando el chat",
        };
      }
    } catch (error) {
      console.error("❌ Error al obtener el historial de chat:", error);
      throw new Error("Error al obtener el historial de chat");
    }
  }

  static async getStatusAssistant({ name = "assistant-1" }) {
    try {
      const statusRef = db.collection("config").doc(name);
      const statusDoc = await statusRef.get();

      if (!statusDoc.exists) {
        console.error(`❌ Asistente ${name} no encontrado`);
        return { error: `Asistente ${name} no encontrado` };
      }

      const statusData = statusDoc.data();

      return {
        name,
        status: statusData,
      };
    } catch (error) {
      console.error("❌ Error al obtener el estado del asistente:", error);
      throw new Error("Error al obtener el estado del asistente");
    }
  }

  static async getConfigAssistant({ name = "assistant-1" }) {
    try {
      const configRef = db.collection("config").doc(name);
      const configDoc = await configRef.get();

      if (!configDoc.exists) {
        console.error(`❌ Configuración del asistente no encontrada`);
        return { error: `Configuración del asistente no encontrada` };
      }

      const configData = configDoc.data();

      return {
        config: configData,
      };
    } catch (error) {
      console.error(
        "❌ Error al obtener la configuración del asistente:",
        error
      );
      throw new Error("Error al obtener la configuración del asistente");
    }
  }
}

module.exports = {
  AssistantService,
};
