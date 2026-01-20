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

// Optional: DWD JSON pro warm Function speichern
let dwdCache = null;
let cachedDay = null;

async function getDWDJson() {
  const todayStr = new Date().toISOString().slice(0,10).replace(/-/g,"");
  if (dwdCache && cachedDay === todayStr) return dwdCache;

  const url = `https://opendata.dwd.de/climate_environment/health/forecasts/heat/hwtrend_${todayStr}.json`;
  const res = await fetch(url);
  const data = await res.json();
  dwdCache = data;
  cachedDay = todayStr;
  return data;
}

export default async function handler(req, res) {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat & lon required" });

  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  try {
    // Reverse-Geocoding Nominatim
    const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latNum}&lon=${lonNum}&addressdetails=1&zoom=10`;
    const geoRes = await fetch(nomUrl, { headers: { "User-Agent": "Vercel-Hitzetrend-App/1.0" } });
    const geoData = await geoRes.json();
    const county = geoData.address.county;
    const state = geoData.address.state || "";
    if (!county) return res.status(404).json({ error: "Kein Kreis gefunden" });

    // DWD JSON abrufen (optional warm cache)
    const dwdData = await getDWDJson();

    // Kreis suchen
    let trendArr = null;
    let codeFound = null;
    for (const code in dwdData) {
      if (dwdData[code].Name.includes(county)) {
        trendArr = dwdData[code].Trend;
        codeFound = code;
        break;
      }
    }
    if (!trendArr) return res.status(404).json({ error: "Kein Heat Trend für den Kreis gefunden", county });

    // Trend + Datum map
    const today = new Date();
    const trends = trendArr.map((value, idx) => {
      const d = new Date(today);
      d.setDate(d.getDate() + idx);
      return {
        date: d.toISOString().slice(0,10),
        trend: value,
        description: trendDescriptions[value] || "unbekannter Trendwert"
      };
    });

    res.status(200).json({
      code: codeFound,
      county,
      state,
      trends
    });

  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
