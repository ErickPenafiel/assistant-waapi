const { AssistantService } = require("./assistant-service");
const { ChatHistoryService } = require("./chat-history-service");
const { MessageWasendService } = require("./message-wasend-servide");
const { AudioService } = require("./audio-service");
const { EmbeddingsService } = require("./embeddings-service");

class MessageProcessorService {
  /**
   * Calcula similitud coseno entre dos vectores de embeddings
   */
  static cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Filtra multimedia basándose en similitud semántica con la pregunta del usuario
   */
  static async filterRelevantMedia(userQuery, mediaItems, threshold = 0.5) {
    if (!mediaItems || mediaItems.length === 0) return [];

    try {
      // Obtener embedding de la pregunta del usuario
      const { embedding: queryEmbedding } =
        await EmbeddingsService.getEmbeddingOrCachedResponse({
          text: userQuery.toLowerCase(),
        });

      const scoredMedia = [];

      for (const media of mediaItems) {
        // Crear texto de búsqueda combinando nombre, descripción y metadata
        const searchText = [
          media.name || "",
          media.description || "",
          media.location || "",
          media.tags?.join(" ") || "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (!searchText.trim()) {
          scoredMedia.push({ media, score: 0 });
          continue;
        }

        // Obtener embedding del contenido multimedia
        const { embedding: mediaEmbedding } =
          await EmbeddingsService.getEmbeddingOrCachedResponse({
            text: searchText,
          });

        // Calcular similitud
        const score = this.cosineSimilarity(queryEmbedding, mediaEmbedding);
        scoredMedia.push({ media, score });
      }

      // Filtrar por umbral y ordenar por score descendente
      const filtered = scoredMedia
        .filter((item) => item.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.media);

      console.log(
        `🔍 Multimedia filtrada: ${filtered.length}/${mediaItems.length} (umbral: ${threshold})`
      );

      return filtered;
    } catch (error) {
      console.error("❌ Error filtrando multimedia:", error);
      // En caso de error, devolver todos los items (comportamiento fallback)
      return mediaItems;
    }
  }

  /**
   * Determina si el usuario está haciendo una pregunta específica sobre ubicación/multimedia
   */
  static isSpecificMediaQuery(userMessage) {
    const mediaKeywords = [
      "ubicación",
      "ubicacion",
      "dirección",
      "direccion",
      "dónde",
      "donde",
      "sucursal",
      "sede",
      "local",
      "tienda",
      "oficina",
      "foto",
      "imagen",
      "video",
      "audio",
      "muestra",
      "muéstrame",
      "muestrame",
      "envía",
      "envia",
      "manda",
      "comparte",
    ];

    const lowerMessage = userMessage.toLowerCase();
    return mediaKeywords.some((keyword) => lowerMessage.includes(keyword));
  }

  /**
   * Extrae el último mensaje del usuario del chat
   */
  static getLastUserMessage(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i].role === "user" && Array.isArray(chat[i].content)) {
        const textContent = chat[i].content.find((c) => c.type === "text");
        if (textContent?.text) {
          return textContent.text;
        }
      }
    }
    return "";
  }

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

    const {
      response,
      locationToSend,
      imagesToSend,
      audiosToSend,
      videosToSend,
      shouldListLocations,
    } = await AssistantService.chatWithDocument({
      chat: promptSystem ? [promptSystem, ...currentChat] : currentChat,
    });

    if (!Array.isArray(response?.content)) {
      console.warn("Respuesta no válida");
      return;
    }

    const responseText = response.content[0]?.text || "Sin respuesta";
    const lastUserMessage = this.getLastUserMessage(currentChat);
    const isSpecificQuery = this.isSpecificMediaQuery(lastUserMessage);

    console.log(`📝 Última pregunta: "${lastUserMessage}"`);
    console.log(`🎯 Consulta específica de multimedia: ${isSpecificQuery}`);

    // Función helper para delay
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // FLUJO 1: Si solo lista ubicaciones, enviar solo el texto
    if (shouldListLocations) {
      await MessageWasendService.sendMessage({
        phone: formattedPhone,
        message: responseText,
      });
      console.log("📋 Lista de ubicaciones enviada");

      // Guardar en historial y retornar
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

      console.log(`✅ Respuesta enviada a: ${formattedPhone}`);
      return;
    }

    // FLUJO 2: Filtrar multimedia basándose en la consulta del usuario
    let filteredImages = imagesToSend || [];
    let filteredVideos = videosToSend || [];
    let filteredAudios = audiosToSend || [];
    let filteredLocation = locationToSend;

    // Si es una consulta específica y hay multimedia disponible, filtrar con IA
    if (isSpecificQuery && lastUserMessage.trim()) {
      console.log("🤖 Aplicando filtrado inteligente de multimedia...");

      // Filtrar con umbral más alto (0.6) para consultas específicas
      const threshold = 0.6;

      if (imagesToSend && imagesToSend.length > 0) {
        filteredImages = await this.filterRelevantMedia(
          lastUserMessage,
          imagesToSend,
          threshold
        );
      }

      if (videosToSend && videosToSend.length > 0) {
        filteredVideos = await this.filterRelevantMedia(
          lastUserMessage,
          videosToSend,
          threshold
        );
      }

      if (audiosToSend && audiosToSend.length > 0) {
        filteredAudios = await this.filterRelevantMedia(
          lastUserMessage,
          audiosToSend,
          threshold
        );
      }

      // Para ubicaciones, verificar si la ubicación coincide con la consulta
      if (locationToSend) {
        const locationText = [
          locationToSend.name || "",
          locationToSend.address || "",
          locationToSend.description || "",
        ]
          .filter(Boolean)
          .join(" ");

        const [filteredLocs] = await this.filterRelevantMedia(
          lastUserMessage,
          [{ ...locationToSend, description: locationText }],
          threshold
        );

        filteredLocation = filteredLocs || null;
      }
    }

    // FLUJO 3: Enviar multimedia si hay contenido relevante
    const hasRelevantMedia =
      filteredLocation ||
      (filteredImages && filteredImages.length > 0) ||
      (filteredAudios && filteredAudios.length > 0) ||
      (filteredVideos && filteredVideos.length > 0);

    if (hasRelevantMedia) {
      // 1. Enviar mensaje de texto primero
      if (responseText && responseText.trim() !== "") {
        await MessageWasendService.sendMessage({
          phone: formattedPhone,
          message: responseText,
        });
        console.log("✅ Mensaje de texto enviado");
        await delay(5000); // 5 segundos de delay
      }

      // 2. Enviar ubicación si existe y es relevante
      if (filteredLocation) {
        try {
          await MessageWasendService.sendLocation({
            phone: formattedPhone,
            location: filteredLocation,
          });
          console.log(`📍 Ubicación enviada: ${filteredLocation.name}`);
          await delay(5000);
        } catch (error) {
          console.error("❌ Error enviando ubicación:", error);
        }
      }

      // 3. Calcular total de multimedia filtrada
      const totalImages = filteredImages?.length || 0;
      const totalVideos = filteredVideos?.length || 0;
      const totalAudios = filteredAudios?.length || 0;
      const totalMedia = totalImages + totalVideos + totalAudios;
      let mediaCount = 0;

      if (totalMedia > 0) {
        console.log(
          `📦 Total multimedia relevante a enviar: ${totalMedia} (${totalImages} imágenes, ${totalVideos} videos, ${totalAudios} audios)`
        );
      }

      // 4. Enviar imágenes con delay
      if (filteredImages && filteredImages.length > 0) {
        for (const image of filteredImages) {
          try {
            await MessageWasendService.sendImage({
              phone: formattedPhone,
              imageUrl: image.imageUrl,
              caption: image.description || image.name,
            });
            mediaCount++;
            console.log(
              `🖼️ Imagen enviada: ${image.name} (${mediaCount}/${totalMedia})`
            );

            if (mediaCount < totalMedia) {
              await delay(5000);
            }
          } catch (error) {
            console.error("❌ Error enviando imagen:", error);
          }
        }
      }

      // 5. Enviar videos con delay
      if (filteredVideos && filteredVideos.length > 0) {
        for (const video of filteredVideos) {
          try {
            await MessageWasendService.sendVideo({
              phone: formattedPhone,
              videoUrl: video.imageUrl,
              caption: video.description || video.name,
            });
            mediaCount++;
            console.log(
              `🎬 Video enviado: ${video.name} (${mediaCount}/${totalMedia})`
            );

            if (mediaCount < totalMedia) {
              await delay(5000);
            }
          } catch (error) {
            console.error("❌ Error enviando video:", error);
          }
        }
      }

      // 6. Enviar audios con delay
      if (filteredAudios && filteredAudios.length > 0) {
        for (const audio of filteredAudios) {
          try {
            await MessageWasendService.sendAudio({
              phone: formattedPhone,
              audioUrl: audio.imageUrl,
              caption: audio.name,
            });
            mediaCount++;
            console.log(
              `🎵 Audio enviado: ${audio.name} (${mediaCount}/${totalMedia})`
            );

            if (mediaCount < totalMedia) {
              await delay(5000);
            }
          } catch (error) {
            console.error("❌ Error enviando audio:", error);
          }
        }
      }
    }
    // FLUJO 4: Solo texto (sin multimedia relevante)
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
        console.log("💬 Solo texto enviado (sin multimedia relevante)");
      }
    }

    // Guardar historial actualizado
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

    console.log(`✅ Respuesta enviada a: ${formattedPhone}`);
  }
}

module.exports = MessageProcessorService;
