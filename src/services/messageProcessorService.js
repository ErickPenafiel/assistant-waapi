const { AssistantService } = require("./assistant-service");
const { ChatHistoryService } = require("./chat-history-service");
const { MessageWasendService } = require("./message-wasend-servide");
const { AudioService } = require("./audio-service");

class MessageProcessorService {
  static async processMessages(formattedPhone, context = {}) {
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
    const { response, locationToSend, imagesToSend, shouldListLocations } = await AssistantService.chatWithDocument({
      chat: promptSystem ? [promptSystem, ...currentChat] : currentChat,
    });

    if (!Array.isArray(response?.content)) {
      console.warn("Respuesta no válida");
      return;
    }

    const responseText = response.content[0]?.text || "Sin respuesta";

    // Función helper para delay
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // FLUJO 1: Si solo lista ubicaciones, enviar solo el texto
    if (shouldListLocations) {
      await MessageWasendService.sendMessage({
        phone: formattedPhone,
        message: responseText,
      });
      console.log("Lista de ubicaciones enviada");
    }
    // FLUJO 2: Si hay ubicación para enviar, primero texto, luego ubicación con delay
    else if (locationToSend) {
      // Enviar mensaje de texto primero solo si hay texto
      if (responseText && responseText.trim() !== "") {
        await MessageWasendService.sendMessage({
          phone: formattedPhone,
          message: responseText,
        });
        console.log("Mensaje de texto enviado");

        // Delay de 2 segundos
        await delay(2000);
      }

      // Enviar la ubicación
      try {
        await MessageWasendService.sendLocation({
          phone: formattedPhone,
          location: locationToSend,
        });
        console.log(`Ubicación enviada: ${locationToSend.name}`);
      } catch (error) {
        console.error("Error enviando ubicación:", error);
      }
    }
    // FLUJO 3: Si hay imágenes para enviar, primero texto, luego imágenes con delay
    else if (imagesToSend && imagesToSend.length > 0) {
      // Enviar mensaje de texto primero solo si hay texto
      if (responseText && responseText.trim() !== "") {
        await MessageWasendService.sendMessage({
          phone: formattedPhone,
          message: responseText,
        });
        console.log("Mensaje de texto enviado");

        // Delay antes de enviar imágenes
        await delay(2000);
      }

      // Enviar imágenes con delay entre cada una
      for (const image of imagesToSend) {
        try {
          await MessageWasendService.sendImage({
            phone: formattedPhone,
            imageUrl: image.imageUrl,
            caption: image.description,
          });
          console.log(`Imagen enviada: ${image.name}`);

          // Delay entre imágenes si hay más de una
          if (imagesToSend.length > 1) {
            await delay(1500);
          }
        } catch (error) {
          console.error("Error enviando imagen:", error);
        }
      }
    }
    // FLUJO 4: Solo texto (sin ubicación ni imágenes)
    else {
      if (context.shouldRespondWithAudio) {
        try {
          const { wasender } = require("../config/clients/wasenderapi-client");
          const audioBuffer = await AudioService.generateResponseAudio(
            responseText
          );
          const tempAudioPath = await AudioService.saveTemporaryAudio(
            audioBuffer,
            "ogg"
          );
          const fs = require("fs");

          await wasender.sendMedia({
            to: `+${formattedPhone}`,
            media: fs.createReadStream(tempAudioPath),
            mediaType: "audio",
          });

          setTimeout(async () => {
            try {
              const fsPromises = require("fs").promises;
              await fsPromises.unlink(tempAudioPath);
            } catch (err) {
              console.error("Error eliminando archivo temporal:", err);
            }
          }, 5 * 60 * 1000);
        } catch (error) {
          console.error(`Error enviando audio:`, error);
          await MessageWasendService.sendMessage({
            phone: formattedPhone,
            message: responseText,
          });
        }
      } else {
        await MessageWasendService.sendMessage({
          phone: formattedPhone,
          message: responseText,
        });
      }
    }

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
