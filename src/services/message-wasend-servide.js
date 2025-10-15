const { text } = require("express");
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

  static async sendLocation({ phone, location }) {
    try {
      // Validar que location tenga los campos necesarios
      if (!location.latitude || !location.longitude) {
        throw new Error("La ubicación debe tener latitud y longitud");
      }

      const locationPayload = {
        to: `+${phone}`,
        text: location.name || "Ubicación compartida",
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        name: String(location.name || "Ubicación"),
        address: String(location.address || ""),
      };

      console.log("📍 Enviando ubicación:", locationPayload);

      const response = await wasender.sendLocation({
        to: `+${phone}`,
        location: {
          latitude: Number(location.latitude),
          longitude: Number(location.longitude),
          name: String(location.name || "Ubicación"),
          address: String(location.address || ""),
        },
        text: location.name || "Ubicación compartida",
      });
      console.log(`✅ Ubicación enviada a ${phone}:`, location.name);
      return response;
    } catch (error) {
      console.error("❌ Error sending location:", error);
      console.error("Location data:", location);
      throw error;
    }
  }

  static async sendImage({ phone, imageUrl, caption }) {
    try {
      const imagePayload = {
        to: `+${phone}`,
        text: caption || "Imagen compartida", // ✅ Asegurar que siempre haya texto
        imageUrl: imageUrl,
      };

      console.log("🖼️ Enviando imagen:", { url: imageUrl, caption });

      const response = await wasender.sendImage(imagePayload);
      console.log(`✅ Imagen enviada a ${phone}`);
      return response;
    } catch (error) {
      console.error("❌ Error sending image:", error);
      throw error;
    }
  }

  static async sendAudio({ phone, audioUrl, caption }) {
    try {
      const audioPayload = {
        to: `+${phone}`,
        audioUrl: audioUrl,
        text: caption, // Caption es opcional
      };

      console.log("🎵 Enviando audio:", audioPayload);

      const response = await wasender.sendAudio(audioPayload);
      console.log(`✅ Audio enviado a ${phone}`);
      return response;
    } catch (error) {
      console.error("❌ Error sending audio:", error);
      console.error("Audio payload:", audioPayload);
      console.error("Error details:", error);
      throw error;
    }
  }

  static async sendVideo({ phone, videoUrl, caption }) {
    try {
      const videoPayload = {
        to: `+${phone}`,
        videoUrl: videoUrl,
        text: caption, // Caption es opcional
      };

      console.log("🎬 Enviando video:", videoPayload);

      const response = await wasender.sendVideo(videoPayload);
      console.log(`✅ Video enviado a ${phone}`);
      return response;
    } catch (error) {
      console.error("❌ Error sending video:", error);
      console.error("Video payload:", videoPayload);
      console.error("Error details:", error);
      throw error;
    }
  }
}

module.exports = {
  MessageWasendService,
};
