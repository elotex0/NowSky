// /api/hitzetrend.js
import fetch from "node-fetch";

export default async function handler(req, res) {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat & lon required" });

  try {
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);

    // ----------------------------
    // 1️⃣ Reverse-Geocoding für COUNTY
    // ----------------------------
    // zoom=10 -> Kreis-Ebene
    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latNum}&lon=${lonNum}&addressdetails=1&zoom=10`;
    const geoRes = await fetch(nominatimUrl, {
      headers: { "User-Agent": "Vercel-Hitzetrend-App/1.0" }
    });

    if (!geoRes.ok) throw new Error("Nominatim konnte den Ort nicht finden");
    const geoData = await geoRes.json();

    const county = geoData.address.county;
    if (!county) return res.status(404).json({ error: "Kein Kreis (county) gefunden" });

    // ----------------------------
    // 2️⃣ DWD JSON abrufen
    // ----------------------------
    const today = new Date().toISOString().slice(0, 10).replace(/-/g,"");
    const dwdUrl = `https://opendata.dwd.de/climate_environment/health/forecasts/heat/hwtrend_${today}.json`;
    const dwdRes = await fetch(dwdUrl);
    if (!dwdRes.ok) throw new Error("DWD JSON konnte nicht geladen werden");
    const dwdData = await dwdRes.json();

    // ----------------------------
    // 3️⃣ Kreis im DWD JSON finden
    // ----------------------------
    let trend = null;
    let codeFound = null;

    for (const code in dwdData) {
      const info = dwdData[code];
      if (info.Name.includes(county)) {
        trend = info.Trend;
        codeFound = code;
        break;
      }
    }

    if (!trend) return res.status(404).json({ error: "Kein Heat Trend für den Kreis gefunden", county });

    // ----------------------------
    // 4️⃣ Ergebnis zurückgeben
    // ----------------------------
    res.status(200).json({
      code: codeFound,
      county,
      trend
    });

  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
