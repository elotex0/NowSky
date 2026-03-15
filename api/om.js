import { OMFileR2 } from "./om_reader_r2.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: "lat and lon required" });
  }

  try {
    const om = new OMFileR2();
    const result = await om.getAllForPoint(lat, lon);

    return res.json({
      W_GEW_01: result,
      meta: {
        lat,
        lon,
        timesteps: Object.keys(result).length,
      },
    });
  } catch (err) {
    console.error("thunderstorm error:", err);
    return res.status(500).json({ error: err.message });
  }
}
