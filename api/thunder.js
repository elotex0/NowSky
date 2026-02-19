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
    const result = await checkThunderstorm(lat, lon);

    return jsonResponse({
      lat,
      lon,
      thunderstorm: result.thunderstorm,
      severity: result.severity
    });

  } catch (err) {
    console.error("Both DWD servers failed:", err);

    return jsonResponse({
      lat,
      lon,
      thunderstorm: false,
      severity: null
    });
  }
}

/* ------------------------------------------------ */
/* ---------------- CORE LOGIC -------------------- */
/* ------------------------------------------------ */

async function checkThunderstorm(lat, lon) {
  const delta = 0.05;
  const bbox = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;

  const servers = [
    "https://maps.dwd.de/geoserver/dwd/wms",      // Primary
    "https://brz-maps.dwd.de/geoserver/dwd/wms"   // Backup
  ];

  const timeoutMs = 2500;

  for (const baseUrl of servers) {
    try {
      const response = await fetchWithTimeout(baseUrl, bbox, timeoutMs);

      const data = await response.json();

      if (!data.features || data.features.length === 0) {
        return { thunderstorm: false, severity: null };
      }

      const thunderFeatures = data.features.filter(
        f => f.properties?.EC_GROUP === "Gewitter"
      );

      if (thunderFeatures.length === 0) {
        return { thunderstorm: false, severity: null };
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
        severity: maxSeverityIndex >= 0 ? severityOrder[maxSeverityIndex] : null
      };

    } catch (err) {
      console.warn(`Server failed (${baseUrl}):`, err.message);
      // → nächster Server
      continue;
    }
  }

  // Beide Server fehlgeschlagen
  throw new Error("All servers failed");
}

/* ------------------------------------------------ */
/* ---------------- FETCH HELPER ------------------ */
/* ------------------------------------------------ */

async function fetchWithTimeout(baseUrl, bbox, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const url = new URL(baseUrl);
  url.searchParams.set("SERVICE", "WMS");
  url.searchParams.set("VERSION", "1.1.1");
  url.searchParams.set("REQUEST", "GetFeatureInfo");
  url.searchParams.set("LAYERS", "dwd:Autowarn_Analyse");
  url.searchParams.set("QUERY_LAYERS", "dwd:Autowarn_Analyse");
  url.searchParams.set("BBOX", bbox);
  url.searchParams.set("FEATURE_COUNT", "50");
  url.searchParams.set("HEIGHT", "101");
  url.searchParams.set("WIDTH", "101");
  url.searchParams.set("INFO_FORMAT", "application/json");
  url.searchParams.set("SRS", "EPSG:4326");
  url.searchParams.set("X", "50");
  url.searchParams.set("Y", "50");

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      cache: "no-store"
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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "s-maxage=60, stale-while-revalidate=120",
      ...corsHeaders(),
    },
  });
}
