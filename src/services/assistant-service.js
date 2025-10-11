require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const { groqClient } = require("../config/clients/groq-client.js");
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
  static async getActiveLocations() {
    try {
      const locationsRef = db.collection("locations");
      const snapshot = await locationsRef.where("active", "==", true).get();

      return snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
    } catch (error) {
      console.error("Error getting active locations:", error);
      return [];
    }
  }

  // Función para calcular similitud entre textos
  static calculateSimilarity(text1, text2) {
    const words1 = text1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const words2 = text2.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    let matches = 0;
    words1.forEach(word => {
      if (words2.some(w => w.includes(word) || word.includes(w))) {
        matches++;
      }
    });

    return matches;
  }

  // Función para encontrar la mejor ubicación
  static findBestLocation(locations, searchText) {
    let bestMatch = null;
    let bestScore = 0;

    locations.forEach(location => {
      const locationText = `${location.name} ${location.description} ${location.address}`;
      const score = this.calculateSimilarity(searchText, locationText);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = location;
      }
    });

    // Si no hay coincidencia, devolver la primera ubicación activa
    return bestMatch || locations[0] || null;
  }

  static async getActivePromptImages() {
    try {
      const imagesRef = db.collection("prompt_images");
      const snapshot = await imagesRef.where("active", "==", true).get();

      return snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
    } catch (error) {
      console.error("Error getting active prompt media:", error);
      return [];
    }
  }

  // Función para encontrar el mejor contenido multimedia (imágenes, audios, videos)
  static findBestMedia(mediaItems, searchText, maxItems = 3) {
    const scored = mediaItems.map(item => {
      const itemText = `${item.name} ${item.description}`;
      const score = this.calculateSimilarity(searchText, itemText);
      return { ...item, score };
    });

    // Ordenar por score descendente
    scored.sort((a, b) => b.score - a.score);

    // Si hay al menos una con score > 0, devolver las mejores
    const withScore = scored.filter(item => item.score > 0);
    if (withScore.length > 0) {
      return withScore.slice(0, maxItems);
    }

    // Si no hay coincidencias, no devolver nada
    return [];
  }

  // Mantener compatibilidad
  static findBestImages(images, searchText, maxImages = 3) {
    return this.findBestMedia(images, searchText, maxImages);
  }

  static async chatWithDocument({ chat }) {
    if (!chat || !Array.isArray(chat) || chat.length === 0) {
      return { error: "El chat debe ser un array no vacío" };
    }

    try {
      const messages = chat;
      const model = "llama-3.3-70b-versatile";
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

        // Obtener ubicaciones e imágenes activas para el contexto
        const activeLocations = await this.getActiveLocations();
        const activeImages = await this.getActivePromptImages();

        // Agregar ubicaciones al contexto si existen
        if (activeLocations.length > 0) {
          const locationsText = activeLocations
            .map(
              (loc) =>
                `Ubicación: ${loc.name}\nDescripción: ${loc.description}\nDirección: ${loc.address}`
            )
            .join("\n\n");

          contextDocuments.push({
            id: randomUUID(),
            data: {
              text: `UBICACIONES DISPONIBLES:\n\n${locationsText}\n\nIMPORTANTE:\n1. Primera pregunta sobre ubicación: Lista SOLO los nombres de las ubicaciones disponibles y pregunta cuál le interesa\n2. Cuando elija una: Di "Te envío la ubicación de [nombre]" y NADA MÁS\n3. NUNCA incluyas coordenadas, direcciones completas, URLs o links en tu respuesta\n4. La ubicación se enviará automáticamente como ubicación de WhatsApp`,
            },
          });
        }

        // Agregar contenido multimedia (imágenes, audios, videos) al contexto si existen
        if (activeImages.length > 0) {
          const mediaByType = {
            image: [],
            audio: [],
            video: []
          };

          // Agrupar por tipo
          activeImages.forEach(item => {
            const type = item.type || 'image';
            if (mediaByType[type]) {
              mediaByType[type].push(item);
            }
          });

          let mediaText = '';

          if (mediaByType.image.length > 0) {
            const imagesText = mediaByType.image
              .map(img => `Imagen: ${img.name}\nDescripción: ${img.description}`)
              .join("\n\n");
            mediaText += `IMÁGENES DISPONIBLES:\n\n${imagesText}\n\n`;
          }

          if (mediaByType.audio.length > 0) {
            const audiosText = mediaByType.audio
              .map(audio => `Audio: ${audio.name}\nTranscripción: ${audio.description}`)
              .join("\n\n");
            mediaText += `AUDIOS DISPONIBLES:\n\n${audiosText}\n\n`;
          }

          if (mediaByType.video.length > 0) {
            const videosText = mediaByType.video
              .map(video => `Video: ${video.name}\nDescripción: ${video.description}`)
              .join("\n\n");
            mediaText += `VIDEOS DISPONIBLES:\n\n${videosText}\n\n`;
          }

          if (mediaText) {
            contextDocuments.push({
              id: randomUUID(),
              data: {
                text: `${mediaText}IMPORTANTE:\n1. Cuando el usuario pida ver imágenes, audios o videos: Di "Te muestro [nombre]" o "Te envío [nombre]"\n2. NUNCA incluyas URLs, links o rutas en tu respuesta\n3. El contenido multimedia se enviará automáticamente por WhatsApp`,
              },
            });
          }
        }

        const normalizedMessages = messages.map((m) => ({
          role: m.role,
          content: extractTextFromMessage(m),
        }));

        // Preparar contexto de documentos para Groq
        let contextText = "";
        if (contextDocuments.length > 0) {
          contextText = "\n\nCONTEXTO DISPONIBLE:\n" +
            contextDocuments.map(doc => doc.data.text).join("\n\n");
        }

        // Preparar mensajes para Groq
        const groqMessages = [];

        // Agregar contexto al primer mensaje del sistema si existe
        if (normalizedMessages.length > 0 && normalizedMessages[0].role === 'system') {
          groqMessages.push({
            role: 'system',
            content: normalizedMessages[0].content + contextText
          });
          groqMessages.push(...normalizedMessages.slice(1));
        } else {
          // Si no hay mensaje de sistema, agregar el contexto al primer mensaje de usuario
          if (normalizedMessages.length > 0) {
            const firstMessage = normalizedMessages[0];
            groqMessages.push({
              role: firstMessage.role,
              content: firstMessage.content + contextText
            });
            groqMessages.push(...normalizedMessages.slice(1));
          }
        }

        console.log(`Enviando ${groqMessages.length} mensajes a Groq`);

        let groqResponse;

        try {
          groqResponse = await groqClient.chat.completions.create({
            model,
            messages: groqMessages,
            max_tokens: 200,
            temperature: 0.7,
          });
        } catch (error) {
          console.error("Error en la llamada a Groq:", error);
          return { error: "Error al procesar el chat con Groq" };
        }

        const responseText = groqResponse.choices[0]?.message?.content || "";
        const cleanedResponse = formatForWhatsApp(responseText);

        // Formato de respuesta compatible con el código existente
        const responseMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: cleanedResponse }]
        };

        // Detectar si la respuesta indica envío de ubicación o imagen
        const responseLower = cleanedResponse.toLowerCase();
        const userText = getUnrespondedUserMessages(messages).toLowerCase();
        const combinedText = `${userText} ${responseLower}`;

        let locationToSend = null;
        let imagesToSend = [];
        let audiosToSend = [];
        let videosToSend = [];
        let shouldListLocations = false;

        // Detectar si es una pregunta inicial sobre ubicaciones (listar opciones)
        const initialLocationKeywords = [
          "dónde", "donde", "ubicación", "ubicacion",
          "dirección", "direccion", "quedan", "ubicados",
          "ubicadas", "están", "sucursales"
        ];

        const isInitialLocationQuery = initialLocationKeywords.some(keyword =>
          userText.includes(keyword)
        ) && !responseLower.includes("te envío") && !responseLower.includes("te envio");

        if (isInitialLocationQuery && activeLocations.length > 0) {
          // Primera vez que pregunta: listar ubicaciones disponibles
          shouldListLocations = true;

          // Modificar la respuesta para listar ubicaciones
          let locationsList = "Tenemos las siguientes ubicaciones:\n\n";
          activeLocations.forEach((loc, index) => {
            locationsList += `${index + 1}. ${loc.name}\n`;
            if (loc.description) locationsList += `   ${loc.description}\n`;
          });
          locationsList += "\n¿De cuál ubicación te gustaría recibir la dirección?";

          responseMessage.content[0].text = locationsList;
        }
        // Detectar si el usuario está eligiendo una ubicación específica
        else if (activeLocations.length > 0) {
          // Buscar si menciona alguna ubicación específica
          for (const location of activeLocations) {
            const locationName = location.name.toLowerCase();
            if (
              userText.includes(locationName) ||
              responseLower.includes(locationName) ||
              responseLower.includes("te envío") ||
              responseLower.includes("te envio")
            ) {
              locationToSend = location;
              console.log(`Ubicación seleccionada para envío: ${location.name}`);
              break;
            }
          }

          // Si no encontró una específica, usar similitud
          if (!locationToSend && (responseLower.includes("te envío") || responseLower.includes("te envio"))) {
            locationToSend = this.findBestLocation(activeLocations, combinedText);
            console.log(`Ubicación por similitud: ${locationToSend?.name || 'ninguna'}`);
          }
        }

        // BUSCAR contenido multimedia SOLO basado en keywords del USUARIO y RESPUESTA
        // (NO en el contenido de las descripciones/transcripciones)
        const imageKeywords = [
          "imagen", "foto", "ver", "muestra", "mostrar",
          "enseña", "enséña", "mira", "muestr", "fotograf"
        ];

        const audioKeywords = [
          "audio", "escuchar", "escucha", "oír", "oye",
          "sonido", "grabación", "grabacion"
        ];

        const videoKeywords = [
          "video", "vídeo", "clip", "grabación", "grabacion"
        ];

        // Verificar keywords SOLO en userText y responseLower (no en combinedText)
        const hasImageKeyword = imageKeywords.some(keyword =>
          userText.includes(keyword) || responseLower.includes(keyword)
        );

        const hasAudioKeyword = audioKeywords.some(keyword =>
          userText.includes(keyword) || responseLower.includes(keyword)
        );

        const hasVideoKeyword = videoKeywords.some(keyword =>
          userText.includes(keyword) || responseLower.includes(keyword)
        );

        // Buscar multimedia INDEPENDIENTEMENTE de si hay ubicación
        if (activeImages.length > 0) {
          // Separar contenido por tipo
          const images = activeImages.filter(item => (item.type || 'image') === 'image');
          const audios = activeImages.filter(item => item.type === 'audio');
          const videos = activeImages.filter(item => item.type === 'video');

          // Buscar imágenes
          if (hasImageKeyword && images.length > 0) {
            imagesToSend = this.findBestMedia(images, userText, 3);
            console.log(`Imágenes seleccionadas: ${imagesToSend.length}`);
          }

          // Buscar audios
          if (hasAudioKeyword && audios.length > 0) {
            audiosToSend = this.findBestMedia(audios, userText, 3);
            console.log(`Audios seleccionados: ${audiosToSend.length}`);
          }

          // Buscar videos
          if (hasVideoKeyword && videos.length > 0) {
            videosToSend = this.findBestMedia(videos, userText, 3);
            console.log(`Videos seleccionados: ${videosToSend.length}`);
          }
        }

        // Log de depuración
        if (locationToSend) {
          console.log("📍 Location a enviar:", {
            name: locationToSend.name,
            latitude: locationToSend.latitude,
            longitude: locationToSend.longitude,
            address: locationToSend.address
          });
        }

        return {
          response: responseMessage,
          locationToSend,
          imagesToSend,
          audiosToSend,
          videosToSend,
          shouldListLocations,
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
