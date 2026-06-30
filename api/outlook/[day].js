// /api/outlook/[day].js
//
// Usage:
//   /api/outlook/day01?lat=52.5&lon=13.4   -> Day 0-1 forecast for Germany
//   /api/outlook/day12?lat=52.5&lon=13.4   -> Day 1-2 forecast for Germany
//   /api/outlook/day23?lat=52.5&lon=13.4   -> Day 2-3 forecast for Germany

const FIREBASE_PROJECT_ID = "hoco-3b23e";
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const STORAGE_BASE_URL = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_PROJECT_ID}.firebasestorage.app/o`;

const DAY_SLOT_MAP = {
    day01: "Day0-1",
    day12: "Day1-2",
    day23: "Day2-3",
};

const REGION = "Germany";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const geojsonCache = new Map(); // runId -> { data, fetchedAt }
const runIdCache = new Map();   // daySlot -> { runId, geojsonUrl, updated, fetchedAt }

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

// Returns { runId, geojsonUrl, updated } for the latest completed run for the given day slot.
// geojsonUrl is stored directly on the Firestore doc (confirmed by the HOCO test page),
// so we can skip the Storage metadata round-trip entirely and save ~200-400 ms per cold call.
async function findLatestRun(daySlot) {
    const cached = runIdCache.get(daySlot);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached;
    }

    // No composite index needed: sort-only query, filter client-side (same pattern as HOCO test page).
    const docs = await runFirestoreQuery({
        from: [{ collectionId: "hoco_requests" }],
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
        limit: 200,
    });

    const match = docs.find(
        (doc) =>
            doc.region === REGION &&
            doc.type === "automated" &&
            doc.status === "completed" &&
            doc.id.endsWith(`-${REGION}-${daySlot}`)
    );

    if (!match) return null;

    // Prefer the geojsonUrl stored on the Firestore doc to avoid an extra Storage metadata fetch.
    // Fall back to constructing the Storage path if the field is absent.
    const geojsonUrl = match.geojsonUrl || null;

    // Use the Firestore doc's own updatedAt/createdAt as the "updated" timestamp if available,
    // otherwise we'll fall back to the Storage metadata (only fetched if geojsonUrl is missing).
    const updated = match.updatedAt || match.createdAt || null;

    const entry = { runId: match.id, geojsonUrl, updated, fetchedAt: Date.now() };
    runIdCache.set(daySlot, entry);
    return entry;
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
    const cached = geojsonCache.get(runId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.data;
    }

    let downloadUrl = geojsonUrlFromFirestore;
    let updated = updatedFromFirestore;

    // Only hit Storage metadata API if the Firestore doc didn't give us a URL directly.
    if (!downloadUrl) {
        const resolved = await resolveStorageUrl(runId);
        downloadUrl = resolved.url;
        updated = updated || resolved.updated;
    }

    const geoResponse = await fetch(downloadUrl);
    if (!geoResponse.ok) {
        throw new Error(`GeoJSON fetch failed (${geoResponse.status}) for ${runId}`);
    }

    const geojson = await geoResponse.json();
    const data = { geojson, updated };
    geojsonCache.set(runId, { data, fetchedAt: Date.now() });
    return data;
}

// --- Formatting ------------------------------------------------------------

// ISO8601 UTC → German local time (CET/CEST), e.g. "29.06.2026, 15:08:32"
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

function pointInPolygonFeature(point, geometry) {
    if (!geometry) return false;

    if (geometry.type === "Polygon") {
        if (!pointInRing(point, geometry.coordinates[0])) return false;
        for (let i = 1; i < geometry.coordinates.length; i++) {
            if (pointInRing(point, geometry.coordinates[i])) return false;
        }
        return true;
    }

    if (geometry.type === "MultiPolygon") {
        return geometry.coordinates.some((polygon) => {
            if (!pointInRing(point, polygon[0])) return false;
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

// --- Main handler ------------------------------------------------------------

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    try {
        const { day, lat, lon } = req.query;

        const daySlot = DAY_SLOT_MAP[String(day || "").toLowerCase()];
        if (!daySlot) {
            return jsonError(res, 400, `Unknown day slot "${day}". Use: ${Object.keys(DAY_SLOT_MAP).join(", ")}`);
        }

        const latNum = Number.parseFloat(lat);
        const lonNum = Number.parseFloat(lon);
        if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
            return jsonError(res, 400, "Missing or invalid 'lat'/'lon' query parameters.");
        }

        const run = await findLatestRun(daySlot);
        if (!run) {
            return jsonError(res, 404, `No completed AUTO-HOCO run found for Germany ${daySlot}.`);
        }

        const { geojson, updated } = await fetchRunGeojson(run.runId, run.geojsonUrl, run.updated);

        const match = findHighestRiskMatch(geojson, [lonNum, latNum]);

        return res.status(200).json({
            day: daySlot,
            region: REGION,
            runId: run.runId,
            lat: latNum,
            lon: lonNum,
            inRiskArea: !!match,
            risk: match ? match.risk : 0,
            label: match ? match.label : null,
            updated,
            updatedDE: formatGermanTime(updated),
        });
    } catch (err) {
        console.error("outlook handler error:", err);
        return jsonError(res, 500, err.message || "Internal error");
    }
}
