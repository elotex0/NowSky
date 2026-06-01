// api/lightning-recent.js
// Abruf: /api/lightning-recent
// Gibt Blitze der letzten 10 Minuten zurück, gefiltert auf Deutschland.
// Die angezeigte Zeit je Blitz wird auf die nächste 5-Minuten-Marke gerundet.

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

  // Exakte Uhrzeit als deutscher String
  const toGermanTime = (unixSec) =>
    new Date(unixSec * 1000).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }) + " Uhr";

  // Zeit auf nächste 5-Minuten-Marke runden (12:33 → 12:35, 12:31 → 12:30)
  const toRounded5min = (unixSec) => {
    const ms      = unixSec * 1000;
    const step    = 5 * 60 * 1000;
    const rounded = Math.round(ms / step) * step;
    return new Date(rounded).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    }) + " Uhr";
  };

  const nowSec    = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - 10 * 60; // letzte 10 Minuten

  try {
    const upstream = await fetch("https://ukwx.duckdns.org/lightning/europe", {
      headers: { "User-Agent": "lightning-recent-api" },
      signal: AbortSignal.timeout(10000),
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status} vom upstream`);

    const data      = await upstream.json();
    const allPoints = data.points ?? [];

    const filtered = allPoints
      .filter(p => inGermany(p) && p.t >= cutoffSec)
      .map(p => ({
        zeit:      toRounded5min(p.t),   // gerundet auf 5-Minuten-Marke
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
