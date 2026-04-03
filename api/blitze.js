// api/lightning.js
// Abruf: /api/lightning?lat=48.5&lon=8.4&radius=100
// radius optional, Standard: 50 km

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { lat, lon, radius } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon sind erforderlich" });
  }

  const latNum   = parseFloat(lat);
  const lonNum   = parseFloat(lon);
  const radiusKm = parseFloat(radius ?? 50);

  const fmtDE = (isoStr) =>
    new Date(isoStr).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    }) + " Uhr";

  const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  // Bounding Box Deutschland
  const inGermany = (p) =>
    p.lat >= 47.2 && p.lat <= 55.1 &&
    p.lon >=  5.8 && p.lon <= 15.1;

  try {
    const r = await fetch("https://ukwx.duckdns.org/lightning/europe", {
      headers: { "User-Agent": "lightning-api" },
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) throw new Error(`HTTP ${r.status} von upstream`);

    const data = await r.json();
    const points = data.points ?? [];

    const punktCount     = points.filter(p => haversine(latNum, lonNum, p.lat, p.lon) <= radiusKm).length;
    const germanyCount   = points.filter(inGermany).length;
    const europeCount    = points.length;

    return res.status(200).json({
      period: {
        von: fmtDE(data.period_start),
        bis: fmtDE(data.period_end),
      },
      punkt: {
        lat: latNum,
        lon: lonNum,
        radius_km: radiusKm,
        blitze: punktCount,
      },
      deutschland: {
        blitze: germanyCount,
      },
      europa: {
        blitze: europeCount,
      },
    });

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
