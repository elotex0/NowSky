// api/lightning.js
//
// Einfache Serverless Function (Vercel), KEIN Durable Object, KEIN WebSocket:
// Liest bei jeder Anfrage die JSON-Quelle aus und liefert nur die
// Blitze in Deutschland aus dem aktuellen 5-Minuten-Raster-Fenster.
//
// Quelle liefert bereits fertige HTTP/JSON-Daten (kein LZW, kein Live-Socket),
// daher genügt ein einfacher fetch() pro Request - keine Dauerverbindung nötig.

const SOURCE_URL = "https://radar.wetterstation-neustadt.de/blitze/live/latest.json";

const DE_BBOX = { latMin: 45.5, latMax: 55.55, lonMin: 3.0, lonMax: 15.55 };
const inGermany = (lat, lon) =>
  lat >= DE_BBOX.latMin && lat <= DE_BBOX.latMax &&
  lon >= DE_BBOX.lonMin && lon <= DE_BBOX.lonMax;

const STEP_MIN = 5;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // Referenzzeitpunkt fest auf 5-Min-Raster (z.B. 14:30, 14:35, ...).
    // Fenster ist [refZeit - 5min, refZeit].
    const realNow = new Date();
    const realNowMs = realNow.getTime();
    const stepMs = STEP_MIN * 60 * 1000;
    const roundedNowMs = Math.floor(realNowMs / stepMs) * stepMs;
    const refDate = new Date(roundedNowMs);
    const refSec = Math.floor(roundedNowMs / 1000);
    const vonSec = refSec - stepMs / 1000;

    const sourceResp = await fetch(SOURCE_URL, {
      signal: AbortSignal.timeout(10000),
    });
    if (!sourceResp.ok) {
      throw new Error(`Quelle antwortete mit HTTP ${sourceResp.status}`);
    }
    const sourceData = await sourceResp.json();
    const rawStrikes = Array.isArray(sourceData.strikes) ? sourceData.strikes : [];

    const filtered = rawStrikes
      .filter((p) => {
        if (typeof p.lat !== "number" || typeof p.lon !== "number") return false;
        if (!inGermany(p.lat, p.lon)) return false;
        const sSec = p.t / 1000;
        return sSec >= vonSec && sSec <= refSec;
      })
      .map((p) => ({
        lat: p.lat,
        lon: p.lon,
        time: new Date(p.t).toISOString(),
        pol: p.pol ?? 0,
      }));

    return res.status(200).json({
      meta: {
        referenzZeitpunkt: refDate.toISOString(),
        echteAbrufzeit: realNow.toISOString(),
        von: new Date(vonSec * 1000).toISOString(),
        bis: refDate.toISOString(),
        anzahl: filtered.length,
      },
      strikes: filtered,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
