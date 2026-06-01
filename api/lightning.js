// api/lightning-recent.js
// Abruf: /api/lightning-recent
// Gibt nur Blitze der letzten 5 Minuten zurück, gefiltert auf Deutschland

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

  const toGermanTime = (unixSec) =>
    new Date(unixSec * 1000).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }) + " Uhr";

  const nowMs      = Date.now();
  const nowSec     = Math.floor(nowMs / 1000);
  // Auf letzte volle 5-Minuten-Marke abrunden (z.B. 12:31 → 12:30:00)
  const cutoffSec  = Math.floor(nowMs / (5 * 60 * 1000)) * (5 * 60);

  try {
    const upstream = await fetch("https://ukwx.duckdns.org/lightning/europe", {
      headers: { "User-Agent": "lightning-recent-api" },
      signal: AbortSignal.timeout(10000),
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status} vom upstream`);

    const data = await upstream.json();
    const allPoints = data.points ?? [];

    const filtered = allPoints
      .filter(p => inGermany(p) && p.t >= cutoffSec)
      .map(p => ({
        zeit:      toGermanTime(p.t),
        timestamp: p.t,
        lat:       p.lat,
        lon:       p.lon,
      }))
      .sort((a, b) => b.timestamp - a.timestamp); // neueste zuerst

    return res.status(200).json({
      aktualisiert: data.fetched_at
        ? toGermanTime(Math.floor(new Date(data.fetched_at).getTime() / 1000))
        : null,
      zeitraum: {
        von: toGermanTime(cutoffSec),
        bis: toGermanTime(nowSec),
      },
      region: "Deutschland",
      anzahl: filtered.length,
      blitze: filtered,
    });

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
