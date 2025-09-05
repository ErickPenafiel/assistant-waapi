class MessageHandler {
  static async handleMessagesUpsert(event) {
    const { messages } = event.data;

    if (!messages || messages.length === 0) {
      console.log("⚠️ No hay mensajes en el evento.");
      return;
    }

    for (const msg of messages) {
      const sender = msg.from;
      const content = msg.text?.body || "[sin contenido]";
      console.log(`💬 Mensaje recibido de ${sender}: ${content}`);
    }
  }
}
