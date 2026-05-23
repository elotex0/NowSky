// api/uv.js
// Abruf: /api/uv?lat={lat}&lon={lon}
// NowSky CRX 2026

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({
      error: "lat und lon sind erforderlich",
    });
  }

  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  const API_URL = process.env.UV_API_URL;

  if (!API_URL) {
    return res.status(500).json({
      error: "UV_API_URL fehlt",
    });
  }

  try {
    const url =
      `${API_URL}?latitude=${encodeURIComponent(latNum)}` +
      `&longitude=${encodeURIComponent(lonNum)}&timezone=Auto`;

    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} von UV API`);
    }

    const data = await response.json();

    return res.status(200).json({
      standort: {
        lat: latNum,
        lon: lonNum,
      },

      uv: {
        jetzt: data.now?.uvi ?? null,
        zeit: data.now?.time ?? null,
      },
    });

  } catch (err) {
    return res.status(502).json({
      error: err.message,
    });
  }
}
