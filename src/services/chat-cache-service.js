const { db } = require("../config/firebase/config.js");

class ChatCacheService {
	static async getChatCache({ hash }) {
		try {
			const chatCacheRef = db.collection("chat_cache").doc(hash);
			const doc = await chatCacheRef.get();

			if (!doc.exists) {
				console.warn(`⚠️ No se encontró el cache al texto: ${hash}`);
				return {
					isExists: false,
					data: null,
				};
			}

			const data = doc.data();
			return { isExists: true, data };
		} catch (error) {
			console.error("❌ Error al obtener el cache:", error);
			throw new Error("Error al obtener el cache");
		}
	}

	static async setChatCache({ hash, embedding, response }) {
		try {
			const chatCacheRef = db.collection("chat_cache").doc(hash);
			const data = await chatCacheRef.set({
				embedding,
				response,
				hash,
			});

			return {
				cacheData: {
					embedding,
					response,
					hash,
				},
			};
		} catch (error) {
			console.error("❌ Error al guardar el cache:", error);
			throw new Error("Error al guardar el cache");
		}
	}
}

module.exports = {
	ChatCacheService,
};
