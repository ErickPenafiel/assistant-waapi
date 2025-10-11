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
    const { response, locationToSend, imagesToSend, audiosToSend, videosToSend, shouldListLocations } = await AssistantService.chatWithDocument({
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
    // FLUJO 2: Si hay ubicación O multimedia para enviar
    else if (locationToSend ||
             (imagesToSend && imagesToSend.length > 0) ||
             (audiosToSend && audiosToSend.length > 0) ||
             (videosToSend && videosToSend.length > 0)) {

      // 1. Enviar mensaje de texto primero
      if (responseText && responseText.trim() !== "") {
        await MessageWasendService.sendMessage({
          phone: formattedPhone,
          message: responseText,
        });
        console.log("✅ Mensaje de texto enviado");
        await delay(6000); // 6 segundos de delay
      }

      // 2. Enviar ubicación si existe
      if (locationToSend) {
        try {
          await MessageWasendService.sendLocation({
            phone: formattedPhone,
            location: locationToSend,
          });
          console.log(`✅ Ubicación enviada: ${locationToSend.name}`);
          await delay(6000); // 6 segundos de delay después de ubicación
        } catch (error) {
          console.error("❌ Error enviando ubicación:", error);
        }
      }

      // 3. Calcular y enviar multimedia (imágenes, videos, audios)
      const totalImages = imagesToSend?.length || 0;
      const totalVideos = videosToSend?.length || 0;
      const totalAudios = audiosToSend?.length || 0;
      const totalMedia = totalImages + totalVideos + totalAudios;
      let mediaCount = 0;

      if (totalMedia > 0) {
        console.log(`📦 Total multimedia a enviar: ${totalMedia} (${totalImages} imágenes, ${totalVideos} videos, ${totalAudios} audios)`);
      }

      // 4. Enviar imágenes con delay entre cada una
      if (imagesToSend && imagesToSend.length > 0) {
        for (const image of imagesToSend) {
          try {
            await MessageWasendService.sendImage({
              phone: formattedPhone,
              imageUrl: image.imageUrl,
              caption: image.description || image.name,
            });
            mediaCount++;
            console.log(`🖼️ Imagen enviada: ${image.name} (${mediaCount}/${totalMedia})`);

            // Delay de 6 segundos entre cada elemento
            if (mediaCount < totalMedia) {
              await delay(6000);
            }
          } catch (error) {
            console.error("❌ Error enviando imagen:", error);
          }
        }
      }

      // 5. Enviar videos con delay entre cada uno
      if (videosToSend && videosToSend.length > 0) {
        for (const video of videosToSend) {
          try {
            await MessageWasendService.sendVideo({
              phone: formattedPhone,
              videoUrl: video.imageUrl, // imageUrl contiene la URL del video
              caption: video.description || video.name,
            });
            mediaCount++;
            console.log(`🎬 Video enviado: ${video.name} (${mediaCount}/${totalMedia})`);

            // Delay de 6 segundos entre cada elemento
            if (mediaCount < totalMedia) {
              await delay(6000);
            }
          } catch (error) {
            console.error("❌ Error enviando video:", error);
          }
        }
      }

      // 6. Enviar audios con delay entre cada uno
      if (audiosToSend && audiosToSend.length > 0) {
        for (const audio of audiosToSend) {
          try {
            await MessageWasendService.sendAudio({
              phone: formattedPhone,
              audioUrl: audio.imageUrl, // imageUrl contiene la URL del audio
              caption: audio.name,
            });
            mediaCount++;
            console.log(`🎵 Audio enviado: ${audio.name} (${mediaCount}/${totalMedia})`);

            // Delay de 6 segundos entre cada elemento
            if (mediaCount < totalMedia) {
              await delay(6000);
            }
          } catch (error) {
            console.error("❌ Error enviando audio:", error);
          }
        }
      }
    }
    // FLUJO 3: Solo texto (sin ubicación ni multimedia)
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
