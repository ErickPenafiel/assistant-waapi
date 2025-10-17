/**
 * scripts/export-firestore-to-json.js
 * Exporta Firestore→JSON:
 *  - locations  -> firestore_locations.json
 *  - prompt_images -> firestore_media.json
 *
 * CLI:
 *  node scripts/export-firestore-to-json.js [--out=./exports] [--all] [--limit=200] [--pretty] [--verbose]
 *
 * Requisitos:
 *  - ../config/firebase/config.js exporta { db } (Admin SDK inicializado)
 */

require("dotenv").config({ path: process.env.ENV_PATH || ".env" });

const fs = require("fs");
const path = require("path");
const { db } = require("../src/config/firebase/config.js");

/* ───────────── CLI & helpers ───────────── */
const ARGS = process.argv.slice(2).reduce((acc, a) => {
	const m = a.match(/^--([^=]+)(?:=(.+))?$/);
	if (m) acc[m[1]] = m[2] === undefined ? true : m[2];
	return acc;
}, {});
const OUT_DIR = ARGS.out || "./exports";
const INCLUDE_ALL = !!ARGS.all; // si true, no filtra active:true
const LIMIT = ARGS.limit ? Number(ARGS.limit) : undefined;
const PRETTY = !!ARGS.pretty;
const VERBOSE = !!ARGS.verbose;

function log(...x) {
	console.log("[Export]", ...x);
}
function vlog(...x) {
	if (VERBOSE) console.log("[Export][v]", ...x);
}
function warn(...x) {
	console.warn("[Export][WARN]", ...x);
}
function error(...x) {
	console.error("[Export][ERROR]", ...x);
}

function toISO(ts) {
	try {
		if (!ts) return null;
		if (ts?.toDate) return ts.toDate().toISOString();
		if (ts instanceof Date) return ts.toISOString();
		if (typeof ts === "number") return new Date(ts).toISOString();
		if (typeof ts === "string") return new Date(ts).toISOString();
		return null;
	} catch {
		return null;
	}
}

/* ───────────── Fetchers ───────────── */
async function fetchLocations() {
	let ref = db.collection("locations");
	if (!INCLUDE_ALL) ref = ref.where("active", "==", true);
	const snap = await ref.get();
	const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	log(
		`locations: ${rows.length} doc(s) leídos${
			INCLUDE_ALL ? " (all)" : " (active:true)"
		}`
	);
	return LIMIT ? rows.slice(0, LIMIT) : rows;
}

async function fetchPromptImages() {
	let ref = db.collection("prompt_images");
	if (!INCLUDE_ALL) ref = ref.where("active", "==", true);
	const snap = await ref.get();
	const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	log(
		`prompt_images: ${rows.length} doc(s) leídos${
			INCLUDE_ALL ? " (all)" : " (active:true)"
		}`
	);
	return LIMIT ? rows.slice(0, LIMIT) : rows;
}

/* ───────────── Normalizadores ───────────── */
function normalizeLocation(row) {
	const out = {
		id: row.id,
		active: row.active !== false,
		name: row.name || "",
		city: row.city || null,
		address: row.address || "",
		description: row.description || "",
		latitude: Number.isFinite(row.latitude) ? row.latitude : null,
		longitude: Number.isFinite(row.longitude) ? row.longitude : null,
		aliases: Array.isArray(row.aliases) ? row.aliases : [],
		createdAt: toISO(row.createdAt),
		updatedAt: toISO(row.updatedAt),
	};
	vlog("location:", out.id, out.name, "city=", out.city);
	return out;
}

function normalizeMedia(row) {
	const url = row.url || row.imageUrl || row.videoUrl || row.audioUrl || "";

	// normalizar type
	let type = (row.type || "").toString().toLowerCase();
	if (!/^(image|video|audio)$/.test(type)) {
		if (/video/.test(type)) type = "video";
		else if (/audio/.test(type)) type = "audio";
		else type = "image";
	}

	const out = {
		id: row.id,
		active: row.active !== false,
		type, // "image" | "video" | "audio"
		name: row.name || "",
		description: row.description || "",
		url,
		// opcionales si existen en Firestore:
		city: row.city || null,
		branch: row.branch || null,
		tags: Array.isArray(row.tags) ? row.tags : [],
		createdAt: toISO(row.createdAt),
		updatedAt: toISO(row.updatedAt),
	};
	vlog("media:", out.id, out.type, "name=", out.name);
	return out;
}

/* ───────────── Writer ───────────── */
function ensureDir(dir) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJSON(filePath, data) {
	const json = PRETTY ? JSON.stringify(data, null, 2) : JSON.stringify(data);
	fs.writeFileSync(filePath, json, "utf8");
	log("→ escrito:", filePath, `(${Buffer.byteLength(json, "utf8")} bytes)`);
}

/* ───────────── Main ───────────── */
(async () => {
	try {
		log("Export Firestore → JSON");
		log("Opciones:", { OUT_DIR, INCLUDE_ALL, LIMIT, PRETTY, VERBOSE });

		ensureDir(OUT_DIR);

		const [locationsRaw, mediaRaw] = await Promise.all([
			fetchLocations(),
			fetchPromptImages(),
		]);

		const locations = locationsRaw.map(normalizeLocation);
		const media = mediaRaw.map(normalizeMedia);

		const locPath = path.join(OUT_DIR, "firestore_locations.json");
		const mediaPath = path.join(OUT_DIR, "firestore_media.json");

		writeJSON(locPath, { count: locations.length, items: locations });
		writeJSON(mediaPath, { count: media.length, items: media });

		log("✅ Export completado.");
	} catch (e) {
		error("Fallo en export:", e?.message || e);
		process.exit(1);
	}
})();
