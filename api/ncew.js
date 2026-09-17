// api/lightning.js
//
// Einfache Serverless Function (Vercel), KEIN Durable Object, KEIN WebSocket:
// Liest bei jeder Anfrage die JSON-Quelle aus und liefert die Blitze in
// Deutschland aus den letzten 60 Minuten, aufgeteilt in 12 Buckets à 5 Minuten.
// Jeder Bucket hat echte Uhrzeiten (z.B. "14:05–14:10") als Label.
//
// Quelle liefert bereits fertige HTTP/JSON-Daten (kein LZW, kein Live-Socket),
// daher genügt ein einfacher fetch() pro Request - keine Dauerverbindung nötig.

const SOURCE_URL = "https://radar.wetterstation-neustadt.de/blitze/live/latest.json";

const DE_BBOX = { latMin: 45.5, latMax: 55.55, lonMin: 3.0, lonMax: 15.55 };
const inGermany = (lat, lon) =>
  lat >= DE_BBOX.latMin && lat <= DE_BBOX.latMax &&
  lon >= DE_BBOX.lonMin && lon <= DE_BBOX.lonMax;

const STEP_MIN = 5;           // Größe eines einzelnen Buckets
const WINDOW_MIN = 60;        // Gesamtfenster
const NUM_BUCKETS = WINDOW_MIN / STEP_MIN; // 12 Buckets

// Formatiert eine Zeit als volles UTC-ISO-Datum mit "+00:00" statt "Z",
// z.B. "2026-09-16T23:05:00+00:00".
function formatUhrzeit(dateMs) {
  return new Date(dateMs).toISOString().replace("Z", "+00:00");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const realNow = new Date();
    const realNowMs = realNow.getTime();
    const stepMs = STEP_MIN * 60 * 1000;
    const windowMs = WINDOW_MIN * 60 * 1000;

    // Referenzzeitpunkt fest auf 5-Min-Raster (z.B. 14:30, 14:35, ...).
    const roundedNowMs = Math.floor(realNowMs / stepMs) * stepMs;
    const refDate = new Date(roundedNowMs);

    // Gesamtfenster: [refDate - 60min, refDate]
    const windowStartMs = roundedNowMs - windowMs;

    // Buckets vorbereiten: 12 Stück à 5 Minuten, älteste zuerst.
    // bucket[i]: von = windowStartMs + i*stepMs, bis = von + stepMs
    const buckets = Array.from({ length: NUM_BUCKETS }, (_, i) => {
      const vonMs = windowStartMs + i * stepMs;
      const bisMs = vonMs + stepMs;
      return {
        von: formatUhrzeit(vonMs),
        bis: formatUhrzeit(bisMs),
        vonMs,
        bisMs,
        anzahl: 0,
        strikes: [],
      };
    });

    const sourceResp = await fetch(SOURCE_URL, {
      signal: AbortSignal.timeout(10000),
    });
    if (!sourceResp.ok) {
      throw new Error(`Quelle antwortete mit HTTP ${sourceResp.status}`);
    }
    const sourceData = await sourceResp.json();
    const rawStrikes = Array.isArray(sourceData.strikes) ? sourceData.strikes : [];

    for (const p of rawStrikes) {
      if (typeof p.lat !== "number" || typeof p.lon !== "number") continue;
      if (!inGermany(p.lat, p.lon)) continue;

      const tMs = p.t; // Quelle liefert ms
      if (tMs < windowStartMs || tMs > roundedNowMs) continue;

      // passenden Bucket finden
      const idx = Math.min(
        NUM_BUCKETS - 1,
        Math.floor((tMs - windowStartMs) / stepMs)
      );
      const bucket = buckets[idx];
      bucket.anzahl += 1;
      bucket.strikes.push({
        lat: p.lat,
        lon: p.lon,
        time: formatUhrzeit(tMs),
        pol: p.pol ?? 0,
      });
    }

    // interne Hilfsfelder (vonMs/bisMs) aus der Ausgabe entfernen
    const bucketsOut = buckets.map(({ vonMs, bisMs, ...rest }) => rest);
    const gesamtAnzahl = bucketsOut.reduce((sum, b) => sum + b.anzahl, 0);

    return res.status(200).json({
      meta: {
        referenzZeitpunkt: formatUhrzeit(roundedNowMs),
        echteAbrufzeit: formatUhrzeit(realNowMs),
        fensterVon: formatUhrzeit(windowStartMs),
        fensterBis: formatUhrzeit(roundedNowMs),
        anzahlBuckets: NUM_BUCKETS,
        bucketGroesseMin: STEP_MIN,
        anzahlGesamt: gesamtAnzahl,
      },
      buckets: bucketsOut,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
