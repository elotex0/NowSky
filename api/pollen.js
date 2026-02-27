export default async function handler(req, res) {
  // =====================
  // CORS
  // =====================
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon sind erforderlich" });
  }

  try {
    // =====================
    // 1️⃣ Bundesland via Nominatim
    // =====================
    const nominatimUrl =
      `https://nominatim.openstreetmap.org/reverse?` +
      new URLSearchParams({
        format: "json",
        lat,
        lon,
        zoom: 5,
        addressdetails: 1
      });

    const geoRes = await fetch(nominatimUrl, {
      headers: { "User-Agent": "pollen-api" }
    });
    const geoData = await geoRes.json();

    const state = geoData?.address?.state;
    if (!state) {
      return res.status(404).json({ error: "Bundesland nicht gefunden" });
    }

    // =====================
    // 2️⃣ Mapping Bundesland → region_id
    // =====================
    const stateToRegion = {
      "Schleswig-Holstein": 10,
      "Hamburg": 10,
      "Mecklenburg-Vorpommern": 20,
      "Niedersachsen": 30,
      "Bremen": 30,
      "Nordrhein-Westfalen": 40,
      "Brandenburg": 50,
      "Berlin": 50,
      "Sachsen-Anhalt": 60,
      "Thüringen": 70,
      "Sachsen": 80,
      "Hessen": 90,
      "Rheinland-Pfalz": 100,
      "Saarland": 100,
      "Baden-Württemberg": 110,
      "Bayern": 120
    };

    const regionId = stateToRegion[state];
    if (!regionId) {
      return res.status(404).json({ error: "Keine passende DWD-Region gefunden" });
    }

    // =====================
    // 3️⃣ DWD OpenData laden
    // =====================
    const dwdRes = await fetch(
      "https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json"
    );
    const dwdData = await dwdRes.json();

    const regionData = dwdData.content.find(
      r => r.region_id === regionId
    );

    if (!regionData) {
      return res.status(404).json({ error: "Region nicht im DWD-Datensatz" });
    }

    // =====================
    // 4️⃣ Response bauen
    // =====================
    res.status(200).json({
      location: {
        lat,
        lon,
        state
      },
      region: {
        id: regionData.region_id,
        name: regionData.region_name
      },
      last_update: dwdData.last_update,
      pollen: regionData.Pollen
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
