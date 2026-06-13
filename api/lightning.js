// api/lightning.js
// Abruf: /api/lightning

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Deutschland Bounding Box
  const DE_BBOX = { latMin: 47.4, latMax: 55.05, lonMin: 6.0, lonMax: 15.05 };

  const inGermany = (p) =>
    p.lat >= DE_BBOX.latMin && p.lat <= DE_BBOX.latMax &&
    p.lon >= DE_BBOX.lonMin && p.lon <= DE_BBOX.lonMax;

  try {
    const now = new Date();
    const cutoffSec = Math.floor(now.getTime() / 1000) - 60 * 5; // Unix-Sekunden, exakt jetzt minus 60 min

    const liveRes = await fetch("https://ukwx.duckdns.org/lightning/europe", {
      headers: { "User-Agent": "lightning-api" },
      signal: AbortSignal.timeout(10000),
    });
    if (!liveRes.ok) throw new Error(`HTTP ${liveRes.status} vom Live-Endpoint`);

    const liveData = await liveRes.json();
    const allPoints = liveData.points ?? [];

    // Nur Deutschland + Zeitfilter letzte 60 min
    // Zeitfeld ist "t" (Unix-Sekunden)
    const filtered = allPoints.filter((p) =>
      inGermany(p) && p.t >= cutoffSec
    );

    const points = filtered.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      time: new Date(p.t * 1000).toISOString(),
    }));

    return res.status(200).json({
      meta: {
        von: new Date(cutoffSec * 1000).toISOString(),
        bis: now.toISOString(),
        anzahl: points.length,
      },
      points,
    });

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
