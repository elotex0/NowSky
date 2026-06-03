export const config = {
  runtime: 'edge',
};

const DWD_URL = 'https://app-prod-static.warnwetter.de/v16/gewitter_monitor.json';

// DWD Gewittermonitor level → SEVERITY string
const LEVEL_SEVERITY = {
  2: 'minor',
  3: 'moderate',
  4: 'severe',
  5: 'extreme',
};

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get('lat'));
  const lon = parseFloat(searchParams.get('lon'));

  if (isNaN(lat) || isNaN(lon)) {
    return jsonResponse({ error: 'lat and lon required' }, 400);
  }

  try {
    const response = await fetchWithTimeout(DWD_URL, 4000);
    const data = await response.json();

    const gebiete = data.gebiete;
    if (!gebiete || !Array.isArray(gebiete)) {
      throw new Error('No gebiete in response');
    }

    // Find all Gebiete whose polygon contains the requested point
    // DWD polygon format: flat array [lat0, lon0, lat1, lon1, ...]
    const hitting = gebiete.filter(g =>
      g.polygon && pointInPolygon(lat, lon, g.polygon)
    );

    // Pick the highest level among all matching Gebiete
    let maxLevel = -1;
    for (const g of hitting) {
      if ((g.level ?? 0) > maxLevel) maxLevel = g.level;
    }

    const severity = LEVEL_SEVERITY[maxLevel] ?? null;

    return jsonResponse({
      lat,
      lon,
      current: {
        thunderstorm: hitting.length > 0,
        severity,
      },
    });
  } catch (err) {
    console.error('Error:', err);
    return jsonResponse({
      lat,
      lon,
      current: { thunderstorm: false, severity: null },
    });
  }
}

/**
 * Point-in-polygon for DWD flat polygon arrays.
 * flat = [lat0, lon0, lat1, lon1, ...]
 * Ray-casting algorithm — lon = x axis, lat = y axis.
 */
function pointInPolygon(lat, lon, flat) {
  const n = Math.floor(flat.length / 2);
  let inside = false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const latI = flat[i * 2];
    const lonI = flat[i * 2 + 1];
    const latJ = flat[j * 2];
    const lonJ = flat[j * 2 + 1];

    const intersect =
      (latI > lat) !== (latJ > lat) &&
      lon < ((lonJ - lonI) * (lat - latI)) / (latJ - latI) + lonI;

    if (intersect) inside = !inside;
  }

  return inside;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
    });
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
