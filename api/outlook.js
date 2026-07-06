// /api/outlook.js
//
// benutzung:
//   /api/outlook?lat=52.5&lon=13.4   -> { day0: {...}, day1: {...}, day2: {...} }
//
// Hinweis: Es wird bewusst KEIN `where`-Gleichheitsfilter kombiniert mit
// `orderBy` verwendet, da das in Firestore einen Composite-Index braucht,
// der hier nicht angelegt werden kann (kein Console-Zugriff). Stattdessen
// wird nur nach createdAt sortiert (braucht keinen Index) und der Rest
// (region/type/status/daySlot) wird wie im Original client-seitig gefiltert.
// Die Field-Mask (`select`) reduziert aber trotzdem die Transfergröße pro Doc.

const FIREBASE_PROJECT_ID = "hoco-3b23e";
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const STORAGE_BASE_URL = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_PROJECT_ID}.firebasestorage.app/o`;

const DAY_SLOT_MAP = {
    day0: "Day0-1",
    day1: "Day1-2",
    day2: "Day2-3",
};

const REGION = "Germany";

// Nur die Felder, die wir tatsächlich brauchen -> kleinere Payload pro Doc.
const REQUIRED_FIELDS = [
    "region",
    "type",
    "status",
    "geojsonUrl",
    "updatedAt",
    "createdAt",
    "startTime",
    "endTime",
];

function jsonError(res, status, message) {
    return res.status(status).json({ error: message });
}

// --- Firestore REST helpers -------------------------------------------------

function decodeFirestoreValue(value) {
    if (value == null) return null;
    if ("stringValue" in value) return value.stringValue;
    if ("integerValue" in value) return Number(value.integerValue);
    if ("doubleValue" in value) return value.doubleValue;
    if ("booleanValue" in value) return value.booleanValue;
    if ("timestampValue" in value) return value.timestampValue;
    if ("nullValue" in value) return null;
    if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
    if ("mapValue" in value) return decodeFirestoreFields(value.mapValue.fields || {});
    return null;
}

function decodeFirestoreFields(fields) {
    const out = {};
    for (const key of Object.keys(fields || {})) {
        out[key] = decodeFirestoreValue(fields[key]);
    }
    return out;
}

async function runFirestoreQuery(structuredQuery) {
    const response = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ structuredQuery }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Firestore query failed (${response.status}): ${text}`);
    }

    const rows = await response.json();
    return rows
        .filter((row) => row.document)
        .map((row) => ({
            id: row.document.name.split("/").pop(),
            ...decodeFirestoreFields(row.document.fields || {}),
        }));
}

// Fetches the Firestore listing ONCE and finds matches for all 3 day slots,
// instead of querying Firestore 3x (one query per slot).
//
// Kein `where`-Filter kombiniert mit `orderBy` (siehe Hinweis oben) -> Filterung
// nach region/type/status/daySlot passiert wie im Original in JS. Die
// Field-Mask (`select`) spart trotzdem Transfervolumen pro Dokument.
async function findLatestRunsForAllSlots() {
    const docs = await runFirestoreQuery({
        from: [{ collectionId: "hoco_requests" }],
        select: {
            fields: REQUIRED_FIELDS.map((fieldPath) => ({ fieldPath })),
        },
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
        limit: 200,
    });

    const result = {};

    for (const slotKey of Object.keys(DAY_SLOT_MAP)) {
        const daySlot = DAY_SLOT_MAP[slotKey];
        const match = docs.find(
            (doc) =>
                doc.region === REGION &&
                doc.type === "automated" &&
                doc.status === "completed" &&
                doc.id.endsWith(`-${REGION}-${daySlot}`)
        );

        result[slotKey] = match
            ? {
                  daySlot,
                  runId: match.id,
                  geojsonUrl: match.geojsonUrl || null,
                  updated: match.updatedAt || match.createdAt || null,
                  // Stored in Firestore as "dd/mm/yyyy hh:mm", same format the HOCO web app writes
                  // when a run is created (see parseHocoTime / formatHocoDateTime in the frontend).
                  startTime: match.startTime || null,
                  endTime: match.endTime || null,
              }
            : null;
    }

    return result;
}

// --- Firebase Storage helpers ----------------------------------------------

// Only called as fallback when the Firestore doc doesn't carry a geojsonUrl.
async function resolveStorageUrl(runId) {
    const objectPath = encodeURIComponent(`forecasts/${runId}.geojson`);
    const metadataUrl = `${STORAGE_BASE_URL}/${objectPath}`;

    const metaResponse = await fetch(metadataUrl);
    if (!metaResponse.ok) {
        const text = await metaResponse.text().catch(() => "");
        throw new Error(`Storage metadata fetch failed (${metaResponse.status}) for ${runId}: ${text}`);
    }

    const metadata = await metaResponse.json();
    const token = metadata.downloadTokens?.split(",")[0];
    if (!token) throw new Error(`No downloadTokens found in storage metadata for ${runId}`);

    return {
        url: `${metadataUrl}?alt=media&token=${token}`,
        updated: metadata.updated || metadata.timeCreated || null,
    };
}

async function fetchRunGeojson(runId, geojsonUrlFromFirestore, updatedFromFirestore) {
    let downloadUrl = geojsonUrlFromFirestore;
    let updated = updatedFromFirestore;

    if (!downloadUrl) {
        const resolved = await resolveStorageUrl(runId);
        downloadUrl = resolved.url;
        updated = updated || resolved.updated;
    }

    const geoResponse = await fetch(downloadUrl);
    if (!geoResponse.ok) {
        throw new Error(`GeoJSON fetch failed (${geoResponse.status}) for ${runId}`);
    }

    return { geojson: await geoResponse.json(), updated };
}

// --- Formatting ------------------------------------------------------------

function formatGermanTime(isoString) {
    if (!isoString) return null;
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;

    return new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(date);
}

// Converts HOCO's stored "dd/mm/yyyy hh:mm" into German "dd.mm.yyyy hh:mm" notation.
function toGermanDateFormat(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!match) return value; // fall back to the raw string if it doesn't match the expected shape

    const [, dd, mm, yyyy, hh, min] = match;
    return `${dd.padStart(2, "0")}.${mm.padStart(2, "0")}.${yyyy} ${hh.padStart(2, "0")}:${min}`;
}

// --- Point-in-polygon -------------------------------------------------------

function pointInRing(point, ring) {
    const [x, y] = point;
    let inside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersects =
            yi > y !== yj > y &&
            x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }

    return inside;
}

// Schneller Bounding-Box-Check, bevor der teurere Ray-Casting-Test läuft.
// Wird pro Ring gecached (via WeakMap), damit die Bbox nicht bei jedem
// Request neu berechnet wird, solange dasselbe geparste geojson-Objekt lebt.
const bboxCache = new WeakMap();

function getBoundingBox(ring) {
    const cached = bboxCache.get(ring);
    if (cached) return cached;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    const bbox = { minX, minY, maxX, maxY };
    bboxCache.set(ring, bbox);
    return bbox;
}

function inBoundingBox(point, bbox) {
    const [x, y] = point;
    return x >= bbox.minX && x <= bbox.maxX && y >= bbox.minY && y <= bbox.maxY;
}

function pointInPolygonFeature(point, geometry) {
    if (!geometry) return false;

    if (geometry.type === "Polygon") {
        const outerRing = geometry.coordinates[0];
        if (!inBoundingBox(point, getBoundingBox(outerRing))) return false;
        if (!pointInRing(point, outerRing)) return false;
        for (let i = 1; i < geometry.coordinates.length; i++) {
            if (pointInRing(point, geometry.coordinates[i])) return false;
        }
        return true;
    }

    if (geometry.type === "MultiPolygon") {
        return geometry.coordinates.some((polygon) => {
            const outerRing = polygon[0];
            if (!inBoundingBox(point, getBoundingBox(outerRing))) return false;
            if (!pointInRing(point, outerRing)) return false;
            for (let i = 1; i < polygon.length; i++) {
                if (pointInRing(point, polygon[i])) return false;
            }
            return true;
        });
    }

    return false;
}

function findHighestRiskMatch(geojsonData, point) {
    const features = Array.isArray(geojsonData?.features) ? geojsonData.features : [];
    let best = null;

    for (const feature of features) {
        if (feature.properties?.feature_type && feature.properties.feature_type !== "polygon") continue;
        if (!pointInPolygonFeature(point, feature.geometry)) continue;

        const risk = Number.parseFloat(
            feature.properties?.risk ?? feature.properties?.risk_pct ?? feature.properties?.probability
        );
        if (!Number.isFinite(risk)) continue;

        if (!best || risk > best.risk) {
            best = { risk, label: feature.properties?.label || null };
        }
    }

    return best;
}

// --- Per-slot resolution ----------------------------------------------------

async function resolveSlot(slotKey, run, point) {
    if (!run) {
        return { error: `No completed AUTO-HOCO run found for Germany ${DAY_SLOT_MAP[slotKey]}.` };
    }

    try {
        const fetchStart = Date.now();
        const { geojson, updated } = await fetchRunGeojson(run.runId, run.geojsonUrl, run.updated);
        const fetchMs = Date.now() - fetchStart;

        const matchStart = Date.now();
        const match = findHighestRiskMatch(geojson, point);
        const matchMs = Date.now() - matchStart;

        console.log(
            `[outlook] slot=${slotKey} runId=${run.runId} fetchMs=${fetchMs} matchMs=${matchMs} features=${geojson?.features?.length ?? 0}`
        );

        return {
            day: run.daySlot,
            region: REGION,
            runId: run.runId,
            inRiskArea: !!match,
            risk: match ? match.risk : 0,
            label: match ? match.label : null,
            updated,
            updatedDE: formatGermanTime(updated),
            validPeriod: {
                start: toGermanDateFormat(run.startTime),
                end: toGermanDateFormat(run.endTime),
            },
        };
    } catch (err) {
        return { day: run.daySlot, error: err.message || "Internal error" };
    }
}

// --- Main handler ------------------------------------------------------------

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    const requestStart = Date.now();

    try {
        const { lat, lon } = req.query;

        const latNum = Number.parseFloat(lat);
        const lonNum = Number.parseFloat(lon);
        if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
            return jsonError(res, 400, "Missing or invalid 'lat'/'lon' query parameters.");
        }

        const point = [lonNum, latNum];

        const firestoreStart = Date.now();
        const runs = await findLatestRunsForAllSlots();
        console.log(`[outlook] firestoreMs=${Date.now() - firestoreStart}`);

        const [day0, day1, day2] = await Promise.all([
            resolveSlot("day0", runs.day0, point),
            resolveSlot("day1", runs.day1, point),
            resolveSlot("day2", runs.day2, point),
        ]);

        console.log(`[outlook] totalMs=${Date.now() - requestStart}`);

        // Kein Cache auf die Geodaten selbst (die ändern sich alle 6h und
        // sollen immer frisch berechnet werden). Aber gleiche lat/lon-Anfragen,
        // die innerhalb weniger Sekunden reinkommen, dürfen ruhig von der
        // Vercel-/Browser-Edge kurz gecacht werden, um Lastspitzen abzufedern.
        res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");

        return res.status(200).json({
            lat: latNum,
            lon: lonNum,
            day0,
            day1,
            day2,
        });
    } catch (err) {
        console.error("outlook handler error:", err);
        return jsonError(res, 500, err.message || "Internal error");
    }
}
