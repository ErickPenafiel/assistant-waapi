require("dotenv").config({ path: process.env.ENV_PATH || ".env" });

const { groqClient } = require("../config/clients/groq-client.js");
const { qdrantClient } = require("../config/clients/qdrant-client.js");
const { EmbeddingsService } = require("./embeddings-service.js");
const { randomUUID } = require("crypto");
const { db } = require("../config/firebase/config.js");

/* -----------------------------------------
   Constantes de colecciones y parámetros
----------------------------------------- */
const QT_DOCS_COLLECTION = process.env.COLLECTION_QT || "documentos";
const QT_BRANCHES_COLLECTION =
	process.env.COLLECTION_BRANCHES || "sucursales_media";
const MODEL_CHAT = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

/* -----------------------------------------
   Flags / singletons de preparación Qdrant
----------------------------------------- */
let __qdrantPrepared = false;
let __qdrantDim = null;

/* ------------------------------
   Utilidades de texto y formato
------------------------------ */
function log(...args) {
	// Log comprimido, agrega un prefijo para localizar fácil en Cloud logs
	console.log("[AssistantService]", ...args);
}
function warn(...args) {
	console.warn("[AssistantService][WARN]", ...args);
}
function errLog(...args) {
	console.error("[AssistantService][ERROR]", ...args);
}

function formatForWhatsApp(text) {
	if (!text) return text;

	text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");
	text = text.replace(/\*\*(.+?)\*\*/g, "$1");
	text = text.replace(/\*(.+?)\*/g, "$1");
	text = text.replace(/^[\s]*[-\*\+]\s+(.+)$/gm, "• $1");
	text = text.replace(/^[\s]*\d+\.\s+(.+)$/gm, "• $1");
	text = text.replace(/```[\s\S]*?```/g, "");
	text = text.replace(/`(.+?)`/g, "$1");
	text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");
	text = text.replace(/^[-\*_]{3,}$/gm, "");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

function extractTextFromMessage(message) {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((c) => (c.type === "text" ? c.text : ""))
			.filter((t) => t.trim() !== "")
			.join("\n");
	}
	if (message?.content?.text) return message.content.text;
	return "";
}

function getUnrespondedUserMessages(messages) {
	let lastAssistant = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			lastAssistant = i;
			break;
		}
	}
	const userMessages =
		lastAssistant === -1 ? messages : messages.slice(lastAssistant + 1);
	const unresp = userMessages
		.filter((m) => m.role === "user")
		.map(extractTextFromMessage)
		.filter((t) => t.trim() !== "");
	return unresp.join("\n\n");
}

/* ------------------------------
      Helpers de similitud
------------------------------ */
const TextSim = {
	normalize(s = "") {
		return s
			.toLowerCase()
			.normalize("NFD")
			.replace(/\p{Diacritic}/gu, "")
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
	},

	tokenize(s) {
		const stop = new Set([
			"de",
			"la",
			"el",
			"los",
			"las",
			"y",
			"o",
			"u",
			"en",
			"a",
			"un",
			"una",
			"para",
			"por",
			"con",
			"del",
			"al",
			"que",
			"como",
			"es",
			"son",
			"lo",
			"su",
			"sus",
			"tu",
			"mi",
			"te",
			"le",
			"se",
		]);
		return this.normalize(s)
			.split(" ")
			.filter((w) => w.length > 2 && !stop.has(w));
	},

	jaccard(a, b) {
		const A = new Set(this.tokenize(a));
		const B = new Set(this.tokenize(b));
		if (!A.size || !B.size) return 0;
		let inter = 0;
		for (const w of A) if (B.has(w)) inter++;
		return inter / (A.size + B.size - inter);
	},
};

/* ------------------------------
   Preparación de Qdrant (colección + índices)
------------------------------ */
async function ensureQdrantPrepared() {
	if (__qdrantPrepared) return { dim: __qdrantDim };

	log("Preparando Qdrant… (colección e índices)");
	// 1) Detectar dimensión de embedding
	const probe = await EmbeddingsService.getEmbeddingOrCachedResponse({
		text: "dimension-probe",
	});
	if (!probe?.embedding?.length) {
		throw new Error("EmbeddingsService devolvió un embedding inválido");
	}
	__qdrantDim = probe.embedding.length;

	// 2) Asegurar colección
	try {
		await qdrantClient.getCollection(QT_BRANCHES_COLLECTION);
		log(`Colección "${QT_BRANCHES_COLLECTION}" ya existe`);
	} catch {
		log(`Colección "${QT_BRANCHES_COLLECTION}" no existe. Creando…`);
		await qdrantClient.createCollection(QT_BRANCHES_COLLECTION, {
			vectors: { size: __qdrantDim, distance: "Cosine" },
			optimizers_config: { default_segment_number: 2 },
		});
		log(`Colección "${QT_BRANCHES_COLLECTION}" creada`);
	}

	// 3) Asegurar índices de payload requeridos para filtros keyword/bool
	const ensureIndex = async (field, fieldType) => {
		try {
			await qdrantClient.createPayloadIndex(QT_BRANCHES_COLLECTION, {
				field_name: field,
				field_schema: { type: fieldType }, // "keyword" | "bool" | "float" | "integer"
			});
			log(`Índice creado para "${field}" (${fieldType})`);
		} catch (e) {
			// Si ya existe, Qdrant devuelve 409; lo ignoramos
			const code = e?.status || e?.response?.status;
			if (code === 409) {
				log(`Índice ya existía para "${field}"`);
			} else {
				warn(
					`No se pudo crear índice para "${field}":`,
					e?.data || e?.message || e
				);
			}
		}
	};

	await ensureIndex("type", "keyword");
	await ensureIndex("active", "bool");
	await ensureIndex("city", "keyword");
	await ensureIndex("branch", "keyword");

	__qdrantPrepared = true;
	return { dim: __qdrantDim };
}

/* ------------------------------
      Búsquedas en Qdrant
------------------------------ */
async function qdrantSearchDocuments(embedding, limit = 8) {
	try {
		const results = await qdrantClient.search(QT_DOCS_COLLECTION, {
			vector: embedding,
			limit,
			with_payload: true,
		});
		return results.map((r) => ({
			id: randomUUID(),
			data: {
				text:
					r.payload?.contenido ||
					r.payload?.descripcion ||
					r.payload?.text ||
					"",
			},
		}));
	} catch (err) {
		warn("Qdrant search (documentos) error:", err?.data || err?.message || err);
		return [];
	}
}

async function qdrantResolveBranchByQuery(userQuery) {
	try {
		await ensureQdrantPrepared();

		const { embedding } = await EmbeddingsService.getEmbeddingOrCachedResponse({
			text: userQuery,
		});

		const filter = {
			must: [
				{ key: "type", match: { value: "location" } },
				{ key: "active", match: { value: true } },
			],
		};

		log("Qdrant resolveBranch query:", {
			collection: QT_BRANCHES_COLLECTION,
			score_threshold: 0.25,
			filter,
		});

		const results = await qdrantClient.search(QT_BRANCHES_COLLECTION, {
			vector: embedding,
			limit: 5,
			with_payload: true,
			filter,
			score_threshold: 0.25,
		});

		log("Qdrant resolveBranch hits:", results?.length || 0);

		if (!results?.length) return null;

		const top = results[0];
		const p = top.payload || {};
		return {
			name: p.name || p.branch || "Sucursal",
			address: p.address || "",
			description: p.description || "",
			city: p.city || "",
			latitude: p.latitude || null,
			longitude: p.longitude || null,
			active: p.active !== false,
		};
	} catch (err) {
		warn("Qdrant resolve branch error:", err?.data || err?.message || err);
		return null;
	}
}

async function qdrantListAllBranches() {
	try {
		await ensureQdrantPrepared();

		if (!qdrantClient.scroll)
			throw new Error("scroll no disponible en cliente");
		let nextPage = null;
		const all = [];
		do {
			const res = await qdrantClient.scroll(QT_BRANCHES_COLLECTION, {
				with_payload: true,
				limit: 128,
				filter: {
					must: [
						{ key: "type", match: { value: "location" } },
						{ key: "active", match: { value: true } },
					],
				},
				offset: nextPage || undefined,
			});
			const points = res?.points || [];
			all.push(
				...points.map((pt) => ({
					name: pt.payload?.name || pt.payload?.branch || "Sucursal",
					city: pt.payload?.city || "",
					address: pt.payload?.address || "",
					description: pt.payload?.description || "",
					latitude: pt.payload?.latitude || null,
					longitude: pt.payload?.longitude || null,
					active: pt.payload?.active !== false,
				}))
			);
			nextPage = res?.next_page_offset || null;
		} while (nextPage);
		log("Qdrant listAllBranches total:", all.length);
		return all;
	} catch (err) {
		warn("Qdrant scroll fallback to Firebase. Error:", err?.message || err);
		return null;
	}
}

async function qdrantSearchMedia({
	userQuery,
	branchName,
	city,
	type, // "image" | "video" | "audio"
	limit = 3,
}) {
	const filtersMust = [
		{ key: "type", match: { value: type } },
		{ key: "active", match: { value: true } },
	];

	// Añade filtros solo si hay valores; si city/branch están vacíos, no forzamos índice
	if (branchName)
		filtersMust.push({ key: "branch", match: { value: branchName } });
	if (city) filtersMust.push({ key: "city", match: { value: city } });

	const filter = { must: filtersMust };

	try {
		await ensureQdrantPrepared();

		const { embedding } = await EmbeddingsService.getEmbeddingOrCachedResponse({
			text: userQuery,
		});

		log("Qdrant search media params:", {
			collection: QT_BRANCHES_COLLECTION,
			type,
			branchName,
			city,
			limit,
			filter,
			score_threshold: 0.2,
		});

		const results = await qdrantClient.search(QT_BRANCHES_COLLECTION, {
			vector: embedding,
			limit,
			with_payload: true,
			filter,
			score_threshold: 0.2,
		});

		log("Qdrant search media hits:", results?.length || 0);

		return (results || []).map((r) => {
			const p = r.payload || {};
			return {
				id: r.id,
				name: p.name || "",
				description: p.description || "",
				url: p.url || p.imageUrl || "",
				type: p.type || type,
				branch: p.branch || branchName || "",
				city: p.city || city || "",
				score: r.score,
			};
		});
	} catch (e) {
		// Errores comunes: falta de índices → los creamos y reintentamos una vez sin filtros estrictos
		const emsg = e?.data || e?.message || e;
		errLog("Qdrant search media error:", emsg);

		const needIndex =
			typeof emsg === "string"
				? /Index required|Bad request: Index required/i.test(emsg)
				: /Index required|Bad request: Index required/i.test(
						JSON.stringify(emsg || {})
				  );

		if (needIndex) {
			warn("Faltaba índice. Reintentando tras ensureQdrantPrepared()…");
			try {
				await ensureQdrantPrepared();
				// Relajar filtros si faltan branch/city
				const relaxedFilter = {
					must: [
						{ key: "type", match: { value: type } },
						{ key: "active", match: { value: true } },
					],
				};
				log("Reintento Qdrant (relaxed filter):", relaxedFilter);
				const { embedding } =
					await EmbeddingsService.getEmbeddingOrCachedResponse({
						text: userQuery,
					});
				const retry = await qdrantClient.search(QT_BRANCHES_COLLECTION, {
					vector: embedding,
					limit,
					with_payload: true,
					filter: relaxedFilter,
					score_threshold: 0.2,
				});
				log("Reintento hits:", retry?.length || 0);
				return (retry || []).map((r) => {
					const p = r.payload || {};
					return {
						id: r.id,
						name: p.name || "",
						description: p.description || "",
						url: p.url || p.imageUrl || "",
						type: p.type || type,
						branch: p.branch || "",
						city: p.city || "",
						score: r.score,
					};
				});
			} catch (e2) {
				errLog("Reintento Qdrant falló:", e2?.data || e2?.message || e2);
			}
		}

		return [];
	}
}

/* ------------------------------------
   Fallbacks a Firebase (respaldo)
------------------------------------ */
async function fbGetActiveLocations() {
	try {
		const snap = await db
			.collection("locations")
			.where("active", "==", true)
			.get();
		const docs = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
		log("Firebase getActiveLocations count:", docs.length);
		return docs;
	} catch (err) {
		errLog("Firebase getActiveLocations error:", err?.message || err);
		return [];
	}
}

async function fbGetActivePromptImages() {
	try {
		const snap = await db
			.collection("prompt_images")
			.where("active", "==", true)
			.get();
		const docs = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
		log("Firebase getActivePromptImages count:", docs.length);
		return docs;
	} catch (err) {
		errLog("Firebase getActivePromptImages error:", err?.message || err);
		return [];
	}
}

/* ------------------------------
      INTENT DETECTION (GROQ)
------------------------------ */
async function decideUserIntent(userText, assistantText = "") {
	const schema = `Devuelve SOLO este JSON:
{"intent":"list_branches"|"request_location"|"request_images"|"request_videos"|"request_audios"|"none","branch_mentioned":string|null,"explicit":boolean,"reason":string}
Reglas:
- "explicit" solo si el usuario pide ver/enviar/mostrar algo (muéstrame, envíame, pásame ubicación, quiero ver, etc.)
- "¿Qué sucursales tienes?" -> list_branches
- "¿Dónde queda la sucursal X?" -> request_location
- "Muéstrame fotos de X" -> request_images`;

	const prompt = `${schema}\n\nUsuario: "${userText}"\nAsistente: "${assistantText}"\n\nJSON:`;
	try {
		const res = await groqClient.chat.completions.create({
			model: MODEL_CHAT,
			messages: [{ role: "user", content: prompt }],
			max_tokens: 120,
			temperature: 0.0,
		});
		const out = res.choices?.[0]?.message?.content?.trim() || "{}";
		log("decideUserIntent raw:", out);
		return JSON.parse(out);
	} catch (err) {
		errLog("decideUserIntent error:", err?.message || err);
		return {
			intent: "none",
			branch_mentioned: null,
			explicit: false,
			reason: "error",
		};
	}
}

async function shouldSendMultimedia(userQuery, assistantResponse, mediaType) {
	const prompt = `Analiza esta conversación:
Usuario: "${userQuery}"
Asistente: "${assistantResponse}"
¿El usuario pide explícitamente ver ${mediaType}? 
Responde solo "si" o "no".`;
	try {
		const res = await groqClient.chat.completions.create({
			model: MODEL_CHAT,
			messages: [{ role: "user", content: prompt }],
			max_tokens: 5,
			temperature: 0.0,
		});
		const out = TextSim.normalize(res.choices?.[0]?.message?.content || "");
		const ok = /^(si|sí)$/.test(out);
		log(`shouldSendMultimedia(${mediaType})=`, ok, " raw:", out);
		return ok;
	} catch (e) {
		warn("shouldSendMultimedia error:", e?.message || e);
		return false;
	}
}

/* ------------------------------
      Servicio principal
------------------------------ */
class AssistantService {
	/* ---------- FIREBASE (respaldo directo si lo necesitas en otros lugares) ---------- */
	static async getActiveLocations() {
		return fbGetActiveLocations();
	}

	static async getActivePromptImages() {
		return fbGetActivePromptImages();
	}

	/* ---------- TEXT SIMILARITY helpers re-export ---------- */
	static normalize = TextSim.normalize.bind(TextSim);
	static tokenize = TextSim.tokenize.bind(TextSim);
	static jaccard = TextSim.jaccard.bind(TextSim);

	/* ---------- Resolver sucursal combinando Qdrant + fallback ---------- */
	static async resolveBranch(userRaw, branchHint = null) {
		log("resolveBranch input:", { userRaw, branchHint });

		// 1) Intento con Qdrant (más robusto)
		const candidate =
			(await qdrantResolveBranchByQuery(branchHint || userRaw)) || null;

		if (candidate) {
			log("resolveBranch via Qdrant:", candidate);
			return candidate;
		}

		// 2) Fallback a Firebase si Qdrant no respondió
		const activeLocations = await fbGetActiveLocations();
		if (!activeLocations?.length) {
			warn("resolveBranch: no hay locations activas en Firebase");
			return null;
		}

		// Busca por similitud de texto
		const scored = activeLocations
			.map((loc) => {
				const txt = `${loc.name} ${loc.city || ""} ${loc.address || ""} ${(
					loc.aliases || []
				).join(" ")}`;
				return { loc, score: TextSim.jaccard(branchHint || userRaw, txt) };
			})
			.sort((a, b) => b.score - a.score);

		const top = scored[0];
		log("resolveBranch fallback topScore:", top?.score);

		if (!top || top.score < 0.25) return null;

		const out = {
			name: top.loc.name,
			address: top.loc.address || "",
			description: top.loc.description || "",
			city: top.loc.city || "",
			latitude: top.loc.latitude || null,
			longitude: top.loc.longitude || null,
			active: top.loc.active !== false,
		};
		log("resolveBranch via Firebase:", out);
		return out;
	}

	/* ---------- Chat principal (RAG + gating) ---------- */
	static async chatWithDocument({ chat }) {
		if (!chat?.length) return { error: "Chat vacío" };
		try {
			const messages = chat;
			const concatenated = getUnrespondedUserMessages(messages);
			if (!concatenated) return { error: "No hay mensaje de usuario" };

			log("chatWithDocument userText:", concatenated);

			// Embedding del input del usuario
			const { embedding } =
				await EmbeddingsService.getEmbeddingOrCachedResponse({
					text: concatenated,
				});

			// Contexto extra desde Qdrant (documentos)
			const contextDocs = await qdrantSearchDocuments(embedding, 8);
			log("contextDocs count:", contextDocs.length);

			// Opcional: lista de sucursales para dar contexto al LLM (preferir Qdrant)
			let branchesForContext = await qdrantListAllBranches();
			if (!branchesForContext) {
				const fbBranches = await fbGetActiveLocations();
				branchesForContext = fbBranches.map((l) => ({
					name: l.name,
					city: l.city || "",
					address: l.address || "",
					description: l.description || "",
					latitude: l.latitude || null,
					longitude: l.longitude || null,
					active: l.active !== false,
				}));
				log("branchesForContext via Firebase:", branchesForContext.length);
			} else {
				log("branchesForContext via Qdrant:", branchesForContext.length);
			}

			const contextText =
				(contextDocs || []).map((d) => d.data.text).join("\n\n") +
				(branchesForContext?.length
					? "\n\nUBICACIONES DISPONIBLES:\n" +
					  branchesForContext
							.map(
								(l) =>
									`${l.city ? `[${l.city}] ` : ""}${l.name}${
										l.address ? ` - ${l.address}` : ""
									}`
							)
							.join("\n")
					: "");

			// Normalizar mensajes y añadir contexto al primero
			const normalizedMessages = messages.map((m) => ({
				role: m.role,
				content: extractTextFromMessage(m),
			}));

			const groqMessages = normalizedMessages.length
				? [
						{
							role: normalizedMessages[0].role,
							content:
								normalizedMessages[0].content + "\n\nCONTEXTO:\n" + contextText,
						},
						...normalizedMessages.slice(1),
				  ]
				: [];

			const llmResponse = await groqClient.chat.completions.create({
				model: MODEL_CHAT,
				messages: groqMessages,
				max_tokens: 300,
				temperature: 0.8,
			});

			const cleanedResponse = formatForWhatsApp(
				llmResponse.choices?.[0]?.message?.content || ""
			);
			log("LLM cleanedResponse (excerpt):", cleanedResponse.slice(0, 120));

			/* --- POST-PROCESO: INTENCIÓN + ACCIONES --- */
			const userRaw = concatenated;
			const { intent, branch_mentioned, explicit } = await decideUserIntent(
				userRaw,
				cleanedResponse
			);
			log("Intent detection:", { intent, branch_mentioned, explicit });

			// Resolver sucursal (Qdrant -> Firebase)
			const resolvedBranch = await this.resolveBranch(
				userRaw,
				branch_mentioned
			);
			log("Resolved branch:", resolvedBranch);

			// Preparar resultados
			let locationToSend = null;
			let imagesToSend = [];
			let videosToSend = [];
			let audiosToSend = [];
			let shouldListLocations = false;

			switch (intent) {
				case "list_branches": {
					shouldListLocations = true;
					break;
				}
				case "request_location": {
					if (explicit && resolvedBranch) {
						const ok = await shouldSendMultimedia(
							userRaw,
							cleanedResponse,
							"ubicación"
						);
						if (ok) locationToSend = resolvedBranch;
						log("request_location ->", { ok, locationToSend });
					} else {
						shouldListLocations = true;
						log(
							"request_location -> listing because not explicit or no resolvedBranch"
						);
					}
					break;
				}
				case "request_images":
				case "request_videos":
				case "request_audios": {
					if (!(explicit && resolvedBranch)) {
						shouldListLocations = true;
						log(
							"media request -> listing because not explicit or no resolvedBranch"
						);
						break;
					}
					const mediaType =
						intent === "request_images"
							? "image"
							: intent === "request_videos"
							? "video"
							: "audio";

					// Buscar multimedia SOLO de la sucursal + ciudad del resolvedBranch (Qdrant)
					const media = await qdrantSearchMedia({
						userQuery: userRaw,
						branchName: resolvedBranch.name,
						city: resolvedBranch.city,
						type: mediaType,
						limit: 3,
					});

					log(`Media results (${mediaType}):`, media.length);

					if (mediaType === "image") imagesToSend = media;
					if (mediaType === "video") videosToSend = media;
					if (mediaType === "audio") audiosToSend = media;

					// Si Qdrant no devolvió nada, dar opción de listar
					if (
						(mediaType === "image" && !imagesToSend.length) ||
						(mediaType === "video" && !videosToSend.length) ||
						(mediaType === "audio" && !audiosToSend.length)
					) {
						shouldListLocations = true;
						log("No media found -> shouldListLocations = true");
					}
					break;
				}
				default:
					log("No actionable intent. Returning only LLM text.");
					break;
			}

			return {
				response: {
					role: "assistant",
					content: [{ type: "text", text: cleanedResponse }],
				},
				locationToSend,
				imagesToSend,
				audiosToSend,
				videosToSend,
				shouldListLocations,
			};
		} catch (err) {
			errLog("Error en chatWithDocument:", err?.data || err?.message || err);
			return { error: "Error procesando el chat" };
		}
	}

	/* ---------- CONFIG ---------- */
	static async getStatusAssistant({ name = "assistant-1" } = {}) {
		try {
			const doc = await db.collection("config").doc(name).get();
			return doc.exists
				? { name, status: doc.data() }
				: { error: `Asistente ${name} no encontrado` };
		} catch (err) {
			errLog("getStatusAssistant error:", err?.message || err);
			return { error: "No se pudo leer el estado del asistente" };
		}
	}

	static async getConfigAssistant({ name = "assistant-1" } = {}) {
		try {
			const doc = await db.collection("config").doc(name).get();
			return doc.exists
				? { config: doc.data() }
				: { error: "Configuración no encontrada" };
		} catch (err) {
			errLog("getConfigAssistant error:", err?.message || err);
			return { error: "No se pudo leer la configuración del asistente" };
		}
	}
}

module.exports = { AssistantService };
