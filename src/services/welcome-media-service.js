const { admin } = require("../config/firebase/config");
const { MessageWasendService } = require("./message-wasend-servide");

const lastWelcomeByPhone = new Map();

let welcomeItemsCache = [];
let listenerStarted = false;
let unsubscribeWelcome = null;
let delayMsBetweenItems = 1500;

function nowLaPazISO() {
	return new Date().toLocaleString("es-BO", {
		timeZone: "America/La_Paz",
		hour12: false,
	});
}

function getLocalDateKey(date = new Date(), tz = "America/La_Paz") {
	const parts = new Intl.DateTimeFormat("es-BO", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);

	const y = parts.find((p) => p.type === "year").value;
	const m = parts.find((p) => p.type === "month").value;
	const d = parts.find((p) => p.type === "day").value;
	return `${y}-${m}-${d}`;
}

/**
 * Normaliza/valida items provenientes de Firestore.
 * Acepta: { type, description|caption, url, location{lat,lng,name?,address?} }
 */
function normalizeItems(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];

	for (const [i, it] of raw.entries()) {
		const type = String(it?.type || "")
			.toLowerCase()
			.trim();
		const description =
			typeof it?.description === "string"
				? it.description
				: typeof it?.caption === "string"
				? it.caption
				: "";

		if (type === "text") {
			if (!description) continue;
			out.push({ type, description });
		} else if (type === "image" || type === "video") {
			const url = typeof it?.url === "string" ? it.url : "";
			if (!url) {
				console.warn(
					`[WelcomeMedia] ${nowLaPazISO()} | Item ${
						i + 1
					} (${type}) ignorado: url vacía`
				);
				continue;
			}
			out.push({ type, description, url });
		} else if (type === "location") {
			const loc = it?.location || {};
			const lat = Number(loc.lat);
			const lng = Number(loc.lng);
			if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
				console.warn(
					`[WelcomeMedia] ${nowLaPazISO()} | Item ${
						i + 1
					} (location) ignorado: lat/lng inválidos`
				);
				continue;
			}
			const name = typeof loc.name === "string" ? loc.name : "";
			const address = typeof loc.address === "string" ? loc.address : "";
			out.push({ type, description, location: { lat, lng, name, address } });
		} else {
			console.warn(
				`[WelcomeMedia] ${nowLaPazISO()} | Item ${
					i + 1
				} ignorado: type inválido "${it?.type}"`
			);
		}
	}

	return out;
}

/**
 * Listener a 'mensajes-programados/mensaje-bienvenida' para mantener cache y delay actualizados
 */
function ensureWelcomeListener() {
	if (listenerStarted) return;
	listenerStarted = true;

	if (!admin || typeof admin.firestore !== "function") {
		console.warn(
			`[WelcomeMedia] ${nowLaPazISO()} | Firebase Admin no inicializado. Cache vacío hasta inicializar.`
		);
		return;
	}

	const col = "mensajes-programados";
	const docId = "mensaje-bienvenida";
	const docRef = admin.firestore().collection(col).doc(docId);

	try {
		unsubscribeWelcome = docRef.onSnapshot(
			(snap) => {
				if (!snap.exists) {
					console.warn(
						`[WelcomeMedia] ${nowLaPazISO()} | Doc ${col}/${docId} no existe. Cache en blanco.`
					);
					welcomeItemsCache = [];
					return;
				}
				const data = snap.data() || {};
				const normalized = normalizeItems(data.items);
				welcomeItemsCache = normalized;

				if (typeof data.delayMsBetweenItems === "number") {
					delayMsBetweenItems = Number.isFinite(data.delayMsBetweenItems)
						? Math.max(0, data.delayMsBetweenItems)
						: 1500;
				}

				console.log(
					`[WelcomeMedia] ${nowLaPazISO()} | Cache de bienvenida actualizada. ${
						normalized.length
					} item(s). Delay entre items: ${delayMsBetweenItems} ms.`
				);
			},
			(err) => {
				console.error(
					`[WelcomeMedia] ${nowLaPazISO()} | Error en listener de Firestore:`,
					err
				);
			}
		);

		console.log(
			`[WelcomeMedia] ${nowLaPazISO()} | Listener Firestore iniciado en ${col}/${docId}.`
		);
	} catch (err) {
		console.error(
			`[WelcomeMedia] ${nowLaPazISO()} | No se pudo iniciar listener:`,
			err
		);
	}
}

function getWelcomeItemsFromCache() {
	ensureWelcomeListener();
	return Array.isArray(welcomeItemsCache) ? welcomeItemsCache : [];
}

/**
 * Lectura puntual del doc para el PRIMER envío (no depender de la caché)
 */
async function fetchWelcomeDocOnce() {
	const col = "mensajes-programados";
	const docId = "mensaje-bienvenida";
	const snap = await admin.firestore().collection(col).doc(docId).get();
	if (!snap.exists) {
		return { enabled: true, delayMsBetweenItems: 1500, items: [] };
	}
	const d = snap.data() || {};
	return {
		enabled: d.enabled !== false,
		delayMsBetweenItems:
			typeof d.delayMsBetweenItems === "number" &&
			Number.isFinite(d.delayMsBetweenItems)
				? Math.max(0, d.delayMsBetweenItems)
				: 1500,
		items: normalizeItems(d.items),
	};
}

async function sendItemByType(phone, item) {
	switch (item.type) {
		case "text":
			await MessageWasendService.sendMessage({
				phone,
				message: item.description || "",
			});
			break;

		case "image":
			await MessageWasendService.sendImage({
				phone,
				imageUrl: item.url,
				caption: item.description || "",
			});
			break;

		case "video":
			await MessageWasendService.sendVideo({
				phone,
				videoUrl: item.url,
				caption: item.description || "",
			});
			break;

		case "location":
			await MessageWasendService.sendLocation({
				phone,
				location: {
					latitude: item.location.lat,
					longitude: item.location.lng,
					name: item.location.name || undefined,
					address: item.location.address || undefined,
				},
				message: item.description || undefined,
			});
			break;

		default:
			throw new Error(`Tipo no soportado: ${item.type}`);
	}
}

class WelcomeMediaService {
	/**
	 * Programa el envío de bienvenida SOLO si no se envió HOY (America/La_Paz).
	 * Hace una lectura puntual del doc al momento de enviar para evitar race con el listener.
	 * @param {string} phone
	 * @param {number} delayMs - tiempo inicial antes de empezar a enviar (ms). Default 60000.
	 */
	static async scheduleInitialMedia(phone, delayMs = 60000) {
		if (!phone) {
			console.warn(
				`[WelcomeMedia] ${nowLaPazISO()} | phone vacío, no programo.`
			);
			return;
		}

		const todayKey = getLocalDateKey();
		const lastKey = lastWelcomeByPhone.get(phone);

		console.log(
			`[WelcomeMedia] ${nowLaPazISO()} | scheduleInitialMedia(phone=${phone}, delayMs=${delayMs}) | today=${todayKey} | lastKey=${lastKey}`
		);

		if (lastKey === todayKey) {
			console.log(
				`[WelcomeMedia] ${nowLaPazISO()} | Ya se envió hoy para ${phone}. NO programo.`
			);
			return;
		}

		const fireAt = new Date(Date.now() + delayMs);
		console.log(
			`[WelcomeMedia] ${nowLaPazISO()} | Programado envío para ${phone} a las ${fireAt.toLocaleString(
				"es-BO",
				{ timeZone: "America/La_Paz", hour12: false }
			)}`
		);

		setTimeout(async () => {
			console.log(
				`[WelcomeMedia] ${nowLaPazISO()} | Timer disparado para ${phone}. Comienzo envío.`
			);

			try {
				// Tener listener activo para futuras actualizaciones
				ensureWelcomeListener();

				// Lectura puntual (estado fresco del doc)
				const live = await fetchWelcomeDocOnce();

				if (!live.enabled) {
					console.log(
						`[WelcomeMedia] ${nowLaPazISO()} | Mensaje de bienvenida deshabilitado en Firestore. No envío.`
					);
					// No marcamos como enviado para permitir reintento si luego se habilita
					return;
				}

				const items =
					live.items && live.items.length
						? live.items
						: getWelcomeItemsFromCache();
				const perItemDelay =
					typeof live.delayMsBetweenItems === "number" &&
					Number.isFinite(live.delayMsBetweenItems)
						? Math.max(0, live.delayMsBetweenItems)
						: delayMsBetweenItems;

				if (!items.length) {
					console.warn(
						`[WelcomeMedia] ${nowLaPazISO()} | Doc sin items. No envío. Revisa 'mensajes-programados/mensaje-bienvenida'.`
					);
					// No marcamos como enviado; se puede reintentar tras cargar items
					return;
				}

				console.log(
					`[WelcomeMedia] ${nowLaPazISO()} | Enviaré ${
						items.length
					} item(s) en orden. Delay=${perItemDelay}ms`
				);

				let sentCount = 0;
				for (let i = 0; i < items.length; i++) {
					const item = items[i];
					console.log(
						`[WelcomeMedia] ${nowLaPazISO()} | Enviando item ${i + 1}/${
							items.length
						} tipo=${item.type}`
					);
					try {
						await sendItemByType(phone, item);
						sentCount++;
					} catch (err) {
						console.error(
							`[WelcomeMedia] ${nowLaPazISO()} | Error enviando item ${i + 1}:`,
							err
						);
					}

					if (i < items.length - 1 && perItemDelay > 0) {
						await new Promise((r) => setTimeout(r, perItemDelay));
					}
				}

				if (sentCount > 0) {
					// ✅ Marcar como enviado HOY solo si se envió al menos 1 item
					lastWelcomeByPhone.set(phone, getLocalDateKey());
					console.log(
						`[WelcomeMedia] ${nowLaPazISO()} | Envío de bienvenida COMPLETADO (${sentCount}/${
							items.length
						}) para ${phone}.`
					);
				} else {
					// No se envió nada; no bloquear reintentos hoy
					lastWelcomeByPhone.delete(phone);
					console.log(
						`[WelcomeMedia] ${nowLaPazISO()} | No se envió ningún item. Marca revertida para permitir reintento.`
					);
				}
			} catch (err) {
				console.error(
					`[WelcomeMedia] ${nowLaPazISO()} | Error general en envío:`,
					err
				);
				// Error inesperado: permitir reintento hoy
				lastWelcomeByPhone.delete(phone);
			}
		}, delayMs);
	}

	static stopListener() {
		if (unsubscribeWelcome) {
			unsubscribeWelcome();
			unsubscribeWelcome = null;
			listenerStarted = false;
			console.log(
				`[WelcomeMedia] ${nowLaPazISO()} | Listener Firestore detenido.`
			);
		}
	}
}

module.exports = { WelcomeMediaService };
