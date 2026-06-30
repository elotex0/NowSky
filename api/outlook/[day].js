// /api/outlook/all.js
// Usage: /api/outlook/all?lat=52.5&lon=13.4

const FIREBASE_PROJECT_ID = "hoco-3b23e";
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const STORAGE_BASE_URL = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_PROJECT_ID}.firebasestorage.app/o`;

const DAY_SLOT_MAP = {
    day0: "Day0-1",
    day1: "Day1-2",
    day2: "Day2-3",
};

const REGION = "Germany";

function jsonError(res, status, message) {
    return res.status(status).json({ error: message });
}

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

async function findLatestRuns() {
    const docs = await runFirestoreQuery({
        from: [{ collectionId: "hoco_requests" }],
        where: {
            compositeFilter: {
                op: "AND",
                filters: [
                    { fieldFilter: { field: { fieldPath: "region" }, op: "EQUAL", value: { stringValue: REGION } } },
                    { fieldFilter: { field: { fieldPath: "type"   }, op: "EQUAL", value: { stringValue: "automated" } } },
                    { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "completed" } } },
                ],
            },
        },
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
        limit: 200,
    });

    const result = {};
    for (const slot of Object.keys(DAY_SLOT_MAP)) {
        const match = docs.find((doc) => doc.id.endsWith(`-${REGION}-${DAY_SLOT_MAP[slot]}`));
        result[slot] = match
            ? {
                runId:      match.id,
                geojsonUrl: match.geojsonUrl || null,
                updated:    match.updatedAt || match.createdAt || null,
                startTime:  match.startTime || null,
                endTime:    match.endTime   || null,
              }
            : null;
    }
    return result;
}

async function resolveStorageUrl(runId) {
    const objectPath = encodeURIComponent(`forecasts/${runId}.geojson`);
    const metadataUrl = `${STORAGE_BASE_URL}/${objectPath}`;
    const metaResponse = await fetch(metadataUrl);
    if (!metaResponse.ok) throw new Error(`Storage metadata failed (${metaResponse.status}) for ${runId}`);
    const metadata = await metaResponse.json();
    const token = metadata.downloadTokens?.split(",")[0];
    if (!token) throw new Error(`No downloadTokens for ${runId}`);
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
    if (!geoResponse.ok) throw new Error(`GeoJSON fetch failed (${geoResponse.status}) for ${runId}`);
    return { geojson: await geoResponse.json(), updated };
}

function pointInRing(point, ring) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function pointInPolygonFeature(point, geometry) {
    if (!geometry) return false;
    if (geometry.type === "Polygon") {
        if (!pointInRing(point, geometry.coordinates[0])) return false;
        for (let i = 1; i < geometry.coordinates.length; i++)
            if (pointInRing(point, geometry.coordinates[i])) return false;
        return true;
    }
    if (geometry.type === "MultiPolygon") {
        return geometry.coordinates.some((polygon) => {
            if (!pointInRing(point, polygon[0])) return false;
            for (let i = 1; i < polygon.length; i++)
                if (pointInRing(point, polygon[i])) return false;
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
        if (!best || risk > best.risk) best = { risk, label: feature.properties?.label || null };
    }
    return best;
}

function formatGermanTime(isoString) {
    if (!isoString) return null;
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(date);
}

function toGermanDateFormat(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!match) return value;
    const [, dd, mm, yyyy, hh, min] = match;
    return `${dd.padStart(2, "0")}.${mm.padStart(2, "0")}.${yyyy} ${hh.padStart(2, "0")}:${min}`;
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    if (req.method === "OPTIONS") return res.status(200).end();

    try {
        const { lat, lon } = req.query;
        const latNum = Number.parseFloat(lat);
        const lonNum = Number.parseFloat(lon);
        if (!Number.isFinite(latNum) || !Number.isFinite(lonNum))
            return jsonError(res, 400, "Missing or invalid 'lat'/'lon' query parameters.");

        // 1 Firestore-Query für alle 3 Slots
        const runs = await findLatestRuns();

        // 3 GeoJSON-Fetches parallel
        const slots = Object.keys(DAY_SLOT_MAP);
        const geoResults = await Promise.allSettled(
            slots.map((slot) => {
                const run = runs[slot];
                if (!run) return Promise.resolve(null);
                return fetchRunGeojson(run.runId, run.geojsonUrl, run.updated);
            })
        );

        const days = {};
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            const run  = runs[slot];
            const geo  = geoResults[i];

            if (!run || geo.status !== "fulfilled" || !geo.value) {
                days[slot] = { error: "no data" };
                continue;
            }

            const { geojson, updated } = geo.value;
            const match = findHighestRiskMatch(geojson, [lonNum, latNum]);

            days[slot] = {
                day:        DAY_SLOT_MAP[slot],
                inRiskArea: !!match,
                risk:       match ? match.risk : 0,
                label:      match ? match.label : null,
                updated,
                updatedDE:  formatGermanTime(updated),
                validPeriod: {
                    start: toGermanDateFormat(run.startTime),
                    end:   toGermanDateFormat(run.endTime),
                },
            };
        }

        return res.status(200).json({ lat: latNum, lon: lonNum, days });
    } catch (err) {
        console.error("outlook/all handler error:", err);
        return jsonError(res, 500, err.message || "Internal error");
    }
}
