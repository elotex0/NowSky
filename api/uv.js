// api/uv.js
// Abruf: /api/uv?lat=48.5&lon=8.4

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

  // Werte aus GitHub Environment Variables
  const API_URL = process.env.OPENUV_API_URL;
  const API_TOKEN = process.env.OPENUV_ACCESS_TOKEN;

  if (!API_URL || !API_TOKEN) {
    return res.status(500).json({
      error: "OPENUV_API_URL oder OPENUV_ACCESS_TOKEN fehlt",
    });
  }

  const fmtDE = (isoStr) =>
    new Date(isoStr).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }) + " Uhr";

  try {
    // URL zusammenbauen
    const url =
      `${API_URL}?lat=${encodeURIComponent(latNum)}` +
      `&lng=${encodeURIComponent(lonNum)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-access-token": API_TOKEN,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} von OpenUV`);
    }

    const data = await response.json();

    return res.status(200).json({
      standort: {
        lat: latNum,
        lon: lonNum,
      },

      uv: {
        wert: data.result?.uv ?? null,
        max: data.result?.uv_max ?? null,
        zeit_max: data.result?.uv_max_time
          ? fmtDE(data.result.uv_max_time)
          : null,
      },
      
      aktualisiert: data.result?.uv_time
        ? fmtDE(data.result.uv_time)
        : null,
    });

  } catch (err) {
    return res.status(502).json({
      error: err.message,
    });
  }
}
