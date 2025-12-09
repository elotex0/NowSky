// api/alerts.js

export default async function handler(req, res) {
  const { lat, lon } = req.query;

  let url = "https://api.weather.gov/alerts";
  if (lat && lon) {
    url = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "vercel-serverless-weather-api",
        "Accept": "application/geo+json",
      },
    });

    if (!response.ok) {
      return res.status(500).json({
        error: "Weather API Error",
        status: response.status,
      });
    }

    const data = await response.json();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(data);
  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({
      error: "Request failed",
      detail: err.toString(),
    });
  }
}