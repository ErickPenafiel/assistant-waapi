require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const { db } = require("../config/firebase/config.js");

class ChatHistoryService {
	static async getChatHistory({ userId }) {
		try {
			const chatHistoryRef = db.collection(COLLECTION).doc(userId);
			const snap = await chatHistoryRef.get();

			if (!snap.exists) {
				const initialData = {
					archivedAt: null,
					chat: [],
				};
				await chatHistoryRef.set(initialData);
				return { data: initialData };
			}

			return { data: snap.data() };
		} catch (error) {
			console.error("❌ Error al obtener el historial de chat:", error);
			throw new Error("Error al obtener el historial de chat");
		}
	}

	static async updateChatHistory({ userId, data }) {
		try {
			const chatHistoryRef = db.collection(COLLECTION).doc(userId);
			const snap = await chatHistoryRef.get();

			if (!snap.exists) {
				await chatHistoryRef.set({
					archivedAt: null,
					chat: [],
				});
			}

			await chatHistoryRef.update({ ...data });

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
