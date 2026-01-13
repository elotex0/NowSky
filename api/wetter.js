export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { lat, lon } = req.query;
  const date = new Date().toISOString().split('T')[0];

  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon sind erforderlich" });
  }

  const url = `https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${date}`;

  try {
    const response = await fetch(url);
    const json = await response.json();

    const weatherArray = json.weather;
    const sources = json.sources;

    if (!weatherArray || weatherArray.length === 0) {
      return res.status(404).json({ error: "Keine Wetterdaten gefunden" });
    }

    // Hauptstation ermitteln (über den ersten Eintrag)
    const mainSourceId = weatherArray[0].source_id;
    const station = sources.find(s => s.id === mainSourceId);

    // Daten pro Timestamp aufbereiten
    const data = weatherArray.map(w => ({
      timestamp: w.timestamp,
      temperature: w.temperature,
      wind_speed: w.wind_speed,
      wind_gust_speed: w.wind_gust_speed,
      precipitation: w.precipitation,
      relative_humidity: w.relative_humidity,
      visibility: w.visibility,
      pressure_msl: w.pressure_msl,
      condition: w.condition,
      icon: w.icon
    }));

    return res.status(200).json({
      station,
      data
    });

  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: "Fehler beim Abrufen der Daten" });
  }
}