require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const { createHash } = require("crypto");
const { qdrantClient } = require("../src/config/clients/qdrant-client.js");
const { EmbeddingsService } = require("../src/services/embeddings-service.js");
const { db } = require("../src/config/firebase/config.js");
/**
 * scripts/seed-from-firestore.js
 * Lee Firestore (locations & prompt_images) y siembra en Qdrant (colección "sucursales_media")
 *
 * Requisitos:
 *  - db: Firestore Admin (../config/firebase/config.js)
 *  - qdrantClient: @qdrant/js-client-rest inicializado
 *  - EmbeddingsService.getEmbeddingOrCachedResponse({ text }) -> { embedding: number[] }
 *
 * Variables de entorno opcionales:
 *  - ENV_PATH (ruta del .env)
 *  - COLLECTION_BRANCHES (por defecto "sucursales_media")
 */

const COLLECTION = process.env.COLLECTION_BRANCHES || "sucursales_media";

/* -----------------------------
   Utils: uuid v5 + text helpers
----------------------------- */
function uuidV5FromString(
	name,
	namespace = "00000000-0000-0000-0000-000000000000"
) {
	const nsHex = namespace.replace(/-/g, "");
	if (!/^[0-9a-fA-F]{32}$/.test(nsHex))
		throw new Error("uuidV5FromString: namespace inválido");
	const nsBytes = Buffer.from(nsHex, "hex");
	const nameBytes = Buffer.from(name, "utf8");
	const toHash = Buffer.concat([nsBytes, nameBytes]);
	const hash = createHash("sha1").update(toHash).digest(); // 20 bytes
	const bytes = Buffer.from(hash.slice(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC4122
	const hex = bytes.toString("hex");
	return [
		hex.substring(0, 8),
		hex.substring(8, 12),
		hex.substring(12, 16),
		hex.substring(16, 20),
		hex.substring(20),
	].join("-");
}

function slugify(s) {
	return (s || "")
		.toString()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)+/g, "");
}

function toISO(ts) {
	try {
		// Firestore Timestamp -> Date -> ISO
		if (ts?.toDate) return ts.toDate().toISOString();
		if (ts instanceof Date) return ts.toISOString();
		if (typeof ts === "number") return new Date(ts).toISOString();
		return ts || null;
	} catch {
		return null;
	}
}

function norm(s) {
	return (s || "")
		.toString()
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
}

/* -----------------------------------------
   Heurísticas para city y branch (prompt_media)
----------------------------------------- */
const CITY_ALIASES = [
	{ city: "La Paz", re: /\b(la\s*paz|lpz)\b/i },
	{ city: "Santa Cruz", re: /\b(santa\s*cruz|scz|sc)\b/i },
	{ city: "Cochabamba", re: /\b(cochabamba|cbba)\b/i },
];

function inferCity(...texts) {
	const joined = (texts || []).filter(Boolean).join(" ");
	for (const c of CITY_ALIASES) {
		if (c.re.test(joined)) return c.city;
	}
	return null;
}

function inferBranchFromText(txt) {
	if (!txt) return null;
	// captura: "sucursal Santa Marta", "sucursal América", etc.
	const m1 = txt.match(/sucursal\s+([a-záéíóúñ][\w\sáéíóúñ\-]+)/i);
	if (m1) {
		// corta en " de " / " en " / coma
		return m1[1].split(/,| de | en /i)[0].trim();
	}
	// prueba "sucursal .* de <BARRIO/NOMBRE>"
	const m2 = txt.match(/sucursal\s+.*\s+de\s+([A-ZÁÉÍÓÚÑ][\w\sÁÉÍÓÚÑ\-]+)/i);
	if (m2) return m2[1].trim();
	return null;
}

/* ---------------------------------
   Firestore fetchers
--------------------------------- */
async function fetchLocations() {
	const snap = await db
		.collection("locations")
		.where("active", "==", true)
		.get();
	return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchPromptImages() {
	const snap = await db
		.collection("prompt_images")
		.where("active", "==", true)
		.get();
	return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ---------------------------------
   Qdrant: crear colección si falta
--------------------------------- */
async function ensureCollection() {
	const { embedding } = await EmbeddingsService.getEmbeddingOrCachedResponse({
		text: "dimension-probe",
	});
	if (!embedding?.length) throw new Error("Embedding dimension no detectada");

	try {
		await qdrantClient.getCollection(COLLECTION);
		console.log(`ℹ️  Colección "${COLLECTION}" ya existe.`);
		return embedding.length;
	} catch {
		console.log(`ℹ️  Colección "${COLLECTION}" no existe. Creando...`);
	}

	await qdrantClient.createCollection(COLLECTION, {
		vectors: { size: embedding.length, distance: "Cosine" },
		optimizers_config: { default_segment_number: 2 },
	});

	console.log(`✅ Colección "${COLLECTION}" creada (dim=${embedding.length}).`);
	return embedding.length;
}

/* ---------------------------------
   Generadores de puntos (Qdrant)
--------------------------------- */
async function makeLocationPoint(fsDoc) {
	const cityGuess =
		inferCity(fsDoc.name, fsDoc.description, fsDoc.address) ||
		(/la\s*paz/i.test(fsDoc.name)
			? "La Paz"
			: /santa\s*cruz/i.test(fsDoc.name)
			? "Santa Cruz"
			: /cochabamba/i.test(fsDoc.name)
			? "Cochabamba"
			: null);

	const baseText = `${fsDoc.name || ""} ${cityGuess || ""} ${
		fsDoc.address || ""
	} ${fsDoc.description || ""}`;
	const { embedding } = await EmbeddingsService.getEmbeddingOrCachedResponse({
		text: baseText,
	});

	const payload = {
		type: "location",
		active: fsDoc.active !== false,
		name: fsDoc.name || "Sucursal",
		city: cityGuess, // puede quedar null si no se infiere
		address: fsDoc.address || "",
		description: fsDoc.description || "",
		latitude: Number.isFinite(fsDoc.latitude) ? fsDoc.latitude : null,
		longitude: Number.isFinite(fsDoc.longitude) ? fsDoc.longitude : null,
		slug: slugify(`${cityGuess || "sin-ciudad"}-${fsDoc.name || fsDoc.id}`),
		external_id: `fs:locations:${fsDoc.id}`,
		createdAt: toISO(fsDoc.createdAt),
		updatedAt: toISO(fsDoc.updatedAt),
		source: "firestore",
		source_collection: "locations",
		source_id: fsDoc.id,
	};

	const id = uuidV5FromString(payload.external_id);
	return { id, vector: embedding, payload };
}

function normalizeMediaType(t) {
	const s = norm(t);
	if (/video/.test(s)) return "video";
	if (/audio/.test(s)) return "audio";
	return "image";
}

async function makeMediaPoint(fsDoc) {
	const type = normalizeMediaType(fsDoc.type || "");
	const url =
		fsDoc.url || fsDoc.imageUrl || fsDoc.videoUrl || fsDoc.audioUrl || "";

	// intentar inferir city/branch desde description/name/url
	const cityGuess = inferCity(fsDoc.description, fsDoc.name, url);
	const branchGuess =
		inferBranchFromText(fsDoc.description) || inferBranchFromText(fsDoc.name);

	const baseText = `${fsDoc.name || ""} ${fsDoc.description || ""} ${
		branchGuess || ""
	} ${cityGuess || ""}`;
	const { embedding } = await EmbeddingsService.getEmbeddingOrCachedResponse({
		text: baseText,
	});

	const payload = {
		type, // "image" | "video" | "audio"
		active: fsDoc.active !== false,
		name: fsDoc.name || "",
		description: fsDoc.description || "",
		url,
		branch: branchGuess || null, // puede quedar null si no se infiere
		city: cityGuess || null, // puede quedar null si no se infiere
		slug: slugify(
			`media-${cityGuess || "sin-ciudad"}-${
				branchGuess || "sin-sucursal"
			}-${type}-${fsDoc.name || fsDoc.id}`
		),
		external_id: `fs:prompt_images:${fsDoc.id}`,
		createdAt: toISO(fsDoc.createdAt),
		updatedAt: toISO(fsDoc.updatedAt),
		source: "firestore",
		source_collection: "prompt_images",
		source_id: fsDoc.id,
	};

	const id = uuidV5FromString(payload.external_id);
	return { id, vector: embedding, payload };
}

/* ---------------------------------
   Upsert batched en Qdrant
--------------------------------- */
async function upsertPoints(points, chunkSize = 64) {
	for (let i = 0; i < points.length; i += chunkSize) {
		const chunk = points.slice(i, i + chunkSize);
		await qdrantClient.upsert(COLLECTION, { points: chunk });
	}
}

/* ---------------------------------
   Runner principal
--------------------------------- */
(async () => {
	try {
		await ensureCollection();

		console.log("↗️  Leyendo Firestore: locations...");
		const fsLocations = await fetchLocations();

		console.log("↗️  Leyendo Firestore: prompt_images...");
		const fsMedia = await fetchPromptImages();

		// Generar puntos
		const points = [];

		// locations -> type: location
		for (const loc of fsLocations) {
			try {
				const pt = await makeLocationPoint(loc);
				points.push(pt);
			} catch (e) {
				console.warn(`⚠️  Saltando location ${loc.id}:`, e.message);
			}
		}

		// prompt_images -> type: image|video|audio
		for (const media of fsMedia) {
			try {
				const pt = await makeMediaPoint(media);
				points.push(pt);

				// Aviso si faltó inferir city/branch (sirve para luego mejorar datos)
				if (!pt.payload.city || !pt.payload.branch) {
					console.warn(
						`ℹ️  Media ${media.id} sin city/branch claro. city=${pt.payload.city} branch=${pt.payload.branch} (usa "sucursal <Nombre>" y ciudad en description para inferir mejor)`
					);
				}
			} catch (e) {
				console.warn(`⚠️  Saltando media ${media.id}:`, e.message);
			}
		}

		if (!points.length) {
			console.log("No hay puntos para upsert (verifica filtros active:true).");
			process.exit(0);
		}

		console.log(
			`⬆️  Subiendo ${points.length} puntos a Qdrant (${COLLECTION})...`
		);
		await upsertPoints(points, 64);

		console.log("✅ Seeder completado.");
		console.log(
			"Ejemplos:",
			points.slice(0, 3).map((p) => ({
				id: p.id,
				type: p.payload.type,
				city: p.payload.city,
				branch: p.payload.branch,
				name: p.payload.name,
			}))
		);
	} catch (err) {
		console.error(
			"❌ Error en el seeder:",
			err?.response?.data || err?.data || err
		);
		process.exit(1);
	}
})();
