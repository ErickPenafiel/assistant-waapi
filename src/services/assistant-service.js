require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const { cohereClient } = require("../config/clients/cohere-client.js");
const { qdrantClient } = require("../config/clients/qdrant-client.js");
const { ChatHistoryService } = require("./chat-history-service.js");
const { EmbeddingsService } = require("./embeddings-service.js");
const { randomUUID } = require("crypto");
const { db } = require("../config/firebase/config.js");

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

				let cohereResponse;

				try {
					cohereResponse = await cohereClient.chat({
						model,
						documents: contextDocuments,
						messages: normalizedMessages,
						maxTokens: 100,
					});
				} catch (error) {
					console.error("Error en la llamada a Cohere:", error);
					return { error: "Error al procesar el chat con Cohere" };
				}

				const { message: responseMessage } = cohereResponse;

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
