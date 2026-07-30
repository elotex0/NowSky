// api/messwerte.js
// Vercel Serverless Function
// Ruft die Quelle ab, filtert auf Deutschland-Bbox, liefert CORS *

const SOURCE_URL = 'https://radar.wetterstation-neustadt.de/messwerte.json';

// Grobe Bounding Box für Deutschland
const BBOX = {
  latMin: 47.27,
  latMax: 55.06,
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
    const filtered = Array.isArray(data) ? data.filter(inGermanyBbox) : [];

    return res.status(200).json(filtered);
  } catch (err) {
    return res.status(502).json({
      error: 'Fehler beim Abrufen der Wetterdaten',
      details: err.message
    });
  }
}
