const { wasender } = require("../config/clients/wasenderapi-client");
const fs = require("fs/promises");
const path = require("path");

const formatPhone = (phone) => {
  if (!phone) throw new Error("Phone number is required");
  const normalized = String(phone).trim();
  if (normalized.startsWith("+")) {
    return normalized;
  }
  return `+${normalized.replace(/^\+/, "")}`;
};

const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  pdf: "application/pdf",
};

const extractExtension = (value) => {
  if (!value) return null;
  const match = /\.([A-Za-z0-9]+)(?:$|\?)/.exec(value);
  return match ? match[1].toLowerCase() : null;
};

const resolveMimeType = (source, fallback) => {
  if (!source || typeof source !== "string") {
    return fallback;
  }

  if (source.startsWith("data:")) {
    const match = /^data:([^;]+);/.exec(source);
    return match ? match[1] : fallback;
  }

  try {
    const url = new URL(source);
    const ext = extractExtension(url.pathname);
    if (ext && MIME_BY_EXTENSION[ext]) {
      return MIME_BY_EXTENSION[ext];
    }
  } catch (_) {
    const ext = extractExtension(source);
    if (ext && MIME_BY_EXTENSION[ext]) {
      return MIME_BY_EXTENSION[ext];
    }
  }

  return fallback;
};

class MessageWasendService {
  static async sendMessage({ phone, message }) {
    try {
      const response = await wasender.sendText({
        to: formatPhone(phone),
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
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
      };

      if (location.name) {
        locationPayload.name = String(location.name);
      }

      if (location.address) {
        locationPayload.address = String(location.address);
      }

      const response = await wasender.sendLocation({
        to: formatPhone(phone),
        location: locationPayload,
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
      const response = await wasender.sendImage({
        to: formatPhone(phone),
        imageUrl: imageUrl,
        mimeType: resolveMimeType(imageUrl, "image/jpeg"),
        text: caption || "Imagen compartida",
      });

      console.log(`✅ Imagen enviada a ${phone}`);
      return response;
    } catch (error) {
      console.error("❌ Error sending image:", error);
      console.error("Image data:", { phone, imageUrl });
      throw error;
    }
  }

  static async sendAudio({ phone, audioUrl, caption }) {
    try {
      const response = await wasender.sendAudio({
        to: formatPhone(phone),
        audioUrl: audioUrl,
        mimeType: resolveMimeType(audioUrl, "audio/ogg"),
        text: caption,
      });

      console.log(`✅ Audio enviado a ${phone}`);
      return response;
    } catch (error) {
      console.error("❌ Error sending audio:", error);
      console.error("Audio data:", { phone, audioUrl, caption });
      throw error;
    }
  }

  static async sendVideo({ phone, videoUrl, caption }) {
    try {
      const response = await wasender.sendVideo({
        to: formatPhone(phone),
        videoUrl: videoUrl,
        mimeType: resolveMimeType(videoUrl, "video/mp4"),
        text: caption,
      });

      console.log(`✅ Video enviado a ${phone}`);
      return response;
    } catch (error) {
      console.error("❌ Error sending video:", error);
      console.error("Video data:", { phone, videoUrl, caption });
      throw error;
    }
  }

  static async sendAudioFile({ phone, filePath, mimeType = "audio/ogg" }) {
    try {
      if (!filePath) {
        throw new Error("El archivo de audio es requerido");
      }

      const fileBuffer = await fs.readFile(filePath);
      const fileName = path.basename(filePath) || "audio.ogg";

      const response = await wasender.sendAudio({
        to: formatPhone(phone),
        base64Data: fileBuffer.toString("base64"),
        mimeType,
        fileName,
      });

      console.log(`✅ Audio generado enviado a ${phone}`);
      return response;
    } catch (error) {
      console.error("❌ Error sending generated audio:", error);
      throw error;
    }
  }
}

module.exports = {
  MessageWasendService,
};
