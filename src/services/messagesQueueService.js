const MessageProcessorService = require("./messageProcessorService");

class MessageQueueService {
  constructor() {
    this.messageQueues = new Map();
    this.processingLock = new Set();
    this.DEBOUNCE_DELAY = 3000;
  }

  addToQueue(formattedPhone, newMessage) {
    if (!this.messageQueues.has(formattedPhone)) {
      this.messageQueues.set(formattedPhone, []);
    }

    const queue = this.messageQueues.get(formattedPhone);
    queue.push({
      message: newMessage,
      timestamp: Date.now(),
    });

    if (queue.length === 1) {
      setTimeout(() => {
        this.processQueue(formattedPhone);
      }, this.DEBOUNCE_DELAY);
    }
  }

  async processQueue(formattedPhone) {
    if (this.processingLock.has(formattedPhone)) {
      return;
    }
    if (
      !this.messageQueues.has(formattedPhone) ||
      this.messageQueues.get(formattedPhone).length === 0
    ) {
      return;
    }
    this.processingLock.add(formattedPhone);
    try {
      await MessageProcessorService.processMessages(formattedPhone);
    } catch (error) {
      console.error(`Error procesando cola de ${formattedPhone}:`, error);
    } finally {
      this.messageQueues.delete(formattedPhone);
      this.processingLock.delete(formattedPhone);
    }
  }

  cleanup() {
    this.messageQueues.clear();
    this.processingLock.clear();
  }
}

const instance = new MessageQueueService();
module.exports = instance;
