require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const { db } = require("../config/firebase/config.js");

class ChatHistoryService {
	static async getChatHistory({ userId }) {
		try {
			const chatHistoryRef = db
				.collection(process.env.COLLECTION_NAME)
				.doc(userId);
			const doc = await chatHistoryRef.get();

			if (!doc.exists) {
				console.warn(
					`⚠️ No se encontró historial de chat para el usuario: ${userId}`
				);

				const initialData = {
					chat: [],
					automaticSend: true,
				};

				await chatHistoryRef.set(initialData);
			}

			const data = doc.data();
			return { data };
		} catch (error) {
			console.error("❌ Error al obtener el historial de chat:", error);
			throw new Error("Error al obtener el historial de chat");
		}
	}

	static async updateChatHistory({ userId, data }) {
		try {
			const chatHistoryRef = db
				.collection(process.env.COLLECTION_NAME)
				.doc(userId);
			const doc = await chatHistoryRef.get();

			if (!doc.exists) {
				console.warn(
					`⚠️ No se encontró historial de chat para el usuario: ${userId}, creando uno nuevo.`
				);
				await chatHistoryRef.set({ history: [] });
			}

			await chatHistoryRef.update({
				...data,
			});

			console.log(
				`✅ Historial de chat actualizado para el usuario: ${userId}`
			);
			return { success: true };
		} catch (error) {
			console.error("❌ Error al actualizar el historial de chat:", error);
			return { error: "Error al actualizar el historial de chat" };
		}
	}
}

module.exports = {
	ChatHistoryService,
};
