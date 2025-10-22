require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const fs = require("fs");
const crypto = require("crypto");

const DEFAULT_API_URL = "https://panel.astroestudiosrl.com/whatsapp";

const apiUrl = (
  process.env.WHATSAPP_API_URL ||
  process.env.WASENDER_API_URL ||
  DEFAULT_API_URL
).replace(/\/$/, "");

const apiKey =
  process.env.WHATSAPP_API_KEY || process.env.WASENDER_API_KEY || "";
const accountId =
  process.env.WHATSAPP_ACCOUNT_ID || process.env.WASENDER_ACCOUNT_ID || "";
const webhookSecret =
  process.env.WHATSAPP_WEBHOOK_SECRET ||
  process.env.WASENDER_WEBHOOK_SECRET ||
  "";

class WhatsAppApiClient {
  constructor({ apiUrl, apiKey, accountId, webhookSecret }) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.accountId = accountId;
    this.webhookSecret = webhookSecret;
  }

  ensureCredentials() {
    if (!this.apiKey) {
      throw new Error("WhatsApp API key is not configured");
    }
    if (!this.accountId) {
      throw new Error("WhatsApp account ID is not configured");
    }
  }

  get messagesEndpoint() {
    return `${this.apiUrl}/accounts/${this.accountId}/messages`;
  }

  formatPhoneNumber(phone) {
    if (!phone) {
      throw new Error("Phone number is required");
    }

    const normalized = String(phone).trim();
    if (normalized.startsWith("+")) {
      return normalized;
    }

    const digits = normalized.replace(/^\+/, "");
    return `+${digits}`;
  }

  buildMediaContent({
    mediaUrl,
    base64Data,
    mimeType,
    fileName,
    text,
    defaults,
  }) {
    const content = {};

    if (base64Data) {
      content.base64Data = base64Data;
      content.mimeType = mimeType || defaults.mimeType;
      content.fileName = fileName || defaults.fileName;
    } else if (mediaUrl) {
      content.mediaUrl = mediaUrl;
      content.mimeType = mimeType || defaults.mimeType;
      if (fileName) {
        content.fileName = fileName;
      }
    } else {
      throw new Error("Media URL or base64 data is required");
    }

    if (text) {
      content.text = text;
    }

    return content;
  }

  async sendRequest(payload) {
    this.ensureCredentials();

    const response = await fetch(this.messagesEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "x-account-id": this.accountId,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      let reason = responseText;
      try {
        const parsed = JSON.parse(responseText);
        reason = parsed.message || parsed.error || responseText;
      } catch (_) {
        reason = responseText || "Unknown error";
      }

      throw new Error(
        `WhatsApp API error ${response.status}: ${reason}`.trim()
      );
    }

    if (!responseText) {
      return null;
    }

    try {
      return JSON.parse(responseText);
    } catch (error) {
      return responseText;
    }
  }

  async sendText({ to, text }) {
    if (!text) {
      throw new Error("Text message content is required");
    }

    return this.sendRequest({
      toNumber: this.formatPhoneNumber(to),
      messageType: "text",
      content: { text },
    });
  }

  async sendLocation({ to, location }) {
    if (!location) {
      throw new Error("Location payload is required");
    }

    const { latitude, longitude, name, address } = location;
    if (latitude === undefined || longitude === undefined) {
      throw new Error("Location requires latitude and longitude");
    }

    return this.sendRequest({
      toNumber: this.formatPhoneNumber(to),
      messageType: "location",
      content: {
        location: {
          latitude: Number(latitude),
          longitude: Number(longitude),
          name: name ? String(name) : undefined,
          address: address ? String(address) : undefined,
        },
      },
    });
  }

  async sendImage({ to, imageUrl, base64Data, mimeType, fileName, text }) {
    const content = this.buildMediaContent({
      mediaUrl: imageUrl,
      base64Data,
      mimeType,
      fileName,
      text,
      defaults: {
        mimeType: "image/jpeg",
        fileName: "image.jpg",
      },
    });
    return this.sendRequest({
      toNumber: this.formatPhoneNumber(to),
      messageType: "image",
      content,
    });
  }

  async sendAudio({ to, audioUrl, base64Data, mimeType, fileName, text }) {
    const content = this.buildMediaContent({
      mediaUrl: audioUrl,
      base64Data,
      mimeType,
      fileName,
      text,
      defaults: {
        mimeType: "audio/ogg",
        fileName: "audio.ogg",
      },
    });

    return this.sendRequest({
      toNumber: this.formatPhoneNumber(to),
      messageType: "audio",
      content,
    });
  }

  async sendVideo({ to, videoUrl, base64Data, mimeType, fileName, text }) {
    const content = this.buildMediaContent({
      mediaUrl: videoUrl,
      base64Data,
      mimeType,
      fileName,
      text,
      defaults: {
        mimeType: "video/mp4",
        fileName: "video.mp4",
      },
    });

    return this.sendRequest({
      toNumber: this.formatPhoneNumber(to),
      messageType: "video",
      content,
    });
  }

  async sendDocument({
    to,
    documentUrl,
    base64Data,
    mimeType,
    fileName,
    text,
  }) {
    const content = this.buildMediaContent({
      mediaUrl: documentUrl,
      base64Data,
      mimeType,
      fileName,
      text,
      defaults: {
        mimeType: "application/octet-stream",
        fileName: "document",
      },
    });

    return this.sendRequest({
      toNumber: this.formatPhoneNumber(to),
      messageType: "document",
      content,
    });
  }

  async sendMedia({ to, media, mediaType, text, mimeType, fileName }) {
    if (!mediaType) {
      throw new Error("Media type is required");
    }

    const buffer = await this.resolveMediaBuffer(media);
    const base64Data = buffer.toString("base64");
    const safeFileName =
      fileName || this.buildDefaultFileName(mediaType, mimeType);

    switch (mediaType) {
      case "audio":
        return this.sendAudio({
          to,
          base64Data,
          mimeType: mimeType || "audio/ogg",
          fileName: safeFileName,
          text,
        });
      case "video":
        return this.sendVideo({
          to,
          base64Data,
          mimeType: mimeType || "video/mp4",
          fileName: safeFileName,
          text,
        });
      case "image":
        return this.sendImage({
          to,
          base64Data,
          mimeType: mimeType || "image/jpeg",
          fileName: safeFileName,
          text,
        });
      case "document":
        return this.sendDocument({
          to,
          base64Data,
          mimeType: mimeType || "application/pdf",
          fileName: safeFileName,
          text,
        });
      default:
        throw new Error(`Unsupported media type: ${mediaType}`);
    }
  }

  async resolveMediaBuffer(media) {
    if (!media) {
      throw new Error("Media payload is required");
    }

    if (Buffer.isBuffer(media)) {
      return media;
    }

    if (media instanceof Uint8Array) {
      return Buffer.from(media);
    }

    if (typeof media === "string") {
      return fs.promises.readFile(media);
    }

    if (media.path) {
      return fs.promises.readFile(media.path);
    }

    if (typeof media.pipe === "function") {
      return new Promise((resolve, reject) => {
        const chunks = [];
        media.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        media.on("end", () => resolve(Buffer.concat(chunks)));
        media.on("error", reject);
      });
    }

    throw new Error("Unsupported media input type");
  }

  buildDefaultFileName(mediaType, mimeType) {
    const extensionFromMime =
      mimeType && mimeType.includes("/")
        ? mimeType.split("/")[1].split("+")[0]
        : null;

    const fallbackExtensions = {
      audio: "ogg",
      video: "mp4",
      image: "jpg",
      document: "pdf",
    };

    const extension =
      extensionFromMime || fallbackExtensions[mediaType] || "bin";
    return `${mediaType}.${extension}`;
  }

  async handleWebhookEvent(adapter) {
    const rawBody = adapter.getRawBody();

    if (!rawBody || (rawBody.length !== undefined && rawBody.length === 0)) {
      throw new Error("Empty webhook body");
    }

    if (this.webhookSecret) {
      const signatureHeader = adapter.getHeader("x-webhook-signature");

      if (!signatureHeader) {
        throw new Error("Missing webhook signature header");
      }

      let providedSignature;
      try {
        providedSignature = Buffer.from(signatureHeader, "hex");
      } catch (error) {
        throw new Error("Invalid webhook signature format");
      }

      const hmac = crypto
        .createHmac("sha256", this.webhookSecret)
        .update(rawBody)
        .digest();

      if (
        providedSignature.length !== hmac.length ||
        !crypto.timingSafeEqual(providedSignature, hmac)
      ) {
        throw new Error("Invalid webhook signature");
      }
    }

    const bodyString =
      typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

    try {
      return JSON.parse(bodyString);
    } catch (error) {
      throw new Error("Invalid webhook payload");
    }
  }
}

const wasender = new WhatsAppApiClient({
  apiUrl,
  apiKey,
  accountId,
  webhookSecret,
});

module.exports = {
  wasender,
};
