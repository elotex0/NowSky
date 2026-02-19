export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get('lat'));
  const lon = parseFloat(searchParams.get('lon'));

  if (!lat || !lon) {
    return jsonResponse({ error: 'lat and lon required' }, 400);
  }

  try {
    const result = await checkThunderstorm(lat, lon);
    return jsonResponse({ lat, lon, thunderstorm: result.thunderstorm, severity: result.severity });
  } catch (err) {
    console.error("Both DWD servers failed:", err);
    return jsonResponse({ lat, lon, thunderstorm: false, severity: null });
  }
}

/* ---------------- CORE LOGIC ---------------- */

async function checkThunderstorm(lat, lon) {
  const delta = 0.03; // kleines BBOX um den Punkt
  const bbox = `${lon - delta},${lat - delta},${lon + delta},${lat + delta},EPSG:4326`;

  const servers = [
    "https://maps.dwd.de/geoserver/dwd/ows",     // Primary
    "https://brz-maps.dwd.de/geoserver/dwd/ows" // Backup
  ];

  for (const baseUrl of servers) {
    try {
      const data = await fetchWFSFeature(baseUrl, bbox);
      if (!data?.features?.length) continue;

      // nur Gewitter-Features
      const thunder = data.features.filter(f => f.properties?.EC_GROUP === "Gewitter");
      if (!thunder.length) continue;

      const severityOrder = ["minor", "moderate", "severe", "extrem"];
      let max = -1;
      for (const f of thunder) {
        const idx = severityOrder.indexOf(f.properties?.SEVERITY?.toLowerCase());
        if (idx > max) max = idx;
      }

      return { thunderstorm: true, severity: max >= 0 ? severityOrder[max] : null };
    } catch (err) {
      console.warn(`Server failed (${baseUrl}):`, err.message);
      continue;
    }
  }

  throw new Error("All servers failed");
}

/* ---------------- FETCH HELPER ---------------- */

async function fetchWFSFeature(baseUrl, bbox) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  const url = new URL(baseUrl);
  url.searchParams.set("SERVICE", "WFS");
  url.searchParams.set("VERSION", "2.0.0");
  url.searchParams.set("REQUEST", "GetFeature");
  url.searchParams.set("TYPENAMES", "dwd:Autowarn_Analyse");
  url.searchParams.set("OUTPUTFORMAT", "application/json");
  url.searchParams.set("SRSNAME", "EPSG:4326");
  url.searchParams.set("BBOX", bbox);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal, cache: "no-store" });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/* ---------------- UTILITIES ------------------ */

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
