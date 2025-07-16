const { cohereClient } = require("../config/clients/cohere-client.js");
const { qdrantClient } = require("../config/clients/qdrant-client.js");
const { ChatHistoryService } = require("./chat-history-service.js");
const { EmbeddingsService } = require("./embeddings-service.js");
const { randomUUID } = require("crypto");

class AssistantService {
	static async chatWithDocument({ phone, text }) {
		if (!phone || !text) {
			return {
				error: "Faltan parámetros: 'phone' y/o 'text'",
			};
		}

		try {
			const { data } = await ChatHistoryService.getChatHistory({
				userId: phone,
			});

			const model = "command-a-03-2025";
			const collection = "documentos";

			const { chat: messages } = data;

			try {
				const lastUserMessage = [...messages]
					.reverse()
					.find((m) => m.role === "user");

				const lastUserText =
					typeof lastUserMessage?.content === "string"
						? lastUserMessage.content
						: Array.isArray(lastUserMessage?.content)
						? lastUserMessage.content.find((c) => c.type === "text")?.text
						: lastUserMessage?.content?.text;

				if (!lastUserText) {
					return {
						error: "No se encontró texto en el último mensaje del usuario",
					};
				}

				const { embedding, response, hash } =
					await EmbeddingsService.getEmbeddingOrCachedResponse({
						text: lastUserText,
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
				} catch (e) {
					console.error(`Error buscando en ${collection}:`, e.message);
				}

				const normalizedMessages = messages.map((m) => ({
					role: m.role,
					content:
						typeof m.content === "string"
							? m.content
							: Array.isArray(m.content)
							? m.content.map((c) => c.text).join("\n")
							: m.content?.text || "",
				}));

				const cohereResponse = await cohereClient.chat({
					model,
					documents: contextDocuments,
					messages: normalizedMessages,
				});

				const { message: responseMessage } = cohereResponse;

				return {
					data: {
						response: responseMessage,
					},
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
}

module.exports = {
	AssistantService,
};
