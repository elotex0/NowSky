export default async function handler(req, res) {
  // CORS Header
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

    // Helfer: lineare Interpolation
    function lerp(v0, v1, t) {
      return v0 + (v1 - v0) * t;
    }

    // Stündliche Daten vorbereiten
    const raw = weatherArray.map(w => ({
      timestamp: new Date(w.timestamp),
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

    // 5-Minuten Interpolation
    const interpolated = [];

    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i];
      const b = raw[i + 1];

      // Original-Stundenpunkt
      interpolated.push({
        ...a,
        timestamp: a.timestamp.toISOString()
      });

      for (let m = 5; m < 60; m += 5) {
        const t = m / 60;
        const time = new Date(a.timestamp.getTime() + m * 60000);

        interpolated.push({
          timestamp: time.toISOString(),
          temperature: lerp(a.temperature, b.temperature, t),
          wind_speed: lerp(a.wind_speed, b.wind_speed, t),
          wind_gust_speed: lerp(a.wind_gust_speed, b.wind_gust_speed, t),
          precipitation: lerp(a.precipitation, b.precipitation, t),
          relative_humidity: lerp(a.relative_humidity, b.relative_humidity, t),
          visibility: lerp(a.visibility, b.visibility, t),
          pressure_msl: lerp(a.pressure_msl, b.pressure_msl, t),
          condition: a.condition,  // kategorisch → nicht interpolieren
          icon: a.icon
        });
      }
    }

    // letzten Punkt übernehmen
    const last = raw[raw.length - 1];
    interpolated.push({
      ...last,
      timestamp: last.timestamp.toISOString()
    });

    // Response ausgeben
    return res.status(200).json({
      station,
      data: interpolated
    });

  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: "Fehler beim Abrufen der Daten" });
  }
}