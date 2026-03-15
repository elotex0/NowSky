// api/thunderstorm.js
import { OMFileR2 } from "./om_reader_r2.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "public, max-age=0, no-store");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Max-Age", "86400");
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
    const { data: allResults, generatedShort, generatedLong } =
      await om.getAllForPoint(lat, lon, interpolate);

    // UTC → Berlin Zeit
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    const pad = (n) => String(n).padStart(2, "0");
    const currentHourStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:00:00`;

    // 24h Grenze
    const in24h    = new Date(now.getTime() + 24 * 3600000);
    const in24hStr = `${in24h.getFullYear()}-${pad(in24h.getMonth() + 1)}-${pad(in24h.getDate())} ${pad(in24h.getHours())}:00:00`;

    // Timestamps -1h verschieben
    const shifted = {};
    for (const [ts, val] of Object.entries(allResults)) {
      const d = new Date(ts.replace(" ", "T"));
      d.setHours(d.getHours() - 1);
      const newTs = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00:00`;
      shifted[newTs] = val;
    }

    // Nächste 24h
    const hourly = Object.fromEntries(
      Object.entries(shifted).filter(([ts]) => ts >= currentHourStr && ts <= in24hStr)
    );

    // Tages-Maxima ab heute
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const dailyMax = {};
    for (const [ts, val] of Object.entries(shifted)) {
      const day = ts.substring(0, 10);
      if (day < todayStr) continue;
      if (dailyMax[day] === undefined || val > dailyMax[day]) dailyMax[day] = val;
    }

    return res.json({
      W_GEW_01: { hourly, daily: dailyMax },
      meta: {
        lat,
        lon,
        timestepsHourly: Object.keys(hourly).length,
        timestepsDaily:  Object.keys(dailyMax).length,
        interpolated:    interpolate,
        from:            currentHourStr,
        to:              in24hStr,
        updatedAt:       new Date(generatedShort) > new Date(generatedLong) ? generatedShort : generatedLong,
        source:          LONG_RUNS.has(currentRun) ? "long" : "short", 
        currentRun:      currentRun,                                      
      },
    });
  } catch (err) {
    console.error("thunderstorm error:", err);
    return res.status(500).json({ error: err.message });
  }
}
