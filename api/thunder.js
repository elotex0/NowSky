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
    const since = getLast5MinUTC();
    const filter = `CREATED>=${since} AND EC_GROUP='Gewitter'`;
    const url = `https://maps.dwd.de/geoserver/dwd/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=dwd:Autowarn_Vorhersage&outputFormat=application/json&CQL_FILTER=${encodeURIComponent(filter)}`;

    const response = await fetchWithTimeout(url, 4000);
    const data = await response.json();
    const features = data.features || [];

    // Punkt-in-Polygon prüfen
    const hitting = features.filter(f =>
      f.geometry?.type === 'Polygon' && pointInPolygon(lat, lon, f.geometry.coordinates[0])
    );

    const thunderstorm = hitting.length > 0;
    const severityOrder = ['minor', 'moderate', 'severe', 'extreme'];
    let maxSev = -1;
    for (const f of hitting) {
      const idx = severityOrder.indexOf(f.properties?.SEVERITY?.toLowerCase());
      if (idx > maxSev) maxSev = idx;
    }

    return jsonResponse({
      lat,
      lon,
      since,
      thunderstorm,
      severity: maxSev >= 0 ? severityOrder[maxSev] : null,
      warnings: hitting.map(f => ({
        severity:   f.properties?.SEVERITY  ?? null,
        event:      f.properties?.EC_II     ?? null,
        created:    f.properties?.CREATED   ?? null,
        onset:      f.properties?.ONSET     ?? null,
        expires:    f.properties?.EXPIRES   ?? null,
        areaColor:  f.properties?.EC_AREA_COLOR ?? null,
      })),
    });

  } catch (err) {
    console.error('Error:', err);
    return jsonResponse({
      lat, lon,
      thunderstorm: false,
      severity: null,
      warnings: [],
    });
  }
}

/* ------------------------------------------------ */
/* ---------------- HELPERS ----------------------- */
/* ------------------------------------------------ */

function getLast5MinUTC() {
  const now = new Date();
  now.setUTCSeconds(0, 0);
  now.setUTCMinutes(Math.floor(now.getUTCMinutes() / 5) * 5);
  return now.toISOString().slice(0, 19) + 'Z';
}

// Ray-casting Algorithmus: Punkt in Polygon?
function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    },
  });
}
