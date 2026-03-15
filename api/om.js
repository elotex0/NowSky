// api/thunderstorm.js
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
    const interpolate = req.query.interpolate !== "false";
    const allResults = await om.getAllForPoint(lat, lon, interpolate);

    // UTC → Berlin Zeit
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    const pad = (n) => String(n).padStart(2, "0");
    const currentHourStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:00:00`;

    // Nur Timestamps ab aktueller Stunde
    const result = Object.fromEntries(
      Object.entries(allResults).filter(([ts]) => ts >= currentHourStr)
    );

    return res.json({
      W_GEW_01: result,
      meta: {
        lat,
        lon,
        timesteps:    Object.keys(result).length,
        interpolated: interpolate,
        from:         currentHourStr,
      },
    });
  } catch (err) {
    console.error("thunderstorm error:", err);
    return res.status(500).json({ error: err.message });
  }
}
