const { ChatCacheService } = require("./chat-cache-service.js");
const { createHash } = require("crypto");

let embeddingPipeline = null;

class EmbeddingsService {
  static async getEmbeddingOrCachedResponse({ text }) {
    try {
      const hash = createHash("sha256").update(text).digest("hex");
      const { isExists, data } = await ChatCacheService.getChatCache({ hash });

      if (isExists) {
        return { embedding: data.embedding, response: data.response, hash };
      }

      if (!embeddingPipeline) {
        console.log("🔄 Cargando modelo de embeddings...");
        const { pipeline } = await import("@xenova/transformers");
        embeddingPipeline = await pipeline(
          "feature-extraction",
          "Xenova/multilingual-e5-small"
        );
        console.log("✅ Modelo de embeddings cargado");
      }

      const output = await embeddingPipeline(text, {
        pooling: "mean",
        normalize: true,
      });

      const embedding = Array.from(output.data);

      const { cacheData } = await ChatCacheService.setChatCache({
        hash,
        embedding: embedding,
        response: null,
      });

      return { embedding: embedding, response: null, hash };
    } catch (error) {
      console.error("❌ Error al obtener el embedding:", error);
      throw new Error("Error al obtener el embedding");
    }
  }
}

module.exports = {
  EmbeddingsService,
};
