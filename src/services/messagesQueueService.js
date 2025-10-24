const MessageProcessorService = require("./messageProcessorService");
const { WelcomeMediaService } = require("./welcome-media-service");

class MessageQueueService {
	constructor() {
		this.messageQueues = new Map();
		this.processingLock = new Set();
		this.DEBOUNCE_DELAY = 3000; // para procesar la cola
		this.WELCOME_DELAY = 60000; // 1 minuto para el paquete de bienvenida
		// this.WELCOME_ITEMS = 3;    // ❌ eliminado: ahora se envían todos los ítems
	}

	addToQueue(formattedPhone, newMessage) {
		console.log(
			`[Queue] addToQueue(${formattedPhone}) recibido. msgLen=${
				(newMessage &&
					(newMessage.text || newMessage.body || JSON.stringify(newMessage))
						.length) ||
				"N/A"
			}`
		);

		// Programar bienvenida diaria (el servicio decide si corresponde)
		try {
			console.log(
				`[Queue] Intentando programar bienvenida diaria para ${formattedPhone}...`
			);
			// Antes: WelcomeMediaService.scheduleInitialMedia(formattedPhone, this.WELCOME_DELAY, this.WELCOME_ITEMS)
			WelcomeMediaService.scheduleInitialMedia(
				formattedPhone,
				this.WELCOME_DELAY // ⬅️ sin límite de cantidad
			);
		} catch (e) {
			console.error(
				`[Queue] Error al programar bienvenida para ${formattedPhone}:`,
				e
			);
		}

		const isNewQueue = !this.messageQueues.has(formattedPhone);
		if (isNewQueue) {
			this.messageQueues.set(formattedPhone, []);
			console.log(`[Queue] Nueva cola creada para ${formattedPhone}.`);
		}

		const queue = this.messageQueues.get(formattedPhone);
		queue.push({ message: newMessage, timestamp: Date.now() });
		console.log(
			`[Queue] Cola de ${formattedPhone} ahora tiene ${queue.length} mensaje(s).`
		);

		if (queue.length === 1) {
			console.log(
				`[Queue] Programando processQueue(${formattedPhone}) en ${this.DEBOUNCE_DELAY}ms.`
			);
			setTimeout(() => this.processQueue(formattedPhone), this.DEBOUNCE_DELAY);
		}
	}

	async processQueue(formattedPhone) {
		if (this.processingLock.has(formattedPhone)) {
			console.log(
				`[Queue] processQueue(${formattedPhone}) cancelado: lock activo.`
			);
			return;
		}
		const q = this.messageQueues.get(formattedPhone);
		if (!q || q.length === 0) {
			console.log(
				`[Queue] processQueue(${formattedPhone}) cancelado: cola vacía o inexistente.`
			);
			return;
		}

		console.log(
			`[Queue] >>> INICIO processQueue(${formattedPhone}). Items=${q.length}`
		);
		this.processingLock.add(formattedPhone);

		try {
			await MessageProcessorService.processMessages(formattedPhone);
			console.log(`[Queue] OK processMessages(${formattedPhone}).`);
		} catch (error) {
			console.error(
				`[Queue] Error procesando cola de ${formattedPhone}:`,
				error
			);
		} finally {
			this.messageQueues.delete(formattedPhone);
			this.processingLock.delete(formattedPhone);
			console.log(
				`[Queue] <<< FIN processQueue(${formattedPhone}). Cola eliminada y lock liberado.`
			);
		}
	}

	cleanup() {
		this.messageQueues.clear();
		this.processingLock.clear();
		console.log(`[Queue] cleanup(): colas y locks limpios.`);
	}
}

const instance = new MessageQueueService();
module.exports = instance;
