require("dotenv").config({ path: process.env.ENV_PATH || ".env" });

class MessageService {
  static async sendMessage({ phone, message, instanceId }) {
    if (!phone || !message) {
      return {
        error: "Faltan parámetros: 'phone' y/o 'message'",
      };
    }

    try {
      const fetchedSentMessage = await fetch(
        `${process.env.API_URL}/${instanceId}/client/action/send-message`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${process.env.API_KEY}`,
          },
          body: JSON.stringify({
            chatId: phone,
            message: message,
          }),
        }
      );

      if (!fetchedSentMessage.ok) {
        const errorText = await fetchedSentMessage.text();
        console.error("Error al enviar el mensaje:", errorText);
        return { error: "Error al enviar el mensaje" };
      }

      const response = await fetchedSentMessage.json();

      if (response.error) {
        console.error("Error en la respuesta del servidor:", response.error);
        return { error: response.error };
      }

      console.log(`✅ Mensaje enviado exitosamente a ${phone}: ${message}`);
      return { success: true, data: response };
    } catch (error) {
      console.error("Error en sendMessage:", error);
      return { error: "Error al enviar el mensaje" };
    }
  }
}

module.exports = {
  MessageService,
};
