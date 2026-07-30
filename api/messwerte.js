// api/messwerte.js
// Vercel Serverless Function
// Ruft die Quelle ab, filtert auf Deutschland-Bbox, liefert CORS *

const SOURCE_URL = 'https://radar.wetterstation-neustadt.de/messwerte.json';

// Grobe Bounding Box für Deutschland
const BBOX = {
  latMin: 47.27,
  latMax: 55.6,
  lonMin: 5.87,
  lonMax: 15.04
};

function inGermanyBbox(station) {
  const { lat, lon } = station;
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  return (
    lat >= BBOX.latMin &&
    lat <= BBOX.latMax &&
    lon >= BBOX.lonMin &&
    lon <= BBOX.lonMax
  );
}

function isDwdOnly(station) {
  // Nur exakt "dwd", kein "dwd_sn" oder sonstige Varianten
  return station.source === 'dwd';
}

function getLatestTs(stations) {
  // "ts" ist ISO-Format (z.B. "2026-07-30T22:10"), UTC -> string-Vergleich reicht
  let latest = null;
  for (const s of stations) {
    if (typeof s.ts === 'string' && (latest === null || s.ts > latest)) {
      latest = s.ts;
    }
  }
  return latest;
}

export default async function handler(req, res) {
  // CORS Header für alle Requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const response = await fetch(SOURCE_URL);
    if (!response.ok) {
      throw new Error(`Quelle antwortete mit Status ${response.status}`);
    }
    const data = await response.json();
    const preFiltered = Array.isArray(data)
      ? data.filter(station => inGermanyBbox(station) && isDwdOnly(station))
      : [];

    // Nur die neuesten Werte behalten (höchster ts, UTC)
    const latestTs = getLatestTs(preFiltered);
    const filtered = latestTs
      ? preFiltered.filter(station => station.ts === latestTs)
      : preFiltered;


    return res.status(200).json(filtered);
  } catch (err) {
    return res.status(502).json({
      error: 'Fehler beim Abrufen der Wetterdaten',
      details: err.message
    });
  }
}
