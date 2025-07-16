const { cohereClient } = require("../config/clients/cohere-client.js");
const { ChatCacheService } = require("./chat-cache-service.js");
const { createHash } = require("crypto");

class EmbeddingsService {
	static async getEmbeddingOrCachedResponse({ text }) {
		try {
			const hash = createHash("sha256").update(text).digest("hex");
			const { isExists, data } = await ChatCacheService.getChatCache({ hash });

			if (isExists) {
				return { embedding: data.embedding, response: data.response, hash };
			}

			const { embeddings } = await cohereClient.embed({
				model: "embed-multilingual-v3.0",
				embeddingTypes: ["float"],
				texts: [text],
				inputType: "search_query",
			});

			const { cacheData } = await ChatCacheService.setChatCache({
				hash,
				embedding: embeddings.float[0],
				response: null,
			});

			return { embedding: embeddings.float[0], response: null, hash };
		} catch (error) {
			console.error("❌ Error al obtener el historial de chat:", error);
			throw new Error("Error al obtener el historial de chat");
		}
	}
}

module.exports = {
	EmbeddingsService,
};
