// /api/outlook/[day].js
//
// Usage:
//   /api/outlook/day01?lat=52.5&lon=13.4   -> Day 0-1 forecast for Germany
//   /api/outlook/day12?lat=52.5&lon=13.4   -> Day 1-2 forecast for Germany
//   /api/outlook/day23?lat=52.5&lon=13.4   -> Day 2-3 forecast for Germany
//
// Response:
//   {
//     "day": "Day0-1",
//     "region": "Germany",
//     "runId": "AUTO-1782738326898-Germany-Day0-1",
//     "lat": 52.5,
//     "lon": 13.4,
//     "inRiskArea": true,
//     "risk": 40,
//     "label": "Slight Risk",
//     "validPeriod": { "start": "...", "end": "..." }
//   }

const FIREBASE_PROJECT_ID = "hoco-3b23e";
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const STORAGE_BASE_URL = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_PROJECT_ID}.firebasestorage.app/o`;

// Maps the friendly URL slug to the "DayX-Y" segment used inside the run ID / forecast filename.
const DAY_SLOT_MAP = {
    day01: "Day0-1",
    day12: "Day1-2",
    day23: "Day2-3",
};

const REGION = "Germany";

// Simple in-memory cache (persists across warm invocations of the same serverless instance,
// not guaranteed across cold starts/different instances - that's fine, it's just to avoid
// hammering Firestore/Storage on bursts of requests for the same data).
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const geojsonCache = new Map(); // runId -> { data, fetchedAt }
const runIdCache = new Map();   // daySlot -> { runId, fetchedAt }

function jsonError(res, status, message) {
    return res.status(status).json({ error: message });
}

// --- Firestore REST helpers -------------------------------------------------

// Decodes a Firestore REST "fields" value object into a plain JS value.
function decodeFirestoreValue(value) {
    if (value == null) return null;
    if ("stringValue" in value) return value.stringValue;
    if ("integerValue" in value) return Number(value.integerValue);
    if ("doubleValue" in value) return value.doubleValue;
    if ("booleanValue" in value) return value.booleanValue;
    if ("timestampValue" in value) return value.timestampValue;
    if ("nullValue" in value) return null;
    if ("arrayValue" in value) {
        return (value.arrayValue.values || []).map(decodeFirestoreValue);
    }
    if ("mapValue" in value) {
        return decodeFirestoreFields(value.mapValue.fields || {});
    }
    return null;
}

function decodeFirestoreFields(fields) {
    const out = {};
    for (const key of Object.keys(fields || {})) {
        out[key] = decodeFirestoreValue(fields[key]);
    }
    return out;
}

// Runs a Firestore "structured query" via the REST API (no SDK / no service account needed,
// since the project's Firestore rules allow public reads on hoco_requests - same access the
// HOCO web app itself uses anonymously).
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
    // runQuery returns an array of { document, readTime } entries (plus possibly entries
    // with no `document` field as periodic progress markers - filter those out).
    return rows
        .filter((row) => row.document)
        .map((row) => ({
            id: row.document.name.split("/").pop(),
            ...decodeFirestoreFields(row.document.fields || {}),
        }));
}

// Finds the most recently created, completed AUTO-HOCO run for Germany + the given day slot.
async function findLatestGermanyRunId(daySlot) {
    const cached = runIdCache.get(daySlot);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.runId;
    }

    // NOTE: deliberately no `where` clause here - combining multiple equality filters with
    // an orderBy requires a Firestore composite index to be created in the Firebase console
    // first. Since we don't have (or want to require) console access to that project, we just
    // sort by createdAt (which needs no special index, same as the public HOCO test page does)
    // and pull a larger recent batch, then do all the region/type/status/day-slot filtering
    // here in JS.
    const structuredQuery = {
        from: [{ collectionId: "hoco_requests" }],
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
        limit: 200, // larger batch since we're filtering client-side now instead of in the query
    };

    const docs = await runFirestoreQuery(structuredQuery);

    // Run IDs look like "AUTO-<timestamp>-Germany-Day0-1". Filter by region/type/status fields
    // AND match the exact day slot suffix so e.g. "Day0-1" doesn't accidentally match "Day1-2".
    const match = docs.find(
        (doc) =>
            doc.region === REGION &&
            doc.type === "automated" &&
            doc.status === "completed" &&
            doc.id.endsWith(`-${REGION}-${daySlot}`)
    );

    if (!match) {
        return null;
    }

    runIdCache.set(daySlot, { runId: match.id, fetchedAt: Date.now() });
    return match.id;
}

// --- Firebase Storage helpers ----------------------------------------------

// Looks up the object's metadata (which includes the permanent download token) and builds
// the public "?alt=media&token=..." URL from it.
async function resolveDownloadUrl(runId) {
    const objectPath = encodeURIComponent(`forecasts/${runId}.geojson`);
    const metadataUrl = `${STORAGE_BASE_URL}/${objectPath}`;

    const metaResponse = await fetch(metadataUrl);
    if (!metaResponse.ok) {
        const text = await metaResponse.text().catch(() => "");
        throw new Error(`Storage metadata fetch failed (${metaResponse.status}) for ${runId}: ${text}`);
    }

    const metadata = await metaResponse.json();
    const token = metadata.downloadTokens?.split(",")[0]; // downloadTokens can be a comma list; take the first

    if (!token) {
        throw new Error(`No downloadTokens found in storage metadata for ${runId}`);
    }

    return `${metadataUrl}?alt=media&token=${token}`;
}

// Fetches and caches the GeoJSON for a given run.
async function fetchRunGeojson(runId) {
    const cached = geojsonCache.get(runId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.data;
    }

    const downloadUrl = await resolveDownloadUrl(runId);
    const geoResponse = await fetch(downloadUrl);
    if (!geoResponse.ok) {
        throw new Error(`GeoJSON fetch failed (${geoResponse.status}) for ${runId}`);
    }

    const data = await geoResponse.json();
    geojsonCache.set(runId, { data, fetchedAt: Date.now() });
    return data;
}

// --- Point-in-polygon -------------------------------------------------------

// Standard ray-casting algorithm. `point` is [lon, lat]. `ring` is an array of [lon, lat]
// pairs (GeoJSON winding order doesn't matter for this test).
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
        // First ring = outer boundary, subsequent rings = holes.
        if (!pointInRing(point, geometry.coordinates[0])) return false;
        for (let i = 1; i < geometry.coordinates.length; i++) {
            if (pointInRing(point, geometry.coordinates[i])) return false; // inside a hole
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

// Given the full GeoJSON and a point, finds the highest-risk polygon feature that contains it.
// (HOCO risk bands are nested - a point inside the "high" band is technically also inside the
// "low" band's outer extent in some renderings, so we want the highest matching risk value.)
function findHighestRiskMatch(geojsonData, point) {
    const features = Array.isArray(geojsonData?.features) ? geojsonData.features : [];
    let best = null;

    for (const feature of features) {
        if (feature.properties?.feature_type && feature.properties.feature_type !== "polygon") continue;
        if (!pointInPolygonFeature(point, feature.geometry)) continue;

        const risk = Number.parseFloat(feature.properties?.risk ?? feature.properties?.risk_pct ?? feature.properties?.probability);
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
            return jsonError(
                res,
                400,
                `Unknown or missing day slot "${day}". Use one of: ${Object.keys(DAY_SLOT_MAP).join(", ")}`
            );
        }

        const latNum = Number.parseFloat(lat);
        const lonNum = Number.parseFloat(lon);
        if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
            return jsonError(res, 400, "Missing or invalid 'lat'/'lon' query parameters.");
        }

        const runId = await findLatestGermanyRunId(daySlot);
        if (!runId) {
            return jsonError(res, 404, `No completed AUTO-HOCO run found for Germany ${daySlot}.`);
        }

        const geojsonData = await fetchRunGeojson(runId);

        // GeoJSON point order is [lon, lat].
        const match = findHighestRiskMatch(geojsonData, [lonNum, latNum]);

        return res.status(200).json({
            day: daySlot,
            region: REGION,
            runId,
            lat: latNum,
            lon: lonNum,
            inRiskArea: !!match,
            risk: match ? match.risk : 0,
            label: match ? match.label : null,
        });
    } catch (err) {
        console.error("outlook handler error:", err);
        return jsonError(res, 500, err.message || "Internal error");
    }
}
