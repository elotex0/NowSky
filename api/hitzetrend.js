import fetch from "node-fetch";

// Trend-Beschreibungen nach DWD
const trendDescriptions = {
  0: "keine Warnung bzw. kein Hitzetrend",
  1: "Warnung vor starker Wärmebelastung",
  2: "Warnung vor extremer Wärmebelastung",
  3: "Hitzetrendvorhersage aktiv; Warnung möglich (wird nicht mehr verwendet)",
  4: "Hitzetrendvorhersage aktiv; Warnung Stufe 1 gering wahrscheinlich",
  5: "Hitzetrendvorhersage aktiv; Warnung Stufe 1 wahrscheinlich",
  6: "Hitzetrendvorhersage aktiv; Warnung Stufe 2 gering wahrscheinlich",
  7: "Hitzetrendvorhersage aktiv; Warnung Stufe 2 wahrscheinlich"
};

export default async function handler(req, res) {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat & lon required" });

  try {
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);

    // ----------------------------
    // 1️⃣ Reverse-Geocoding für COUNTY
    // ----------------------------
    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latNum}&lon=${lonNum}&addressdetails=1&zoom=10`;
    const geoRes = await fetch(nominatimUrl, {
      headers: { "User-Agent": "Vercel-Hitzetrend-App/1.0" }
    });
    if (!geoRes.ok) throw new Error("Nominatim konnte den Ort nicht finden");
    const geoData = await geoRes.json();
    const county = geoData.address.county;
    const state = geoData.address.state;
    if (!county) return res.status(404).json({ error: "Kein Kreis (county) gefunden" });

    // ----------------------------
    // 2️⃣ DWD JSON abrufen
    // ----------------------------
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g,""); // YYYYMMDD
    const dwdUrl = `https://opendata.dwd.de/climate_environment/health/forecasts/heat/hwtrend_${dateStr}.json`;
    const dwdRes = await fetch(dwdUrl);
    if (!dwdRes.ok) throw new Error("DWD JSON konnte nicht geladen werden");
    const dwdData = await dwdRes.json();

    // ----------------------------
    // 3️⃣ Kreis im DWD JSON finden
    // ----------------------------
    let trendArray = null;
    let codeFound = null;
    for (const code in dwdData) {
      const info = dwdData[code];
      if (info.Name.includes(county)) {
        trendArray = info.Trend;
        codeFound = code;
        break;
      }
    }

    if (!trendArray) return res.status(404).json({ error: "Kein Heat Trend für den Kreis gefunden", county });

    // ----------------------------
    // 4️⃣ Trend-Array in Zeitreihe umwandeln
    // ----------------------------
    const trendWithDates = trendArray.map((value, idx) => {
      const date = new Date(today);
      date.setDate(date.getDate() + idx);
      const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
      return {
        date: dateStr,
        trend: value,
        description: trendDescriptions[value] || "unbekannter Trendwert"
      };
    });

    // ----------------------------
    // 5️⃣ Ergebnis zurückgeben
    // ----------------------------
    res.status(200).json({
      code: codeFound,
      county,
      state,
      trends: trendWithDates
    });

  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
