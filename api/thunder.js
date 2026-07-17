export const config = {
  runtime: 'edge',
};

// Primary + Fallback-Server (AWS-Mirror), analog zu Request.j0() in der App
const DWD_URL = 'https://app-prod-static.warnwetter.de/v16/gewitter_monitor.json';
const DWD_URL_FALLBACK = 'https://s3-eu-west-1.amazonaws.com/app-prod-static-irl.warnwetter.de/v16/gewitter_monitor.json';
const DWD_FORECAST_URL = 'https://app-prod-static.warnwetter.de/v16/warnings_nowcast.json';

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

  // --- current (Gewittermonitor) ---
  let current = { thunderstorm: false, severity: null };
  let currentSource = 'none';
  try {
    const data = await fetchGewitterWithFallback();
    currentSource = data.__source;

    const gebiete = data.gebiete;
    if (!gebiete || !Array.isArray(gebiete)) {
      throw new Error('No gebiete in response');
    }

    const hitting = gebiete.filter(g =>
      g.polygon && pointInPolygon(lat, lon, g.polygon)
    );

    let maxLevel = -1;
    for (const g of hitting) {
      if ((g.level ?? 0) > maxLevel) maxLevel = g.level;
    }

    current = {
      thunderstorm: hitting.length > 0,
      severity: LEVEL_SEVERITY[maxLevel] ?? null,
    };
  } catch (err) {
    console.error('Gewittermonitor error:', err);
  }

  // --- forecast (Nowcast warnings) ---
  let forecast = { thunderstorm: false, severity: null };
  try {
    const response = await fetchWithTimeout(DWD_FORECAST_URL, 4000);
    const data = await response.json();
    const warnings = data.warnings;
    if (!warnings || !Array.isArray(warnings)) {
      throw new Error('No warnings in response');
    }

    const now = Date.now();

    const hitting = warnings.filter(w =>
      typeof w.event === 'string' && w.event.includes('Gewitter') &&
      (w.end ?? 0) > now &&
      Array.isArray(w.regions) &&
      w.regions.some(r => r.polygon && pointInPolygon(lat, lon, r.polygon))
    );

    let maxLevel = -1;
    for (const w of hitting) {
      if ((w.level ?? 0) > maxLevel) maxLevel = w.level;
    }

    forecast = {
      thunderstorm: hitting.length > 0,
      severity: LEVEL_SEVERITY[maxLevel] ?? null,
    };
  } catch (err) {
    console.error('Nowcast error:', err);
  }

  return jsonResponse({
    lat,
    lon,
    current,
    currentSource, // "primary" | "fallback" | "none" — zeigt, welcher Server geliefert hat
    forecast,
  });
}

/**
 * Fragt gewitter_monitor.json von primary UND fallback parallel ab.
 * Nimmt die Antwort mit nicht-leeren "gebiete".
 * Bevorzugt primary, falls beide Daten haben.
 * Wirft, falls beide fehlschlagen oder beide leer sind.
 */
async function fetchGewitterWithFallback() {
  const results = await Promise.allSettled([
    fetchWithTimeout(DWD_URL, 4000).then(r => r.json()),
    fetchWithTimeout(DWD_URL_FALLBACK, 4000).then(r => r.json()),
  ]);

  const [primaryResult, fallbackResult] = results;

  const primary = primaryResult.status === 'fulfilled' ? primaryResult.value : null;
  const fallback = fallbackResult.status === 'fulfilled' ? fallbackResult.value : null;

  const primaryGebiete = primary?.gebiete ?? [];
  const fallbackGebiete = fallback?.gebiete ?? [];

  if (primaryGebiete.length > 0) {
    return { ...primary, __source: 'primary' };
  }
  if (fallbackGebiete.length > 0) {
    return { ...fallback, __source: 'fallback' };
  }
  if (primary) {
    return { ...primary, __source: 'primary' }; // beide leer, primary bevorzugen
  }
  if (fallback) {
    return { ...fallback, __source: 'fallback' };
  }
  throw new Error('Both DWD gewitter_monitor sources failed');
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
