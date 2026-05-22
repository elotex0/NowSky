export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  // CORS Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders(),
    });
  }

  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get('lat'));
  const lon = parseFloat(searchParams.get('lon'));

  if (!lat || !lon) {
    return jsonResponse({ error: 'lat and lon required' }, 400);
  }

  try {
    // Analyse & Vorhersage parallel abfragen
    const [analyseResult, vorhersageResult] = await Promise.allSettled([
      checkLayer(lat, lon, "dwd:Autowarn_Analyse", null),
      checkLayer(lat, lon, "dwd:Autowarn_Vorhersage", "EC_GROUP IN ('Gewitter')"),
    ]);

    const analyse    = analyseResult.status    === 'fulfilled' ? analyseResult.value    : { thunderstorm: false, severity: null, features: [] };
    const vorhersage = vorhersageResult.status === 'fulfilled' ? vorhersageResult.value : { thunderstorm: false, severity: null, features: [] };

    return jsonResponse({
      lat,
      lon,

      // Aktuell: Gewitter direkt über dem Ort?
      current: {
        thunderstorm: analyse.thunderstorm,
        severity:     analyse.severity,
      },

      // Vorhersage: Liegt der Ort in einer Gewitterzugbahn?
      forecast: {
        inStormPath:  vorhersage.thunderstorm,
        severity:     vorhersage.severity,
        warnings:     vorhersage.features.map(f => ({
          severity:    f.properties?.SEVERITY   ?? null,
          type:        f.properties?.EVENT      ?? null,
          validFrom:   f.properties?.ONSET      ?? null,
          validUntil:  f.properties?.EXPIRES    ?? null,
          headline:    f.properties?.HEADLINE   ?? null,
          description: f.properties?.DESCRIPTION ?? null,
          instruction: f.properties?.INSTRUCTION ?? null,
        })),
      },
    });

  } catch (err) {
    console.error("Unexpected error:", err);

    return jsonResponse({
      lat,
      lon,
      current:  { thunderstorm: false, severity: null },
      forecast: { inStormPath: false, severity: null, warnings: [] },
    });
  }
}

/* ------------------------------------------------ */
/* ---------------- CORE LOGIC -------------------- */
/* ------------------------------------------------ */

/**
 * Fragt einen WMS-Layer ab und gibt Gewitter-Features zurück.
 *
 * @param {number}      lat
 * @param {number}      lon
 * @param {string}      layer       - z.B. "dwd:Autowarn_Analyse" oder "dwd:Autowarn_Vorhersage"
 * @param {string|null} cqlFilter   - optionaler CQL_FILTER, z.B. "EC_GROUP IN ('Gewitter')"
 */
async function checkLayer(lat, lon, layer, cqlFilter) {
  const delta = 0.01;
  const bbox  = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;

  const servers = [
    "https://maps.dwd.de/geoserver/dwd/wms",
    "https://brz-maps.dwd.de/geoserver/dwd/wms",
  ];

  const timeoutMs = 2500;

  for (const baseUrl of servers) {
    try {
      const response = await fetchWithTimeout(baseUrl, bbox, layer, cqlFilter, timeoutMs);
      const data     = await response.json();

      if (!data.features || data.features.length === 0) {
        return { thunderstorm: false, severity: null, features: [] };
      }

      // Bei Analyse: nach EC_GROUP filtern (kein serverseitiger CQL-Filter)
      const thunderFeatures = cqlFilter
        ? data.features   // Server hat bereits gefiltert
        : data.features.filter(f => f.properties?.EC_GROUP === "Gewitter");

      if (thunderFeatures.length === 0) {
        return { thunderstorm: false, severity: null, features: [] };
      }

      const severityOrder = ["minor", "moderate", "severe", "extrem"];
      let maxSeverityIndex = -1;

      for (const f of thunderFeatures) {
        const sev = f.properties?.SEVERITY?.toLowerCase();
        const idx = severityOrder.indexOf(sev);
        if (idx > maxSeverityIndex) maxSeverityIndex = idx;
      }

      return {
        thunderstorm: true,
        severity:     maxSeverityIndex >= 0 ? severityOrder[maxSeverityIndex] : null,
        features:     thunderFeatures,
      };

    } catch (err) {
      console.warn(`Server failed (${baseUrl}, ${layer}):`, err.message);
      continue;
    }
  }

  throw new Error(`All servers failed for layer ${layer}`);
}

/* ------------------------------------------------ */
/* ---------------- FETCH HELPER ------------------ */
/* ------------------------------------------------ */

async function fetchWithTimeout(baseUrl, bbox, layer, cqlFilter, timeoutMs) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), timeoutMs);

  const url = new URL(baseUrl);
  url.searchParams.set("SERVICE",      "WMS");
  url.searchParams.set("VERSION",      "1.1.1");
  url.searchParams.set("REQUEST",      "GetFeatureInfo");
  url.searchParams.set("LAYERS",       layer);
  url.searchParams.set("QUERY_LAYERS", layer);
  url.searchParams.set("BBOX",         bbox);
  url.searchParams.set("FEATURE_COUNT","50");
  url.searchParams.set("HEIGHT",       "101");
  url.searchParams.set("WIDTH",        "101");
  url.searchParams.set("INFO_FORMAT",  "application/json");
  url.searchParams.set("SRS",          "EPSG:4326");
  url.searchParams.set("X",            "50");
  url.searchParams.set("Y",            "50");

  // CQL_FILTER nur setzen wenn vorhanden (Vorhersage-Layer)
  if (cqlFilter) {
    url.searchParams.set("CQL_FILTER", cqlFilter);
  }

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      cache:  "no-store",
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response;

  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/* ------------------------------------------------ */
/* ---------------- UTILITIES --------------------- */
/* ------------------------------------------------ */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "s-maxage=60, stale-while-revalidate=120",
      ...corsHeaders(),
    },
  });
}
