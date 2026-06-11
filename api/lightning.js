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
    const cutoff = new Date(now.getTime() - 60 * 60 * 1000); // exakt jetzt minus 60 Minuten

    const liveRes = await fetch("https://ukwx.duckdns.org/lightning/europe", {
      headers: { "User-Agent": "lightning-api" },
      signal: AbortSignal.timeout(10000),
    });
    if (!liveRes.ok) throw new Error(`HTTP ${liveRes.status} vom Live-Endpoint`);

    const liveData = await liveRes.json();
    const allPoints = liveData.points ?? [];

    // Nur Deutschland + Zeitfilter letzte 60 min
    const filtered = allPoints.filter((p) => {
      if (!inGermany(p)) return false;
      // Zeitstempel: p.time erwartet (Unix-Sekunden oder ISO-String)
      const ts = typeof p.time === "number"
        ? new Date(p.time * 1000)
        : new Date(p.time);
      return ts >= cutoff;
    });

    const points = filtered.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      time: typeof p.time === "number"
        ? new Date(p.time * 1000).toISOString()
        : new Date(p.time).toISOString(),
    }));

    return res.status(200).json({
      meta: {
        von: cutoff.toISOString(),
        bis: now.toISOString(),
        anzahl: points.length,
      },
      points,
    });

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
