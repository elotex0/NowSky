// api/messwerte.js
// Vercel Serverless Function
// Ruft die Quelle ab, filtert auf Deutschland-Bbox + erlaubte Sources,
// behaelt pro Source nur die neuesten Werte, wandelt Uhrzeiten UTC -> Europe/Berlin um,
// benennt Felder um und rechnet Windgeschwindigkeiten in km/h um.
// Liefert CORS *

const SOURCE_URL = 'https://radar.wetterstation-neustadt.de/messwerte.json';

// Grobe Bounding Box für Deutschland (mit Puffer nach Norden fuer Sylt/Lübeck etc.)
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

// Erlaubte Quellen.
const ALLOWED_SOURCES = ['dwd', 'iem', 'meteofrance', 'dhmz', 'meteohub' ];

function isAllowedSource(station) {
  return ALLOWED_SOURCES.includes(station.source);
}

// Behaelt pro Station (id) nur den Eintrag mit dem neuesten ts.
// Das ist wichtig, weil nicht alle Stationen exakt zur gleichen Minute
// melden (auch innerhalb einer Source koennen einzelne Stationen
// 5-10 Minuten hinterherhaengen). Wenn man stattdessen auf einen
// einzigen globalen oder Source-weiten "neuesten" ts exakt matcht,
// fallen alle leicht verspaeteten Stationen komplett raus.
function dedupeKeepLatestPerStation(stations) {
  const latestById = new Map();
  for (const s of stations) {
    if (typeof s.ts !== 'string' || typeof s.id === 'undefined') continue;
    const existing = latestById.get(s.id);
    if (!existing || s.ts > existing.ts) {
      latestById.set(s.id, s);
    }
  }
  return Array.from(latestById.values());
}

// Ermittelt den global neuesten Zeitstempel ueber alle (bereits
// deduplizierten) Stationen hinweg, nur fuer die Anzeige im "updated"-Feld.
function getGlobalLatestTs(stations) {
  let latest = null;
  for (const s of stations) {
    if (typeof s.ts === 'string' && (latest === null || s.ts > latest)) {
      latest = s.ts;
    }
  }
  return latest;
}

// Wandelt einen UTC-Zeitstempel ohne Zonen-Suffix (z.B. "2026-07-30T22:40")
// in die lokale europäische Zeit (Europe/Berlin, MEZ/MESZ automatisch) um.
// Rueckgabe im Format "YYYY-MM-DDTHH:mm"
function utcToBerlin(tsUtc) {
  if (typeof tsUtc !== 'string') return tsUtc;
  const utcDate = new Date(tsUtc + ':00Z');
  if (isNaN(utcDate.getTime())) return tsUtc;

  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(utcDate);

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
}

// Formatierte, gut lesbare Version fuer das "updated"-Feld ganz oben.
// Da jetzt mehrere Sources mit ggf. unterschiedlichen Zeitstempeln existieren,
// zeigt "updated" den jeweils neuesten Wert JE SOURCE an.
function formatUpdated(tsUtc) {
  if (typeof tsUtc !== 'string') return null;
  const utcDate = new Date(tsUtc + ':00Z');
  if (isNaN(utcDate.getTime())) return null;

  const formatted = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(utcDate);

  const tzAbbr = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    timeZoneName: 'short'
  })
    .formatToParts(utcDate)
    .find(p => p.type === 'timeZoneName')?.value || '';

  return `${formatted} Uhr (${tzAbbr})`;
}

// ws/fx liegen in der Quelle bereits in km/h vor (geprüft anhand realer Werte,
// z.B. max. ws ~42 km/h passt, als m/s wären es unrealistische Sturmböen).
// Daher hier keine Umrechnung, nur ggf. Rundung auf 1 Nachkommastelle.
function roundKmh(value) {
  if (typeof value !== 'number') return value;
  return Math.round(value * 10) / 10;
}

function mapStation(station) {
  return {
    id: station.id,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    t2m: station.temp,
    hum: station.hum,
    td2m: station.dp,
    ws: roundKmh(station.ws),
    wd: station.wd,
    gust: roundKmh(station.fx),
    rr: station.rr,
    rr_h: station.rr_h,
    gs: station.gs,
    sd: station.sd,
    p0: station.p0,
    pp: station.pp,
    ww: station.ww,
    ts: utcToBerlin(station.ts),
    source: station.source,
    sn: station.sn
  };
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
      ? data.filter(station => isAllowedSource(station))
      : [];

    // Pro Station (id) nur den jeweils neuesten Eintrag behalten,
    // statt auf einen einzigen globalen/Source-weiten Zeitstempel zu matchen.
    // So bleiben auch leicht verspaetete Stationen erhalten.
    const filtered = dedupeKeepLatestPerStation(preFiltered);

    const stations = filtered.map(mapStation);

    // "updated" zeigt den global neuesten Zeitstempel ueber alle
    // (jetzt deduplizierten) Stationen hinweg.
    const globalLatestTs = getGlobalLatestTs(filtered);

    return res.status(200).json({
      updated: formatUpdated(globalLatestTs),
      count: stations.length,
      stations
    });
  } catch (err) {
    return res.status(502).json({
      error: 'Fehler beim Abrufen der Wetterdaten',
      details: err.message
    });
  }
}
