#!/usr/bin/env node
/**
 * Qdrant Seeder (locations + media) desde exports/firestore_*.json
 *
 * Uso:
 *   node scripts/qdrant-seeder.js [--dry] [--limit 500]
 *
 * Requisitos:
 *   - ../src/config/clients/qdrant-client.js   -> exporta { qdrantClient }
 *   - ../src/services/embeddings-service.js    -> exporta { EmbeddingsService } con getEmbeddingOrCachedResponse({text})
 *   - Archivos:
 *       exports/firestore_locations.json    (formato {count, items: [...]})
 *       exports/firestore_media.json        (formato {count, items: [...]})
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { qdrantClient } = require("../src/config/clients/qdrant-client.js");
const { EmbeddingsService } = require("../src/services/embeddings-service.js");

// === Config general ===
const COLLECTIONS = {
	LOCATIONS: "locations",
	MEDIA: "media",
	SESSIONS: "sessions", // opcional
};

const DEFAULT_BATCH = 200;

// Overrides manuales (corrigen city/branchCode por nombre/alias)
const OVERRIDES = {
	"santa marta": {
		city: "Santa Cruz de la Sierra",
		branchCode: "SC_SANTA_MARTA",
	},
	"santa cruz - central": {
		city: "Santa Cruz de la Sierra",
		branchCode: "SC_CENTRAL",
	},
	cochabamba: { city: "Cochabamba", branchCode: "CBA_CENTRAL" },
	"la paz - central": { city: "La Paz", branchCode: "LP_CENTRAL" },
	"la paz": { city: "La Paz", branchCode: "LP_CENTRAL" },
	"alto la delicias": { city: "La Paz", branchCode: "LP_ALTO_LAS_DELICIAS" },
};

/* =============================
   Helpers de normalización/UUID
============================= */
function normalize(str = "") {
	return String(str)
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Convierte UUID string -> bytes
function uuidToBytes(uuid) {
	return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

// Formatea bytes -> UUID string
function bytesToUuid(buf) {
	const hex = buf.toString("hex");
	return [
		hex.substring(0, 8),
		hex.substring(8, 12),
		hex.substring(12, 16),
		hex.substring(16, 20),
		hex.substring(20),
	].join("-");
}

/**
 * UUID v5 (determinístico) desde string. Namespace por defecto: DNS.
 * Implementación RFC 4122: SHA-1(namespace_bytes + name_utf8), ajustar bits versión/variante.
 */
function uuidV5FromString(
	name,
	namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
) {
	const nsBytes = uuidToBytes(namespace);
	const hash = crypto.createHash("sha1");
	hash.update(nsBytes);
	hash.update(Buffer.from(String(name), "utf8"));
	const bytes = Buffer.from(hash.digest().slice(0, 16));

	// version (byte 6 high nibble = 5)
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	// variant (byte 8 high bits 10xx xxxx)
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	return bytesToUuid(bytes);
}

// Genera UUID determinístico por colección + id original (evita colisiones entre colecciones)
function asUuidFor(collectionName, originalId) {
	return uuidV5FromString(`${collectionName}:${String(originalId)}`);
}

/* =============================
   Lógica de branch/overrides
============================= */
function makeBranchCode(name, city) {
	const n = normalize(name);
	const c = normalize(city || "");
	let code = "BRANCH";
	if (c.includes("santa cruz")) code = "SC";
	else if (c.includes("cochabamba")) code = "CBA";
	else if (c.includes("la paz")) code = "LP";

	if (n.includes("santa marta")) code += "_SANTA_MARTA";
	else if (n.includes("central")) code += "_CENTRAL";
	else if (n.includes("alto la delicias") || n.includes("alto las delicias"))
		code += "_ALTO_LAS_DELICIAS";
	else code += "_SUC";

	for (const key of Object.keys(OVERRIDES)) {
		if (n.includes(key)) return OVERRIDES[key].branchCode;
	}
	return code;
}

function applyLocationOverrides(loc) {
	const nameN = normalize(loc.name || "");
	for (const key of Object.keys(OVERRIDES)) {
		if (nameN.includes(key)) {
			loc.city = loc.city || OVERRIDES[key].city;
			loc.branchCode = loc.branchCode || OVERRIDES[key].branchCode;
		}
	}
	if (!loc.branchCode) loc.branchCode = makeBranchCode(loc.name, loc.city);
	return loc;
}

function embeddingTextLocation(loc) {
	const aliases = Array.isArray(loc.aliases) ? loc.aliases.join(" ") : "";
	return [loc.name, loc.city, aliases, loc.description, loc.address]
		.filter(Boolean)
		.join(" ");
}

function embeddingTextMedia(m) {
	return [m.name, m.description].filter(Boolean).join(" ");
}

function toPoint(id, vector, payload) {
	return { id, vector, payload };
}

/* =============================
   Qdrant helpers
============================= */
async function ensureCollection(name, vectorSize) {
	const collections = await qdrantClient.getCollections();
	const exists = collections.collections?.some((c) => c.name === name);
	if (!exists) {
		console.log(
			`🆕 Creando colección "${name}" (size=${vectorSize}, distance=Cosine)`
		);
		await qdrantClient.createCollection(name, {
			vectors: { size: vectorSize, distance: "Cosine" },
			hnsw_config: { m: 16, ef_construct: 200, full_scan_threshold: 10000 },
		});
	} else {
		console.log(`✔️ Colección "${name}" ya existe`);
	}
}

async function ensurePayloadIndexes() {
	const idx = async (col, field_name, field_schema) => {
		try {
			await qdrantClient.createPayloadIndex(col, { field_name, field_schema });
			console.log(`  • Index ${col}.${field_name} (${field_schema}) ✔️`);
		} catch {
			console.log(
				`  • Index ${col}.${field_name} ya existe (o no soportado), ok`
			);
		}
	};

	console.log("🔧 Creando índices de payload...");
	await idx(COLLECTIONS.LOCATIONS, "branchCode", "keyword");
	await idx(COLLECTIONS.LOCATIONS, "city", "keyword");
	await idx(COLLECTIONS.LOCATIONS, "active", "bool");

	await idx(COLLECTIONS.MEDIA, "locationId", "keyword");
	await idx(COLLECTIONS.MEDIA, "branchCode", "keyword");
	await idx(COLLECTIONS.MEDIA, "type", "keyword");
	await idx(COLLECTIONS.MEDIA, "active", "bool");
	await idx(COLLECTIONS.MEDIA, "displayOrder", "integer");
	await idx(COLLECTIONS.MEDIA, "createdAt", "datetime");
}

async function batchUpsert(collection, points, batchSize = DEFAULT_BATCH) {
	for (let i = 0; i < points.length; i += batchSize) {
		const chunk = points.slice(i, i + batchSize);
		await qdrantClient.upsert(collection, { points: chunk });
		console.log(
			`   ↳ ${collection}: upsert ${i + chunk.length}/${points.length}`
		);
	}
}

/* =============================
   utils varios
============================= */
function autoDisplayOrderFromName(name) {
	const match = String(name || "")
		.trim()
		.match(/^(\d+)\s*[-–—]?/);
	if (match) return parseInt(match[1], 10);
	return null;
}

async function nextDisplayOrderFor(qdrant, locationId, type) {
	const page = await qdrantClient.scroll(COLLECTIONS.MEDIA, {
		filter: {
			must: [
				{ key: "locationId", match: { value: locationId } },
				{ key: "type", match: { value: type } },
			],
		},
		with_payload: true,
		limit: 5000,
	});
	const orders = (page.points || []).map((p) => p.payload.displayOrder || 0);
	return orders.length ? Math.max(...orders) + 1 : 1;
}

/* =============================
   MAIN
============================= */
async function main() {
	const args = process.argv.slice(2);
	const isDry = args.includes("--dry");
	const limitIdx = args.indexOf("--limit");
	const hardLimit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;

	const locationsPath = path.resolve("exports", "firestore_locations.json");
	const mediaPath = path.resolve("exports", "firestore_media.json");

	if (!fs.existsSync(locationsPath) || !fs.existsSync(mediaPath)) {
		console.error(
			"❌ No se encuentran los archivos en 'exports/firestore_locations.json' y/o 'exports/firestore_media.json'"
		);
		process.exit(1);
	}

	const locationsRaw = JSON.parse(fs.readFileSync(locationsPath, "utf-8"));
	const mediaRaw = JSON.parse(fs.readFileSync(mediaPath, "utf-8"));

	const locations = locationsRaw.items || [];
	const mediaItems = mediaRaw.items || [];

	console.log(
		`📄 Cargando ${locations.length} locations y ${mediaItems.length} media (dry=${isDry})`
	);

	// === 1) Prepara locations ===
	const preparedLocations = [];
	for (const loc of locations) {
		const originalId = String(loc.id || crypto.randomUUID());
		const uuid = asUuidFor(COLLECTIONS.LOCATIONS, originalId);

		const city = loc.city || null;
		const geo =
			loc.latitude != null && loc.longitude != null
				? { lat: Number(loc.latitude), lon: Number(loc.longitude) }
				: loc.coords || null;

		let cleanLoc = {
			id: uuid, // <-- UUID válido
			originalId, // <-- por trazabilidad
			active: loc.active !== false,
			name: loc.name || "Sucursal",
			city,
			address: loc.address || "",
			description: loc.description || "",
			aliases: Array.isArray(loc.aliases) ? loc.aliases : [],
			geo,
			branchCode: loc.branchCode || null,
			createdAt: loc.createdAt || new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		cleanLoc = applyLocationOverrides(cleanLoc);
		if (!cleanLoc.city) {
			const n = normalize(cleanLoc.name);
			if (n.includes("cochabamba")) cleanLoc.city = "Cochabamba";
			else if (n.includes("santa marta") || n.includes("santa cruz"))
				cleanLoc.city = "Santa Cruz de la Sierra";
			else if (n.includes("la paz")) cleanLoc.city = "La Paz";
		}

		cleanLoc.embedding_text = embeddingTextLocation(cleanLoc);
		const { embedding } = await EmbeddingsService.getEmbeddingOrCachedResponse({
			text: cleanLoc.embedding_text,
		});

		preparedLocations.push({
			point: toPoint(cleanLoc.id, embedding, {
				originalId: cleanLoc.originalId,
				branchCode: cleanLoc.branchCode,
				name: cleanLoc.name,
				city: cleanLoc.city,
				address: cleanLoc.address,
				geo: cleanLoc.geo || null,
				active: cleanLoc.active,
				aliases: cleanLoc.aliases,
				embedding_text: cleanLoc.embedding_text,
				createdAt: cleanLoc.createdAt,
				updatedAt: cleanLoc.updatedAt,
			}),
			vectorSize: embedding.length,
			branchCode: cleanLoc.branchCode,
		});
	}

	// Dimensión de vector (toma de locations o, si vacío, la inferimos con media más abajo)
	let vectorSize = preparedLocations[0]?.vectorSize || null;

	// === 2) Crear colecciones / índices ===
	if (!isDry) {
		// Si aún no sabemos la dimensión, la inferimos de un media (más adelante).
		if (!vectorSize) {
			const firstMedia = mediaItems[0];
			if (!firstMedia) {
				console.error(
					"❌ No hay locations ni media para inferir dimensión de vector"
				);
				process.exit(1);
			}
			const { embedding } =
				await EmbeddingsService.getEmbeddingOrCachedResponse({
					text: embeddingTextMedia(firstMedia),
				});
			vectorSize = embedding.length;
		}

		await ensureCollection(COLLECTIONS.LOCATIONS, vectorSize);
		await ensureCollection(COLLECTIONS.MEDIA, vectorSize);
		await ensureCollection(COLLECTIONS.SESSIONS, 1); // dummy vector
		await ensurePayloadIndexes();
	}

	// === 3) Upsert locations ===
	if (!isDry) {
		await batchUpsert(
			COLLECTIONS.LOCATIONS,
			preparedLocations.map((p) => p.point)
		);
	}

	// Mapa de locations por UUID y por branchCode
	const locByUuid = new Map();
	const locByBranch = new Map();
	preparedLocations.forEach(({ point, branchCode }) => {
		locByUuid.set(String(point.id), point.payload);
		if (branchCode) {
			locByBranch.set(branchCode, { id: point.id, ...point.payload });
		}
	});

	// === 4) Prepara media ===
	const preparedMedia = [];
	const counters = {}; // autonumerar displayOrder por (locationId,type)

	function keyCounter(locationId, type) {
		return `${locationId}::${type}`;
	}

	for (let idx = 0; idx < mediaItems.length; idx++) {
		if (hardLimit && idx >= hardLimit) break;

		const m = mediaItems[idx];
		const originalId = String(m.id || crypto.randomUUID());
		const uuid = asUuidFor(COLLECTIONS.MEDIA, originalId);

		// Resolver locationId:
		let locationId = m.locationId ? String(m.locationId) : null;
		let branchCode = m.branchCode || null;
		let city = m.city || null;

		// Si trae locationId de Firestore -> convertir al UUID correspondiente
		if (locationId) {
			const locUuid = asUuidFor(COLLECTIONS.LOCATIONS, locationId);
			if (locByUuid.has(locUuid)) {
				locationId = locUuid;
				if (!branchCode)
					branchCode = locByUuid.get(locUuid)?.branchCode || null;
				if (!city) city = locByUuid.get(locUuid)?.city || null;
			} else {
				// no coincide, lo dejamos null para evitar mezclar sucursales
				locationId = null;
			}
		}

		// Si aún no tenemos locationId, intenta deducir por overrides en texto
		if (!locationId || !branchCode) {
			const text = normalize(`${m.name || ""} ${m.description || ""}`);
			let matched = null;
			for (const k of Object.keys(OVERRIDES)) {
				if (text.includes(k)) {
					matched = OVERRIDES[k];
					break;
				}
			}
			if (matched) {
				branchCode = branchCode || matched.branchCode;
				city = city || matched.city;
			}
			// Si ya hay branchCode conocido, mapea a UUID
			if (!locationId && branchCode && locByBranch.has(branchCode)) {
				locationId = String(locByBranch.get(branchCode).id);
			}
			// Heurística por city
			if (!locationId && city) {
				for (const [uuidKey, payload] of locByUuid.entries()) {
					if (normalize(payload.city) === normalize(city)) {
						locationId = uuidKey;
						branchCode = payload.branchCode;
						break;
					}
				}
			}
		}

		// Activo solo si hay locationId (evita mezclar sucursales)
		const active = m.active !== false && !!locationId;

		// displayOrder
		let displayOrder = Number.isFinite(m.displayOrder)
			? m.displayOrder
			: autoDisplayOrderFromName(m.name);
		if (!Number.isFinite(displayOrder)) {
			const k = keyCounter(
				locationId || "__none__",
				(m.type || "image").toLowerCase()
			);
			counters[k] = (counters[k] || 0) + 1;
			displayOrder = counters[k];
		}

		const cleanMedia = {
			id: uuid, // <-- UUID válido
			originalId, // <-- para trazabilidad
			type: (m.type || "image").toLowerCase(),
			name: m.name || "",
			description: m.description || "",
			url: m.url || "",
			locationId: locationId || null,
			branchCode:
				branchCode ||
				(locationId && locByUuid.get(String(locationId))?.branchCode) ||
				null,
			city:
				city || (locationId && locByUuid.get(String(locationId))?.city) || null,
			active,
			displayOrder,
			tags: Array.isArray(m.tags) ? m.tags : [],
			createdAt: m.createdAt || new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const embedding_text = embeddingTextMedia(cleanMedia);
		const { embedding } = await EmbeddingsService.getEmbeddingOrCachedResponse({
			text: embedding_text,
		});

		preparedMedia.push(
			toPoint(cleanMedia.id, embedding, {
				originalId: cleanMedia.originalId,
				type: cleanMedia.type,
				name: cleanMedia.name,
				description: cleanMedia.description,
				url: cleanMedia.url,
				locationId: cleanMedia.locationId,
				branchCode: cleanMedia.branchCode,
				city: cleanMedia.city,
				active: cleanMedia.active,
				displayOrder: cleanMedia.displayOrder,
				tags: cleanMedia.tags,
				embedding_text,
				createdAt: cleanMedia.createdAt,
				updatedAt: cleanMedia.updatedAt,
			})
		);
	}

	// === 5) Upsert media ===
	if (!isDry) {
		await batchUpsert(COLLECTIONS.MEDIA, preparedMedia);
	}

	console.log("✅ Seed finalizado.");
}

main().catch((err) => {
	console.error("❌ Error en seeder:", err);
	process.exit(1);
});
