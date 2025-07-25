const { wasender } = require("../config/clients/wasenderapi-client");

class MessageWasendService {
	static async sendMessage({ phone, message }) {
		try {
			const response = await wasender.sendText({
				to: `+${phone}`,
				text: message,
			});
			return response;
		} catch (error) {
			console.error("Error sending message:", error);
			throw error;
		}
	}
}

module.exports = {
	MessageWasendService,
};
