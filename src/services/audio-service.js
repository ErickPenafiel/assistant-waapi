require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { wasender } = require("../config/clients/wasenderapi-client");

class AudioService {
  static async processIncomingAudio({ audioMessage, messageId }) {
    try {
      const audioBuffer = await this.downloadAudioWithWasender(audioMessage);

      if (!audioBuffer) {
        throw new Error("No se pudo descargar el audio");
      }

      console.log(`Audio descargado: ${audioBuffer.byteLength} bytes`);

      const audioFormat = this.detectAudioFormat(audioBuffer);
      console.log(`Formato detectado: ${audioFormat}`);

      const transcribedText = await this.speechToText(audioBuffer, audioFormat);

      return transcribedText;
    } catch (error) {
      console.error("Error en processIncomingAudio:", error);
      return "No se pudo procesar el audio";
    }
  }

  static async downloadAudioWithWasender(audioMessage) {
    try {
      const mediaData = {
        data: {
          messages: {
            key: {
              id: audioMessage.key?.id || crypto.randomUUID(),
            },
            message: {
              audioMessage: {
                url: audioMessage.url,
                mimetype: audioMessage.mimetype || "audio/ogg; codecs=opus",
                mediaKey: audioMessage.mediaKey,
                fileSha256: audioMessage.fileSha256,
                fileLength: audioMessage.fileLength,
                fileName: audioMessage.fileName || "audio.ogg",
              },
            },
          },
        },
      };

      const response = await fetch(
        "https://www.wasenderapi.com/api/decrypt-media",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WASENDER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(mediaData),
        }
      );

      if (!response.ok) {
        throw new Error(`Error decrypting media: ${response.statusText}`);
      }

      const result = await response.json();
      const publicUrl = result.publicUrl;

      if (!publicUrl) {
        throw new Error("No se recibió URL pública del archivo descifrado");
      }

      const audioResponse = await fetch(publicUrl);
      if (!audioResponse.ok) {
        throw new Error(
          `Error downloading decrypted audio: ${audioResponse.statusText}`
        );
      }

      return await audioResponse.arrayBuffer();
    } catch (error) {
      console.error("Error descargando audio con WASender:", error);
      throw error;
    }
  }

  static detectAudioFormat(buffer) {
    const uint8Array = new Uint8Array(buffer);

    if (
      uint8Array[0] === 0x4f &&
      uint8Array[1] === 0x67 &&
      uint8Array[2] === 0x67 &&
      uint8Array[3] === 0x53
    ) {
      return "ogg";
    }
    if (uint8Array[0] === 0xff && (uint8Array[1] & 0xe0) === 0xe0) {
      return "mp3";
    }
    if (
      uint8Array[0] === 0x66 &&
      uint8Array[1] === 0x74 &&
      uint8Array[2] === 0x79 &&
      uint8Array[3] === 0x70
    ) {
      return "m4a";
    }
    if (
      uint8Array[0] === 0x52 &&
      uint8Array[1] === 0x49 &&
      uint8Array[2] === 0x46 &&
      uint8Array[3] === 0x46
    ) {
      return "wav";
    }

    return "opus";
  }

  static async speechToText(audioBuffer, format = "opus") {
    if (process.env.GROQ_API_KEY) {
      const result = await this.groqSpeechToText(audioBuffer, format);
      if (result) return result;
    }

    if (process.env.WIT_AI_TOKEN) {
      const result = await this.witSpeechToText(audioBuffer, format);
      if (result) return result;
    }

    return "Audio recibido pero no se pudo transcribir";
  }

  static async groqSpeechToText(audioBuffer, format = "opus") {
    let tempFilePath = null;

    try {
      const uint8Array = new Uint8Array(audioBuffer);
      console.log(
        `Primera bytes del audio: [${Array.from(uint8Array.slice(0, 10)).join(
          ", "
        )}]`
      );

      const extensionsToTry =
        format === "opus" ? ["ogg", "opus", "wav"] : [format];

      for (const ext of extensionsToTry) {
        try {
          console.log(`Intentando con extensión: ${ext}`);

          const tempFileName = `audio_${Date.now()}_${crypto
            .randomUUID()
            .substring(0, 8)}.${ext}`;
          tempFilePath = path.join(__dirname, "../../temp", tempFileName);

          await fs.mkdir(path.dirname(tempFilePath), { recursive: true });
          await fs.writeFile(tempFilePath, Buffer.from(audioBuffer));

          const stats = await fs.stat(tempFilePath);
          console.log(`Archivo temporal creado: ${stats.size} bytes`);

          const fileBuffer = await fs.readFile(tempFilePath);

          let mimeType;
          switch (ext) {
            case "mp3":
              mimeType = "audio/mpeg";
              break;
            case "m4a":
              mimeType = "audio/mp4";
              break;
            case "wav":
              mimeType = "audio/wav";
              break;
            case "opus":
              mimeType = "audio/opus";
              break;
            case "ogg":
            default:
              mimeType = "audio/ogg";
              break;
          }

          const formData = new FormData();
          const blob = new Blob([fileBuffer], { type: mimeType });
          formData.append("file", blob, `audio.${ext}`);
          formData.append("model", "whisper-large-v3");
          formData.append("language", "es");
          formData.append("response_format", "json");

          console.log(`Enviando a Groq: ${ext} (${mimeType})`);

          const response = await fetch(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
              },
              body: formData,
            }
          );

          console.log(`Groq response status: ${response.status}`);

          if (response.ok) {
            const result = await response.json();
            console.log("Transcripción exitosa:", result.text);
            return result.text || null;
          } else {
            const errorText = await response.text();
            console.error(`Error con ${ext}:`, errorText);

            if (tempFilePath) {
              await fs.unlink(tempFilePath).catch(() => {});
              tempFilePath = null;
            }

            continue;
          }
        } catch (formatError) {
          console.error(`Error probando formato ${ext}:`, formatError);
          if (tempFilePath) {
            await fs.unlink(tempFilePath).catch(() => {});
            tempFilePath = null;
          }
          continue;
        }
      }

      return null;
    } catch (error) {
      console.error("Error en Groq speech to text:", error);
      return null;
    } finally {
      if (tempFilePath) {
        try {
          await fs.unlink(tempFilePath);
        } catch (cleanupError) {
          console.error("Error limpiando archivo temporal:", cleanupError);
        }
      }
    }
  }

  static async witSpeechToText(audioBuffer, format = "opus") {
    try {
      const mimeType = format === "mp3" ? "audio/mpeg" : "audio/ogg";

      const response = await fetch("https://api.wit.ai/speech?v=20220622", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WIT_AI_TOKEN}`,
          "Content-Type": mimeType,
        },
        body: audioBuffer,
      });

      if (response.ok) {
        const result = await response.json();
        return result.text || result._text || null;
      } else {
        const error = await response.text();
        console.error("Error respuesta Wit.ai:", error);
        return null;
      }
    } catch (error) {
      console.error("Error en Wit.ai speech to text:", error);
      return null;
    }
  }

  static async generateResponseAudio(text) {
    try {
      if (text.length > 200) {
        text = text.substring(0, 200);
      }

      const response = await fetch(
        `https://translate.google.com/translate_tts?ie=UTF-8&tl=es&client=tw-ob&q=${encodeURIComponent(
          text
        )}`
      );

      if (response.ok) {
        return await response.arrayBuffer();
      }

      throw new Error("No se pudo generar audio con Google TTS");
    } catch (error) {
      console.error("Error en Google TTS:", error);
      throw error;
    }
  }

  static async saveTemporaryAudio(audioBuffer, extension = "ogg") {
    const fileName = `response_${Date.now()}_${crypto.randomUUID()}.${extension}`;
    const tempPath = path.join(__dirname, "../../temp", fileName);

    await fs.mkdir(path.dirname(tempPath), { recursive: true });
    await fs.writeFile(tempPath, Buffer.from(audioBuffer));

    return tempPath;
  }

  static async cleanupTempFiles() {
    try {
      const tempDir = path.join(__dirname, "../../temp");

      try {
        await fs.access(tempDir);
      } catch {
        return;
      }

      const files = await fs.readdir(tempDir);
      const oneHourAgo = Date.now() - 60 * 60 * 1000;

      for (const file of files) {
        try {
          const filePath = path.join(tempDir, file);
          const stats = await fs.stat(filePath);

          if (stats.mtime.getTime() < oneHourAgo) {
            await fs.unlink(filePath);
            console.log(`Archivo temporal eliminado: ${file}`);
          }
        } catch (fileError) {
          console.error(`Error procesando archivo ${file}:`, fileError);
        }
      }
    } catch (error) {
      console.error("Error limpiando archivos temporales:", error);
    }
  }
}

module.exports = {
  AudioService,
};
