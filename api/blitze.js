// api/lightning.js
// Abruf: /api/lightning?lat=48.5&lon=8.4&radius=100
// radius ist optional, Standard: 50 km

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { lat, lon, radius } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon sind erforderlich" });
  }

  const latNum    = parseFloat(lat);
  const lonNum    = parseFloat(lon);
  const radiusKm  = parseFloat(radius ?? 50);

  // Zeit auf Deutsch formatieren
  const fmtDE = (isoStr) =>
    new Date(isoStr).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    }) + " Uhr";

  // Haversine-Distanz in km
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

  try {
    const [europeRes, germanyRes] = await Promise.all([
      fetch("http://ukwx.duckdns.org/lightning/europe"),
      fetch("http://ukwx.duckdns.org/lightning/germany"),
    ]);

    if (!europeRes.ok || !germanyRes.ok) {
      return res.status(502).json({ error: "Upstream nicht erreichbar" });
    }

    const [europeData, germanyData] = await Promise.all([
      europeRes.json(),
      germanyRes.json(),
    ]);

    const europePoints  = europeData.points  ?? [];
    const germanyPoints = germanyData.points ?? [];

    // Punkt-Radius: aus Europa-Daten filtern
    const punktCount = europePoints.filter(
      (p) => haversine(latNum, lonNum, p.lat, p.lon) <= radiusKm
    ).length;

    return res.status(200).json({
      period: {
        von: fmtDE(europeData.period_start),
        bis: fmtDE(europeData.period_end),
      },
      punkt: {
        lat: latNum,
        lon: lonNum,
        radius_km: radiusKm,
        blitze: punktCount,
      },
      deutschland: {
        blitze: germanyPoints.length,
      },
      europa: {
        blitze: europePoints.length,
      },
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
