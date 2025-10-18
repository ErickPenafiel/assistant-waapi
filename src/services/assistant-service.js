require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const { groqClient } = require("../config/clients/groq-client.js");
const { ChatHistoryService } = require("./chat-history-service.js");
const { EmbeddingsService } = require("./embeddings-service.js");
const { randomUUID } = require("crypto");
const { db } = require("../config/firebase/config.js");

function formatForWhatsApp(text) {
  if (!text) return text;
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/\*(.+?)\*/g, "$1");
  text = text.replace(/^[\s]*[-\*\+]\s+(.+)$/gm, "• $1");
  text = text.replace(/^[\s]*\d+\.\s+(.+)$/gm, "• $1");
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/`(.+?)`/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");
  text = text.replace(/^[-\*_]{3,}$/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();
  return text;
}

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

  static async getKnowledgeBase() {
    try {
      const knowledgeRef = db.collection("knowledge_base");
      const snapshot = await knowledgeRef.where("active", "==", true).get();
      return snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
    } catch (error) {
      console.error("Error getting knowledge base:", error);
      return [];
    }
  }

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

  static async searchKnowledgeBase(userQuery, limit = 5) {
    try {
      const knowledgeItems = await this.getKnowledgeBase();

      if (knowledgeItems.length === 0) {
        return [];
      }

      const { embedding: queryEmbedding } =
        await EmbeddingsService.getEmbeddingOrCachedResponse({
          text: userQuery.toLowerCase(),
        });

      const scoredItems = [];

      for (const item of knowledgeItems) {
        const searchText = [
          item.title || "",
          item.content || "",
          item.text || "",
          item.description || "",
          item.tags?.join(" ") || "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (!searchText.trim()) {
          continue;
        }

        const { embedding: itemEmbedding } =
          await EmbeddingsService.getEmbeddingOrCachedResponse({
            text: searchText,
          });

        const score = this.cosineSimilarity(queryEmbedding, itemEmbedding);

        scoredItems.push({
          content: item.content || item.text || "",
          score,
          metadata: {
            id: item.id,
            title: item.title,
            ...item,
          },
        });
      }

      const relevantItems = scoredItems
        .filter((item) => item.score > 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      console.log(
        `📚 Base de conocimiento: ${relevantItems.length}/${knowledgeItems.length} documentos relevantes`
      );

      return relevantItems;
    } catch (error) {
      console.error("Error en búsqueda de conocimiento:", error);
      return [];
    }
  }

  static async shouldSendMultimedia(userQuery, assistantResponse, mediaType) {
    try {
      const prompt = `Analiza esta conversación y responde SOLO "SI" o "NO":

Usuario: "${userQuery}"
Asistente: "${assistantResponse}"

¿El usuario está pidiendo EXPLÍCITAMENTE ver/recibir ${mediaType}?

Responde "SI" solo si:
- Pide ver, mostrar, enviar, compartir ${mediaType}
- Pregunta "¿cómo es?" o "¿cómo se ve?" (necesita visual)
- Dice "muéstrame", "quiero ver", "mándame"

Responde "NO" si solo pregunta:
- Ubicación, dirección, horarios
- Información de texto (precios, contactos, servicios)
- Cómo llegar, dónde está

Respuesta (solo SI o NO):`;

      const groqResponse = await groqClient.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 5,
        temperature: 0,
      });

      const responseText =
        groqResponse.choices[0]?.message?.content?.trim().toUpperCase() || "";
      const shouldSend =
        responseText.includes("SI") || responseText.includes("SÍ");

      console.log(
        `🤔 ¿Enviar ${mediaType}? ${
          shouldSend ? "✅ SÍ" : "⛔ NO"
        } (Groq: "${responseText}")`
      );

      return shouldSend;
    } catch (error) {
      console.error("Error decidiendo si enviar multimedia:", error);
      return false;
    }
  }

  static async filterMediaWithHybridApproach(
    mediaItems,
    userQuery,
    assistantResponse,
    mediaType,
    maxItems = 3
  ) {
    if (!mediaItems || mediaItems.length === 0) {
      return [];
    }

    try {
      console.log(
        `\n🔍 Filtrando ${mediaItems.length} ${mediaType} disponibles...`
      );

      const { embedding: queryEmbedding } =
        await EmbeddingsService.getEmbeddingOrCachedResponse({
          text: userQuery.toLowerCase(),
        });

      const scoredItems = [];
      const seenUrls = new Set();

      for (const item of mediaItems) {
        if (item.imageUrl && seenUrls.has(item.imageUrl)) {
          console.log(`⏭️ Duplicado detectado: ${item.name} (URL ya vista)`);
          continue;
        }

        if (item.imageUrl) {
          seenUrls.add(item.imageUrl);
        }

        const searchText = [
          item.name || "",
          item.description || "",
          item.location || "",
          item.tags?.join(" ") || "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (!searchText.trim()) {
          console.log(`⏭️ Sin metadata: ${item.name || "sin nombre"}`);
          continue;
        }

        const { embedding: itemEmbedding } =
          await EmbeddingsService.getEmbeddingOrCachedResponse({
            text: searchText,
          });

        const semanticScore = this.cosineSimilarity(
          queryEmbedding,
          itemEmbedding
        );

        scoredItems.push({
          item,
          semanticScore,
          groqScore: 0,
          finalScore: semanticScore,
        });
      }

      const semanticFiltered = scoredItems
        .filter((item) => item.semanticScore >= 0.5)
        .sort((a, b) => b.semanticScore - a.semanticScore);

      if (semanticFiltered.length === 0) {
        console.log(`⚠️ Ningún ${mediaType} supera el umbral semántico (0.5)`);
        console.log(
          `💡 El bot responderá que no tiene ${mediaType} disponibles`
        );
        return [];
      }

      console.log(
        `📊 Filtrado semántico: ${semanticFiltered.length}/${mediaItems.length} ${mediaType} relevantes`
      );
      semanticFiltered.slice(0, 5).forEach((item, i) => {
        console.log(
          `   ${i + 1}. ${item.item.name} (score: ${item.semanticScore.toFixed(
            2
          )})`
        );
      });

      const topCandidates = semanticFiltered.slice(
        0,
        Math.min(6, semanticFiltered.length)
      );

      const mediaList = topCandidates
        .map(
          (item, index) =>
            `${index + 1}. ${item.item.name} - ${
              item.item.description || "Sin descripción"
            }`
        )
        .join("\n");

      const prompt = `Usuario pregunta: "${userQuery}"
  Asistente responde: "${assistantResponse}"
  
  ${mediaType} candidatos:
  ${mediaList}
  
  REGLAS ESTRICTAS:
  1. Si pregunta por ubicación ESPECÍFICA (ej: "cochabamba", "santa cruz") → SOLO selecciona de ESA ubicación
  2. Si NO menciona ubicación específica → Selecciona máximo ${maxItems} más relevantes
  3. Si la pregunta es genérica ("foto de la entrada", "imagen de entrada") → Selecciona SOLO 1 o 2 más relevantes
  4. NUNCA selecciones todos
  5. Si NO hay coincidencia clara → "ninguno"
  
  Ejemplos:
  - "foto de cochabamba" → solo 1 imagen de Cochabamba
  - "imagen de entrada" → solo 1-2 imágenes de entrada
  - "fotos de cómo llegar" → 2-3 imágenes relevantes
  
  Formato: números separados por comas (ej: "1,3") o "ninguno"
  
  Selección:`;

      const groqResponse = await groqClient.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 50,
        temperature: 0.1,
      });

      const groqAnswer =
        groqResponse.choices[0]?.message?.content?.trim().toLowerCase() || "";
      console.log(`🤖 Groq seleccionó: "${groqAnswer}"`);

      if (groqAnswer.includes("ninguno") || groqAnswer.includes("ningún")) {
        console.log(`⛔ Groq decidió NO enviar ${mediaType}`);
        return [];
      }

      const selectedIndices = groqAnswer
        .split(/[,\s]+/)
        .map((s) => parseInt(s.trim()))
        .filter((n) => !isNaN(n) && n >= 1 && n <= topCandidates.length)
        .map((n) => n - 1);

      if (selectedIndices.length === 0) {
        console.log(`⚠️ Groq no dio índices válidos`);
        const bestItem = semanticFiltered[0];
        console.log(
          `🔄 Fallback: enviando solo el más relevante: ${bestItem.item.name}`
        );
        return [bestItem.item];
      }

      const uniqueIndices = [...new Set(selectedIndices)];
      const limitedIndices = uniqueIndices.slice(0, maxItems);

      const finalSelection = limitedIndices.map(
        (idx) => topCandidates[idx].item
      );

      console.log(`✅ Selección final: ${finalSelection.length} ${mediaType}`);
      finalSelection.forEach((item, i) => {
        console.log(`   ${i + 1}. ${item.name}`);
      });

      return finalSelection;
    } catch (error) {
      console.error(`❌ Error en filtrado híbrido de ${mediaType}:`, error);
      return [];
    }
  }
  static async shouldSendLocation(userQuery, assistantResponse, locations) {
    if (!locations || locations.length === 0) {
      return { shouldSend: false, specificLocation: null, shouldList: false };
    }

    try {
      const locationNames = locations.map((loc) => loc.name).join(", ");

      const prompt = `Analiza esta conversación:
  
  Usuario: "${userQuery}"
  Asistente: "${assistantResponse}"
  
  Ubicaciones disponibles: ${locationNames}
  
  IMPORTANTE:
  - Si el usuario pregunta "¿dónde están?", "¿cuáles ubicaciones tienen?" → LISTA
  - Si menciona una ubicación específica (ej: "santa cruz", "la paz") → ESPECIFICA
  - Si pregunta por imágenes/videos/audios SIN mencionar ubicaciones → NINGUNA
  - Si dice "y la imagen?", "muéstrame foto" SIN contexto de ubicación → NINGUNA
  
  Responde en formato JSON:
  {"decision": "ESPECIFICA", "ubicacion": "nombre"} - si menciona ubicación específica
  {"decision": "LISTA"} - si pide lista general de ubicaciones
  {"decision": "NINGUNA"} - NO pregunta por ubicaciones
  
  Respuesta:`;

      const groqResponse = await groqClient.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 100,
        temperature: 0,
      });

      const responseText =
        groqResponse.choices[0]?.message?.content?.trim() || "";
      console.log(`🤖 Groq decisión ubicación: "${responseText}"`);

      let decision;
      try {
        decision = JSON.parse(responseText);
      } catch {
        const jsonMatch = responseText.match(/\{[^}]+\}/);
        if (jsonMatch) {
          decision = JSON.parse(jsonMatch[0]);
        } else {
          return {
            shouldSend: false,
            specificLocation: null,
            shouldList: false,
          };
        }
      }

      if (decision.decision === "ESPECIFICA" && decision.ubicacion) {
        const searchName = decision.ubicacion.toLowerCase();
        const foundLocation = locations.find((loc) => {
          const locName = loc.name.toLowerCase();
          return locName.includes(searchName) || searchName.includes(locName);
        });

        if (foundLocation) {
          console.log(
            `📍 Ubicación específica encontrada: ${foundLocation.name}`
          );
          return {
            shouldSend: true,
            specificLocation: foundLocation,
            shouldList: false,
          };
        } else {
          console.log(`⛔ Ubicación "${decision.ubicacion}" no encontrada`);
          return {
            shouldSend: false,
            specificLocation: null,
            shouldList: false,
          };
        }
      }

      if (decision.decision === "LISTA") {
        console.log(`📋 Usuario pide lista de ubicaciones`);
        return { shouldSend: false, specificLocation: null, shouldList: true };
      }

      console.log(`⛔ No se requiere enviar ubicación`);
      return { shouldSend: false, specificLocation: null, shouldList: false };
    } catch (error) {
      console.error("Error decidiendo ubicación:", error);
      return { shouldSend: false, specificLocation: null, shouldList: false };
    }
  }

  static async filterMediaWithHybridApproach(
    mediaItems,
    userQuery,
    assistantResponse,
    mediaType,
    maxItems = 3
  ) {
    if (!mediaItems || mediaItems.length === 0) {
      return [];
    }

    try {
      console.log(
        `\n🔍 Filtrando ${mediaItems.length} ${mediaType} disponibles...`
      );

      const { embedding: queryEmbedding } =
        await EmbeddingsService.getEmbeddingOrCachedResponse({
          text: userQuery.toLowerCase(),
        });

      const scoredItems = [];

      for (const item of mediaItems) {
        const searchText = [
          item.name || "",
          item.description || "",
          item.location || "",
          item.tags?.join(" ") || "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (!searchText.trim()) {
          scoredItems.push({
            item,
            semanticScore: 0,
            groqScore: 0,
            finalScore: 0,
          });
          continue;
        }

        const { embedding: itemEmbedding } =
          await EmbeddingsService.getEmbeddingOrCachedResponse({
            text: searchText,
          });

        const semanticScore = this.cosineSimilarity(
          queryEmbedding,
          itemEmbedding
        );

        scoredItems.push({
          item,
          semanticScore,
          groqScore: 0,
          finalScore: semanticScore,
        });
      }

      const semanticFiltered = scoredItems
        .filter((item) => item.semanticScore >= 0.3)
        .sort((a, b) => b.semanticScore - a.semanticScore);

      if (semanticFiltered.length === 0) {
        console.log(`⚠️ Ningún ${mediaType} supera el umbral semántico (0.3)`);
        return [];
      }

      console.log(
        `📊 Filtrado semántico: ${semanticFiltered.length}/${mediaItems.length} ${mediaType} relevantes`
      );

      const topCandidates = semanticFiltered.slice(
        0,
        Math.min(8, semanticFiltered.length)
      );

      const mediaList = topCandidates
        .map(
          (item, index) =>
            `${index + 1}. ${item.item.name} - ${
              item.item.description || "Sin descripción"
            }`
        )
        .join("\n");

      const prompt = `Usuario pregunta: "${userQuery}"
  Asistente responde: "${assistantResponse}"
  
  ${mediaType} candidatos:
  ${mediaList}
  
  REGLAS CRÍTICAS:
  1. Si pregunta por ubicación específica (ej: "santa cruz") → Selecciona SOLO de esa ubicación
  2. Si pregunta genérico ("cómo llegar", "imágenes") → Selecciona los ${maxItems} más relevantes
  3. Si NO hay coincidencia clara → responde "ninguno"
  
  Formato: números separados por comas (ej: "1,2,3") o "ninguno"
  
  Selección:`;

      const groqResponse = await groqClient.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 50,
        temperature: 0,
      });

      const groqAnswer =
        groqResponse.choices[0]?.message?.content?.trim().toLowerCase() || "";
      console.log(`🤖 Groq seleccionó: "${groqAnswer}"`);

      if (groqAnswer.includes("ninguno") || groqAnswer.includes("ningún")) {
        console.log(`⛔ Groq decidió NO enviar ${mediaType}`);
        return [];
      }

      const selectedIndices = groqAnswer
        .split(/[,\s]+/)
        .map((s) => parseInt(s.trim()))
        .filter((n) => !isNaN(n) && n >= 1 && n <= topCandidates.length)
        .map((n) => n - 1);

      if (selectedIndices.length === 0) {
        console.log(`⚠️ Groq no dio índices válidos, usando top por similitud`);
        const fallbackItems = semanticFiltered
          .slice(0, maxItems)
          .map((s) => s.item);
        console.log(
          `🔄 Fallback: ${fallbackItems.length} ${mediaType} por similitud semántica`
        );
        return fallbackItems;
      }

      const finalSelection = selectedIndices.map(
        (idx) => topCandidates[idx].item
      );

      console.log(`✅ Selección final: ${finalSelection.length} ${mediaType}`);
      finalSelection.forEach((item, i) => {
        console.log(`   ${i + 1}. ${item.name}`);
      });

      return finalSelection;
    } catch (error) {
      console.error(`❌ Error en filtrado híbrido de ${mediaType}:`, error);
      return mediaItems.slice(0, maxItems);
    }
  }
  static async chatWithDocument({ chat }) {
    try {
      const concatenatedUserText = getUnrespondedUserMessages(chat);

      if (!concatenatedUserText || concatenatedUserText.trim() === "") {
        console.warn("⚠️ No hay mensajes de usuario sin responder");
        return {
          response: {
            role: "assistant",
            content: [{ type: "text", text: "No hay mensaje para procesar" }],
          },
          locationToSend: null,
          imagesToSend: [],
          audiosToSend: [],
          videosToSend: [],
          shouldListLocations: false,
        };
      }

      const relevantDocuments = await this.searchKnowledgeBase(
        concatenatedUserText,
        5
      );

      let contextText = "";
      if (relevantDocuments.length > 0) {
        contextText = relevantDocuments
          .map((doc, index) => `[Documento ${index + 1}]: ${doc.content}`)
          .join("\n\n");
      }

      const systemPrompt = chat[0]?.content?.[0]?.text || "";
      const chatMessages = chat.slice(1);

      const enhancedMessages = [
        {
          role: "system",
          content: contextText
            ? `${systemPrompt}\n\nContexto relevante de la base de conocimiento:\n${contextText}`
            : systemPrompt,
        },
        ...chatMessages,
      ];

      const groqResponse = await groqClient.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: enhancedMessages,
        max_tokens: 2000,
        temperature: 0.7,
      });

      const rawResponse =
        groqResponse.choices[0]?.message?.content || "Sin respuesta";
      const cleanedResponse = formatForWhatsApp(rawResponse);

      const responseMessage = {
        role: "assistant",
        content: [{ type: "text", text: cleanedResponse }],
      };

      const activeImages = await this.getActivePromptImages();
      const activeLocations = await this.getActiveLocations();

      let locationToSend = null;
      let imagesToSend = [];
      let audiosToSend = [];
      let videosToSend = [];
      let shouldListLocations = false;

      const locationDecision = await this.shouldSendLocation(
        concatenatedUserText,
        cleanedResponse,
        activeLocations
      );

      if (locationDecision.shouldList) {
        shouldListLocations = true;
        let locationsList = "Tenemos las siguientes ubicaciones:\n\n";
        activeLocations.forEach((loc) => {
          locationsList += `• ${loc.name}\n`;
        });
        locationsList += "\n¿De cuál necesitas la ubicación?";
        responseMessage.content[0].text = locationsList;
      } else if (
        locationDecision.shouldSend &&
        locationDecision.specificLocation
      ) {
        locationToSend = locationDecision.specificLocation;
      }

      if (activeImages.length > 0 && !shouldListLocations) {
        const images = activeImages.filter(
          (item) => (item.type || "image") === "image"
        );
        const audios = activeImages.filter((item) => item.type === "audio");
        const videos = activeImages.filter((item) => item.type === "video");

        console.log(
          `\n📦 Multimedia disponible: ${images.length} imágenes, ${videos.length} videos, ${audios.length} audios`
        );

        const shouldSendImages =
          images.length > 0 &&
          (await this.shouldSendMultimedia(
            concatenatedUserText,
            cleanedResponse,
            "imágenes"
          ));

        const shouldSendVideos =
          videos.length > 0 &&
          (await this.shouldSendMultimedia(
            concatenatedUserText,
            cleanedResponse,
            "videos"
          ));

        const shouldSendAudios =
          audios.length > 0 &&
          (await this.shouldSendMultimedia(
            concatenatedUserText,
            cleanedResponse,
            "audios"
          ));

        if (shouldSendImages) {
          imagesToSend = await this.filterMediaWithHybridApproach(
            images,
            concatenatedUserText,
            cleanedResponse,
            "imágenes",
            3
          );
        }

        if (shouldSendVideos) {
          videosToSend = await this.filterMediaWithHybridApproach(
            videos,
            concatenatedUserText,
            cleanedResponse,
            "videos",
            3
          );
        }

        if (shouldSendAudios) {
          audiosToSend = await this.filterMediaWithHybridApproach(
            audios,
            concatenatedUserText,
            cleanedResponse,
            "audios",
            3
          );
        }
      }

      if (locationToSend) {
        console.log("📍 Ubicación a enviar:", {
          name: locationToSend.name,
          latitude: locationToSend.latitude,
          longitude: locationToSend.longitude,
        });
      }

      console.log(
        `\n✅ Resultado final: ${imagesToSend.length} imágenes, ${videosToSend.length} videos, ${audiosToSend.length} audios\n`
      );

      return {
        response: responseMessage,
        locationToSend,
        imagesToSend,
        audiosToSend,
        videosToSend,
        shouldListLocations,
      };
    } catch (error) {
      console.error("❌ Error en chatWithDocument:", error);
      return {
        error: "Error procesando el chat",
        response: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Lo siento, hubo un error al procesar tu mensaje.",
            },
          ],
        },
        locationToSend: null,
        imagesToSend: [],
        audiosToSend: [],
        videosToSend: [],
        shouldListLocations: false,
      };
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
