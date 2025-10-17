// services/assistant-service.js (con logs)
require("dotenv").config({ path: process.env.ENV_PATH || ".env" });

const { groqClient } = require("../config/clients/groq-client.js");
const { qdrantClient } = require("../config/clients/qdrant-client.js");
const { EmbeddingsService } = require("./embeddings-service.js");
const { randomUUID } = require("crypto");

/* ============ Utils ============ */
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
			.filter((t) => t && t.trim() !== "")
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

function normalize(str = "") {
	return String(str)
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/* ============ Qdrant cfg ============ */
const QD_LOC = process.env.QDRANT_COLLECTION_LOCATIONS || "locations";
const QD_MED = process.env.QDRANT_COLLECTION_MEDIA || "media";
const QD_DOC = process.env.QDRANT_COLLECTION_DOCS || "documentos";

/* ============ Qdrant helpers con logs ============ */
async function getCollectionInfoSafe(name) {
	if (!name) return null;
	try {
		const info = await qdrantClient.getCollection(name);
		console.log(
			`📚 [Qdrant] Info colección "${name}":`,
			JSON.stringify(
				info?.result?.config?.params || info?.result?.config || {},
				null,
				2
			)
		);
		return info;
	} catch (e) {
		console.log(`⚠️ [Qdrant] No se pudo leer colección "${name}":`, e.message);
		return null;
	}
}

/** { exists, dim, namedVectorName } */
function parseVectorConfig(info) {
	if (!info || !info.result || !info.result.config)
		return { exists: false, dim: null, namedVectorName: null };
	const cfg = info.result.config.params?.vectors || info.result.config.vectors;
	if (cfg?.size) return { exists: true, dim: cfg.size, namedVectorName: null };
	if (typeof cfg === "object") {
		const names = Object.keys(cfg);
		if (names.length === 1 && cfg[names[0]]?.size) {
			return {
				exists: true,
				dim: cfg[names[0]].size,
				namedVectorName: names[0],
			};
		}
	}
	return { exists: true, dim: null, namedVectorName: null };
}

function buildSearchVectorParam(embedding, namedVectorName) {
	const param = namedVectorName
		? { vector: { name: namedVectorName, vector: embedding } }
		: { vector: embedding };
	console.log(
		"🧠 [RAG] Parámetro vector para search:",
		namedVectorName ? `{ name: "${namedVectorName}", vector: [...] }` : "[...]"
	);
	return param;
}

async function qdrantFindBestLocationByText(userText) {
	try {
		const { embedding } = await EmbeddingsService.getEmbeddingOrCachedResponse({
			text: userText,
		});
		console.log("🧠 [LOC] Dim embedding usuario:", embedding?.length);

		const info = await getCollectionInfoSafe(QD_LOC);
		const meta = parseVectorConfig(info);
		console.log("📚 [LOC] Meta colección:", meta);

		if (!meta.exists) {
			console.log(`⚠️ [LOC] Colección "${QD_LOC}" no existe.`);
			return null;
		}
		if (meta.dim && embedding?.length !== meta.dim) {
			console.log(`⚠️ [LOC] Dim vector ${embedding?.length} != ${meta.dim}.`);
			return null;
		}

		const vectorParam = buildSearchVectorParam(embedding, meta.namedVectorName);
		const hits = await qdrantClient.search(QD_LOC, {
			...vectorParam,
			limit: 5,
			with_payload: true,
			filter: { must: [{ key: "active", match: { value: true } }] },
			params: { hnsw_ef: 64 },
		});

		console.log("🧭 [LOC] Hits:", hits?.length || 0);
		if (!hits?.length) return null;

		const best = hits[0];
		console.log("📍 [LOC] Mejor sucursal:", {
			id: String(best.id),
			payload: best.payload,
		});
		const p = best.payload || {};
		return {
			id: String(best.id),
			name: p.name,
			description: p.description,
			address: p.address,
			latitude: p.geo?.lat ?? p.latitude ?? null,
			longitude: p.geo?.lon ?? p.longitude ?? null,
			city: p.city,
			branchCode: p.branchCode,
			active: p.active !== false,
		};
	} catch (e) {
		console.error("❌ qdrantFindBestLocationByText error:", e.message);
		return null;
	}
}

async function qdrantGetOrderedMediaByLocation(locationId, type, limit = 15) {
	try {
		console.log(
			`🗂️ [MEDIA] Buscando media: locationId=${locationId}, type=${type}, limit=${limit}`
		);
		const res = await qdrantClient.scroll(QD_MED, {
			filter: {
				must: [
					{ key: "active", match: { value: true } },
					{ key: "locationId", match: { value: String(locationId) } },
					{ key: "type", match: { value: type } },
				],
			},
			order_by: { key: "displayOrder", direction: "asc" },
			with_payload: true,
			limit,
		});
		const pts = res.points || [];
		console.log(
			`🗂️ [MEDIA] Encontrados ${pts.length} items (ordenados por displayOrder asc)`
		);
		return pts.map((pt) => {
			const p = pt.payload || {};
			return {
				id: String(pt.id),
				type: p.type || "image",
				name: p.name || "",
				description: p.description || "",
				url: p.url || "",
				locationId: p.locationId || null,
				branchCode: p.branchCode || null,
				city: p.city || null,
				active: p.active !== false,
				displayOrder: Number.isFinite(p.displayOrder) ? p.displayOrder : 999999,
				tags: Array.isArray(p.tags) ? p.tags : [],
			};
		});
	} catch (e) {
		console.error("❌ qdrantGetOrderedMediaByLocation error:", e.message);
		return [];
	}
}

async function qdrantGetActiveLocations() {
	try {
		const res = await qdrantClient.scroll(QD_LOC, {
			filter: { must: [{ key: "active", match: { value: true } }] },
			with_payload: true,
			limit: 2000,
		});
		const pts = res.points || [];
		console.log("📋 [LOC] Sucursales activas:", pts.length);
		return pts.map((pt) => {
			const p = pt.payload || {};
			return {
				id: String(pt.id),
				name: p.name,
				description: p.description,
				address: p.address,
				latitude: p.geo?.lat ?? p.latitude ?? null,
				longitude: p.geo?.lon ?? p.longitude ?? null,
				city: p.city,
				branchCode: p.branchCode,
				active: p.active !== false,
			};
		});
	} catch (e) {
		console.error("❌ qdrantGetActiveLocations error:", e.message);
		return [];
	}
}

/* ============ Similaridad y Groq gates (logs) ============ */
function jaccard(a, b) {
	const tok = (s) =>
		normalize(s)
			.split(" ")
			.filter((w) => w.length > 2);
	const A = new Set(tok(a));
	const B = new Set(tok(b));
	if (!A.size || !B.size) return 0;
	let inter = 0;
	for (const w of A) if (B.has(w)) inter++;
	return inter / (A.size + B.size - inter);
}

async function shouldSendMultimedia(userQuery, assistantResponse, mediaType) {
	const prompt = `Analiza esta conversación:
Usuario: "${userQuery}"
Asistente: "${assistantResponse}"
¿El usuario pide explícitamente ver/enviar ${mediaType}? Responde solo "si" o "no".`;
	try {
		const res = await groqClient.chat.completions.create({
			model: "llama-3.3-70b-versatile",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 5,
			temperature: 0.0,
		});
		const out = normalize(res.choices?.[0]?.message?.content || "");
		const ok = /^(si|sí)$/.test(out);
		console.log(
			`📎 [Gate ${mediaType}] shouldSendMultimedia=`,
			ok,
			" raw:",
			out
		);
		return ok;
	} catch (e) {
		console.log(`⚠️ [Gate ${mediaType}] fallo LLM, devolviendo false`);
		return false;
	}
}

async function filterMediaWithGroq(
	mediaItems,
	userQuery,
	assistantResponse,
	mediaType,
	maxItems = 3
) {
	if (!mediaItems?.length) return [];
	try {
		const preFiltered = mediaItems.filter(
			(item) => jaccard(userQuery, `${item.name} ${item.description}`) >= 0.2
		);
		console.log(
			`🖇️ [Filter ${mediaType}] preFiltered=${preFiltered.length}/${mediaItems.length}`
		);
		if (!preFiltered.length) return [];
		const list = preFiltered
			.map((i, idx) => `${idx + 1}. ${i.name} - ${i.description.slice(0, 120)}`)
			.join("\n");
		const prompt =
			`Usuario: "${userQuery}"\n\n${mediaType} disponibles:\n${list}\n\n` +
			`Selecciona hasta ${maxItems} relevantes. Si ninguno, responde "ninguno".`;
		const res = await groqClient.chat.completions.create({
			model: "llama-3.3-70b-versatile",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 30,
			temperature: 0.2,
		});
		const txt = (res.choices?.[0]?.message?.content || "").toLowerCase();
		if (txt.includes("ninguno")) {
			console.log(`🖇️ [Filter ${mediaType}] LLM eligió ninguno`);
			return [];
		}
		const nums = (txt.match(/\d+/g) || []).map((n) => parseInt(n) - 1);
		const chosen = nums
			.filter((i) => i >= 0 && i < preFiltered.length)
			.map((i) => preFiltered[i])
			.slice(0, maxItems);
		console.log(
			`🖇️ [Filter ${mediaType}] elegidos=${chosen.length} indices=`,
			nums
		);
		return chosen;
	} catch (err) {
		console.error(`❌ [Filter ${mediaType}] error:`, err.message);
		const scored = mediaItems
			.map((item) => ({
				item,
				score: jaccard(userQuery, `${item.name} ${item.description}`),
			}))
			.sort((a, b) => b.score - a.score);
		const fallback = scored.slice(0, maxItems).map((s) => s.item);
		console.log(
			`🖇️ [Filter ${mediaType}] fallback top-${maxItems}=${fallback.length}`
		);
		return fallback;
	}
}

/* ============ AssistantService (con logs) ============ */
class AssistantService {
	static async getActiveLocations() {
		return await qdrantGetActiveLocations();
	}
	static async getActivePromptImages() {
		return [];
	}

	static async chatWithDocument({ chat }) {
		if (!chat?.length) return { error: "Chat vacío" };

		try {
			const model = "llama-3.3-70b-versatile";
			const messages = chat;

			// 1) Texto del usuario
			const userRaw = getUnrespondedUserMessages(messages);
			console.log("📨 [Input] Texto usuario:", userRaw);
			if (!userRaw) return { error: "No hay mensaje de usuario" };

			// 2) RAG robusto
			const { embedding } =
				await EmbeddingsService.getEmbeddingOrCachedResponse({ text: userRaw });
			console.log("🧠 [RAG] Dim embedding:", embedding?.length);

			let contextDocs = [];
			if (QD_DOC) {
				try {
					const info = await getCollectionInfoSafe(QD_DOC);
					const meta = parseVectorConfig(info);
					console.log("📚 [RAG] Meta colección documentos:", meta);

					if (!meta?.exists) {
						console.log(`[RAG] "${QD_DOC}" no existe → omito RAG.`);
					} else if (meta.dim && embedding?.length !== meta.dim) {
						console.log(
							`[RAG] Dim mismatch (${embedding?.length} != ${meta.dim}) → omito RAG.`
						);
					} else {
						const vectorParam = buildSearchVectorParam(
							embedding,
							meta.namedVectorName
						);
						const results = await qdrantClient.search(QD_DOC, {
							...vectorParam,
							limit: 8,
							with_payload: true,
						});
						contextDocs = (results || []).map((r) => ({
							id: randomUUID(),
							data: {
								text:
									r.payload?.contenido ||
									r.payload?.descripcion ||
									r.payload?.text ||
									"",
							},
						}));
						console.log("🧠 [RAG] Docs obtenidos:", contextDocs.length);
					}
				} catch (err) {
					console.error(
						"❌ [RAG] search error:",
						err?.response?.data || err.message
					);
				}
			} else {
				console.log("[RAG] Desactivado (QDRANT_COLLECTION_DOCS vacío).");
			}

			// 3) Sucursales al contexto (opcional)
			const locs = await qdrantGetActiveLocations();
			if (locs.length) {
				const names = locs
					.map((l) => `${l.name}${l.city ? " - " + l.city : ""}`)
					.join("\n");
				contextDocs.push({
					id: randomUUID(),
					data: { text: `SUCURSALES ACTIVAS:\n${names}` },
				});
			}

			// 4) Groq request
			const normalizedMsgs = messages.map((m) => ({
				role: m.role,
				content: extractTextFromMessage(m),
			}));
			const contextText = contextDocs.map((d) => d.data.text).join("\n\n");
			const groqMessages = normalizedMsgs.length
				? [
						{
							role: normalizedMsgs[0].role,
							content:
								normalizedMsgs[0].content +
								(contextText ? `\n\nCONTEXTO:\n${contextText}` : ""),
						},
						...normalizedMsgs.slice(1),
				  ]
				: [];
			console.log(
				"🧠 [LLM] Mensajes a Groq:",
				groqMessages.length,
				" con contexto=",
				Boolean(contextText)
			);

			const llm = await groqClient.chat.completions.create({
				model,
				messages: groqMessages,
				max_tokens: 300,
				temperature: 0.8,
			});
			const cleanedResponse = formatForWhatsApp(
				llm.choices?.[0]?.message?.content || ""
			);
			console.log("🧠 [LLM] Respuesta limpia:", cleanedResponse);

			// 5) Intenciones básicas
			const u = normalize(userRaw);
			const wantsLocation =
				/\b(ubicacion|ubicación|direccion|dirección|donde|dónde|como llegar|cómo llegar|llegar)\b/.test(
					u
				);
			const wantsImages =
				/\b(imagen|imagenes|imágenes|foto|fotos|ver|mostrar|muestr)\b/.test(u);
			const wantsVideos = /\b(video|vídeo|clip)\b/.test(u);
			const wantsAudios = /\b(audio|escuchar|grabacion|grabación)\b/.test(u);
			console.log("📎 [Intent] wants:", {
				wantsLocation,
				wantsImages,
				wantsVideos,
				wantsAudios,
			});

			// 6) Resultado base
			let locationToSend = null;
			let imagesToSend = [];
			let videosToSend = [];
			let audiosToSend = [];
			let shouldListLocations = false;

			// 7) Inferir sucursal por embedding si hace falta
			let inferredLocation = null;
			if (wantsLocation || wantsImages || wantsVideos || wantsAudios) {
				inferredLocation = await qdrantFindBestLocationByText(userRaw);
			}
			console.log("📍 [Location] Inferida:", inferredLocation);

			// 8) Ubicación
			if (
				wantsLocation &&
				inferredLocation?.latitude &&
				inferredLocation?.longitude
			) {
				const ok = await shouldSendMultimedia(
					userRaw,
					cleanedResponse,
					"ubicación"
				);
				if (ok) {
					locationToSend = {
						name: inferredLocation.name,
						address: inferredLocation.address,
						latitude: inferredLocation.latitude,
						longitude: inferredLocation.longitude,
					};
					console.log("📍 [Location] Para enviar:", locationToSend);
				} else {
					console.log("📍 [Location] Gate dijo NO → no se envía ubicación");
				}
			}

			// 9) Multimedia
			if (inferredLocation) {
				if (wantsImages) {
					const ok = await shouldSendMultimedia(
						userRaw,
						cleanedResponse,
						"imágenes"
					);
					if (ok) {
						const candidates = await qdrantGetOrderedMediaByLocation(
							inferredLocation.id,
							"image",
							15
						);
						console.log("🖼️ [Images] Candidatos:", candidates.length);
						const chosen = await filterMediaWithGroq(
							candidates,
							userRaw,
							cleanedResponse,
							"imágenes",
							3
						);
						imagesToSend = chosen.length ? chosen : candidates.slice(0, 3);
						console.log(
							"🖼️ [Images] Elegidas:",
							imagesToSend.map((i) => ({
								id: i.id,
								name: i.name,
								order: i.displayOrder,
							}))
						);
					} else {
						console.log("🖼️ [Images] Gate dijo NO → no se envían imágenes");
					}
				}

				if (wantsVideos) {
					const ok = await shouldSendMultimedia(
						userRaw,
						cleanedResponse,
						"videos"
					);
					if (ok) {
						const candidates = await qdrantGetOrderedMediaByLocation(
							inferredLocation.id,
							"video",
							10
						);
						console.log("🎥 [Videos] Candidatos:", candidates.length);
						const chosen = await filterMediaWithGroq(
							candidates,
							userRaw,
							cleanedResponse,
							"videos",
							3
						);
						videosToSend = chosen.length ? chosen : candidates.slice(0, 3);
						console.log(
							"🎥 [Videos] Elegidos:",
							videosToSend.map((v) => ({
								id: v.id,
								name: v.name,
								order: v.displayOrder,
							}))
						);
					} else {
						console.log("🎥 [Videos] Gate dijo NO → no se envían videos");
					}
				}

				if (wantsAudios) {
					const ok = await shouldSendMultimedia(
						userRaw,
						cleanedResponse,
						"audios"
					);
					if (ok) {
						const candidates = await qdrantGetOrderedMediaByLocation(
							inferredLocation.id,
							"audio",
							10
						);
						console.log("🔊 [Audios] Candidatos:", candidates.length);
						const chosen = await filterMediaWithGroq(
							candidates,
							userRaw,
							cleanedResponse,
							"audios",
							3
						);
						audiosToSend = chosen.length ? chosen : candidates.slice(0, 3);
						console.log(
							"🔊 [Audios] Elegidos:",
							audiosToSend.map((a) => ({ id: a.id, name: a.name }))
						);
					} else {
						console.log("🔊 [Audios] Gate dijo NO → no se envían audios");
					}
				}
			}

			// 10) Si hay intención pero no hay sucursal → pedir lista
			if (
				!inferredLocation &&
				(wantsLocation || wantsImages || wantsVideos || wantsAudios)
			) {
				shouldListLocations = true;
				console.log(
					"📋 [LOC] No se pudo inferir sucursal → shouldListLocations=true"
				);
			}

			const result = {
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
			console.log("📦 [Result] Resumen:", {
				hasLocation: Boolean(locationToSend),
				images: imagesToSend.length,
				videos: videosToSend.length,
				audios: audiosToSend.length,
				shouldListLocations,
			});

			return result;
		} catch (err) {
			console.error("❌ Error en chatWithDocument:", err);
			return { error: "Error procesando el chat" };
		}
	}

	static async getActiveLocations() {
		return await qdrantGetActiveLocations();
	}
	static async getActivePromptImages() {
		return [];
	}

	static async getStatusAssistant({ name = "assistant-1" }) {
		return { name, status: { enabled: true, source: "qdrant" } };
	}

	static async getConfigAssistant({ name = "assistant-1" }) {
		return {
			config: {
				model: "llama-3.3-70b-versatile",
				collections: { locations: QD_LOC, media: QD_MED, docs: QD_DOC },
			},
		};
	}
}

module.exports = { AssistantService };
