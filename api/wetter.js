// /api/wetter.js

export default async function handler(req, res) {
  // CORS Header
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // OPTIONS Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { lat, lon, max_dist = 20000 } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon sind erforderlich" });
  }

  const url = `https://api.brightsky.dev/current_weather?lat=${lat}&lon=${lon}&max_dist=${max_dist}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    return res.status(200).json({
      source: "BrightSky via own API",
      params: { lat, lon, max_dist },
      data
    });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Fehler beim Abrufen der Daten" });
  }
}
