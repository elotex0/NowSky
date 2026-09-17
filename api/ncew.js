// api/ncew.js
//
// Serverless Function (Vercel), KEIN Durable Object, KEIN WebSocket:
// Liest die ARCHIVIERTEN Blitzdaten für einen bestimmten 5-Minuten-
// Zeitpunkt und liefert nur die Blitze in Deutschland aus genau diesem
// 5-Minuten-Fenster.
//
// Unterschied zum rollierenden Live-Feed (/api/lightning, für den
// StormTracker): die Archiv-Dateien sind UNVERÄNDERLICH - fragt man
// dieselbe Zeit später erneut ab, bekommt man exakt dieselben Blitze.
// Nichts "verschwindet" mehr nachträglich aus einem Bucket.
//
// Archiv-URL-Schema (Dateiname = DEUTSCHE ORTSZEIT, nicht UTC!):
//   https://radar.wetterstation-neustadt.de/blitze/archive/2026-09-17-0230.json
//   -> enthält die Blitze für das Fenster 02:25–02:30 Uhr (deutsche Zeit).
//
// Aufruf vom Regenradar aus, synchron zum jeweiligen Radar-Frame:
//   /api/ncew?datum=2026-09-17T12:30:00Z
//   (beliebiger Zeitpunkt, egal welche Zeitzone im Query-Param - wird
//   serverseitig auf das 5-Minuten-Raster abgerundet und in deutsche
//   Ortszeit für den Archiv-Dateinamen umgerechnet)

const ARCHIVE_BASE_URL = "https://radar.wetterstation-neustadt.de/blitze/archive";

const DE_BBOX = { latMin: 45.5, latMax: 55.55, lonMin: 3.0, lonMax: 15.55 };
const inGermany = (lat, lon) =>
  lat >= DE_BBOX.latMin && lat <= DE_BBOX.latMax &&
  lon >= DE_BBOX.lonMin && lon <= DE_BBOX.lonMax;

const STEP_MIN = 5;
const stepMs = STEP_MIN * 60 * 1000;

// Formatiert eine Zeit als volles UTC-ISO-Datum mit "+00:00" statt "Z".
function formatIso(dateMs) {
  return new Date(dateMs).toISOString().replace("Z", "+00:00");
}

// Wandelt einen UTC-Zeitpunkt (ms) in seine deutschen Ortszeit-Bestandteile
// um (berücksichtigt automatisch Sommer-/Winterzeit, MESZ/MEZ).
function toBerlinParts(ms) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === "24" ? "00" : hour, // Intl liefert bei Mitternacht manchmal "24"
    minute: get("minute"),
  };
}

// Baut die Archiv-URL für einen bereits auf 5 Minuten gerundeten UTC-Zeitpunkt.
// Der Dateiname folgt der deutschen Ortszeit dieses Zeitpunkts.
function buildArchiveUrl(roundedMs) {
  const p = toBerlinParts(roundedMs);
  return `${ARCHIVE_BASE_URL}/${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}.json`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { datum } = req.query;
    const targetMs = datum ? new Date(datum).getTime() : Date.now();
    if (Number.isNaN(targetMs)) {
      return res.status(400).json({ error: `Ungültiger Zeitpunkt: "${datum}"` });
    }

    // Auf 5-Minuten-Raster abrunden. Das geht in UTC-Arithmetik, obwohl der
    // Dateiname deutsche Ortszeit nutzt: Deutschland liegt immer eine ganze
    // Stundenzahl vor UTC (+1 oder +2), das Runden auf 5-Minuten-Schritte
    // liefert dadurch in beiden Zeitzonen dieselbe Bucket-Grenze.
    const refMs = Math.floor(targetMs / stepMs) * stepMs;
    const vonMs = refMs - stepMs;

    const archiveUrl = buildArchiveUrl(refMs);

    const sourceResp = await fetch(archiveUrl, {
      signal: AbortSignal.timeout(10000),
    });
    if (!sourceResp.ok) {
      throw new Error(`Archiv antwortete mit HTTP ${sourceResp.status} (${archiveUrl})`);
    }
    const sourceData = await sourceResp.json();
    const rawStrikes = Array.isArray(sourceData.strikes) ? sourceData.strikes : [];

    const strikes = rawStrikes
      .filter((p) => {
        if (typeof p.lat !== "number" || typeof p.lon !== "number") return false;
        if (!inGermany(p.lat, p.lon)) return false;
        return p.t >= vonMs && p.t <= refMs;
      })
      .map((p) => ({
        lat: p.lat,
        lon: p.lon,
        time: formatIso(p.t),
        pol: p.pol ?? 0,
      }));

    return res.status(200).json({
      meta: {
        von: formatIso(vonMs),
        bis: formatIso(refMs),
        archivUrl: archiveUrl,
        anzahl: strikes.length,
      },
      strikes,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
