export const config = {
  runtime: 'edge',
};

/* ------------------------------------------------ */
/* ---------------- BBOXEN / REGIONEN ------------- */
/* ------------------------------------------------ */

const REGIONS = {
  de: { minLat: 47.2, maxLat: 55.1, minLon: 5.8,  maxLon: 15.1 },
  eu: { minLat: 34.0, maxLat: 71.0, minLon: -25.0, maxLon: 45.0 },
};

const SCOPE_KM = {
  local: 0.5,   // ~500m radius
  km1:   1.0,   // ~1 km radius
  km5:   5.0,   // ~5 km radius
  km10: 10.0,   // ~10 km radius
};

/**
 * Berechnet eine BBox um einen Punkt.
 * 1° Lat  ≈ 111 km
 * 1° Lon  ≈ 111 km * cos(lat)
 */
function bboxFromPoint(lat, lon, km) {
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos(lat * Math.PI / 180));
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLon: lon - dLon,
    maxLon: lon + dLon,
  };
}

/* ------------------------------------------------ */
/* ---------------- IN-MEMORY STORE --------------- */
/* ------------------------------------------------ */

// Edge Functions sind stateless – kein echter globaler State über Requests.
// Für persistenten In-Memory-Store brauchst du einen eigenen Node.js Server
// (z.B. auf Railway / Fly.io). Diese Edge Function fetcht stattdessen
// die letzten Einschläge live von der Blitzortung HTTP API.
//
// Alternativ kannst du Vercel KV (Redis) als Store einsetzen –
// der entsprechende Code ist weiter unten als Kommentar vorbereitet.

/* ------------------------------------------------ */
/* ---------------- HAUPTHANDLER ------------------ */
/* ------------------------------------------------ */

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  const { searchParams } = new URL(request.url);

  const scope  = searchParams.get('scope') ?? 'km1';
  const hours  = Math.min(parseInt(searchParams.get('hours') ?? '24'), 48);
  const lat    = parseFloat(searchParams.get('lat'));
  const lon    = parseFloat(searchParams.get('lon'));
  const detail = searchParams.get('detail') === 'true';

  // Validierung
  if (SCOPE_KM[scope] !== undefined && (isNaN(lat) || isNaN(lon))) {
    return jsonResponse(
      { error: `scope "${scope}" benötigt lat und lon als Query-Parameter` },
      400
    );
  }

  try {
    // BBox bestimmen
    let bbox;
    if (REGIONS[scope]) {
      bbox = REGIONS[scope];
    } else {
      const km = SCOPE_KM[scope];
      if (!km) {
        return jsonResponse(
          { error: `Ungültiger scope. Erlaubt: local, km1, km5, km10, de, eu` },
          400
        );
      }
      bbox = bboxFromPoint(lat, lon, km);
    }

    const strikes = await fetchStrikes(bbox, hours);

    const response = {
      count:  strikes.length,
      scope,
      hours,
      bbox: {
        minLat: round(bbox.minLat),
        maxLat: round(bbox.maxLat),
        minLon: round(bbox.minLon),
        maxLon: round(bbox.maxLon),
      },
      ...(SCOPE_KM[scope] && { center: { lat, lon } }),
      ...(detail && { strikes }),
    };

    return jsonResponse(response);

  } catch (err) {
    console.error('Lightning API error:', err);
    return jsonResponse({ error: 'Upstream-Fehler beim Datenabruf' }, 502);
  }
}

/* ------------------------------------------------ */
/* ---------------- DATEN ABRUF ------------------- */
/* ------------------------------------------------ */

/**
 * Ruft Blitzeinschläge von der öffentlichen API ab.
 * Quelle: lightning.api.2ip.io (kostenlos, kein API-Key)
 *
 * Fallback: falls 2ip nicht antwortet, wird
 * api.weather.com/v1/geocode Lightning (kommerziell) versucht –
 * hier als Kommentar vorbereitet.
 */
async function fetchStrikes(bbox, hours) {
  const { minLat, maxLat, minLon, maxLon } = bbox;

  const url = new URL('https://lightning.api.2ip.io/json');
  url.searchParams.set('sw',    `${minLat},${minLon}`);
  url.searchParams.set('ne',    `${maxLat},${maxLon}`);
  url.searchParams.set('hours', String(hours));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });

    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json();

    // Normalisiere Felder (2ip gibt lat/lon/time/polarity zurück)
    return (Array.isArray(raw) ? raw : raw.data ?? []).map(s => ({
      lat:      s.lat   ?? s.latitude,
      lon:      s.lon   ?? s.longitude,
      time:     s.time  ?? s.timestamp,
      polarity: s.pol   ?? s.polarity ?? null,   // -1 = negativ, +1 = positiv
    }));

  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/*
  ---- OPTIONALER FALLBACK: eigene Blitzortung WebSocket-Daten via Vercel KV ----
  Falls du einen separaten Node.js Collector laufen hast, der Strikes in
  Vercel KV (Redis) schreibt, kannst du hier so abrufen:

  import { kv } from '@vercel/kv';

  async function fetchStrikesFromKV(bbox, hours) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const raw = await kv.lrange('strikes', 0, -1);
    return raw
      .map(s => JSON.parse(s))
      .filter(s =>
        s.time >= cutoff &&
        s.lat >= bbox.minLat && s.lat <= bbox.maxLat &&
        s.lon >= bbox.minLon && s.lon <= bbox.maxLon
      );
  }
*/

/* ------------------------------------------------ */
/* ---------------- UTILITIES --------------------- */
/* ------------------------------------------------ */

function round(n, decimals = 4) {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    },
  });
}
