export default async function handler(req, res) {
  // CORS Header
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { lat, lon } = req.query;
  const max_dist = 20000; // always fixed

  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon sind erforderlich" });
  }

  const url = `https://api.brightsky.dev/current_weather?lat=${lat}&lon=${lon}&max_dist=${max_dist}`;

  try {
    const response = await fetch(url);
    const json = await response.json();

    const weather = json.weather;
    const sources = json.sources;

    // Hauptstation ermitteln
    const station = sources.find(s => s.id === weather.source_id);

    if (!station) {
      return res.status(404).json({ error: "Keine Station gefunden" });
    }

    // gewünschte Werte extrahieren
    const result = {
      id: station.id,
      dwd_station_id: station.dwd_station_id,
      station_name: station.station_name,
      observation_type: station.observation_type,
      lat: station.lat,
      lon: station.lon,
      height: station.height,
      wmo_station_id: station.wmo_station_id,
      distance: station.distance,
      first_record: station.first_record,
      last_record: station.last_record,
      data: {
        timestamp: weather.timestamp,
        temperature: weather.temperature,                   // °C
        wind_gust_speed_10: weather.wind_gust_speed_10,     // km/h
        precipitation_60: weather.precipitation_60,         // mm/h
        visibility: weather.visibility,                     // m
        relative_humidity: weather.relative_humidity        // %
      }
    };

    return res.status(200).json(result);

  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: "Fehler beim Abrufen der Daten" });
  }
}
