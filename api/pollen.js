export default async function handler(req, res) {
  // =====================
  // CORS
  // =====================
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // =====================
  // Query Params
  // =====================
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon sind erforderlich" });
  }

  // =====================
  // Helpers
  // =====================
  function parseDwdDate(str) {
    if (!str) return null;
    if (str.includes("T")) return str.replace("Z", "");
    const [date, time] = str.split(", ");
    if (!date || !time) return null;
    const [d, m, y] = date.split(".");
    return `${y}-${m}-${d}T${time}`;
  }

  function parseForecastDate(str) {
    if (!str) return null;
    if (str.includes("T")) return str.substring(0, 10);
    const [date] = str.split(", ");
    const [d, m, y] = date.split(".");
    return `${y}-${m}-${d}`;
  }

  // =====================
  // BBOX um Punkt (~1km)
  // =====================
  const delta = 0.01;
  const minx = parseFloat(lon) - delta;
  const miny = parseFloat(lat) - delta;
  const maxx = parseFloat(lon) + delta;
  const maxy = parseFloat(lat) + delta;

  const width = 101;
  const height = 101;
  const i = 50;
  const j = 50;

  // =====================
  // TIME: alle drei Tage automatisch
  // =====================
  const today = new Date();
  const times = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    times.push(d.toISOString().split("T")[0] + "T00:00:00.000Z");
  }
  const timeParam = times.join(",");

  // =====================
  // WMS URL
  // =====================
  const url =
    "https://maps.dwd.de/geoserver/wms?" +
    new URLSearchParams({
      SERVICE: "WMS",
      VERSION: "1.3.0",
      REQUEST: "GetFeatureInfo",
      LAYERS: "dwd:Pollenflug",
      QUERY_LAYERS: "dwd:Pollenflug",
      CRS: "EPSG:4326",
      BBOX: `${miny},${minx},${maxy},${maxx}`,
      WIDTH: width,
      HEIGHT: height,
      I: i,
      J: j,
      INFO_FORMAT: "application/json",
      FEATURE_COUNT: 100,
      TIME: timeParam
    });

  // =====================
  // Fetch + Verarbeitung
  // =====================
  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!data.features || data.features.length === 0) {
      return res.status(200).json({ lat, lon, days: [] });
    }

    // =====================
    // Nach Tagen gruppieren
    // =====================
    const grouped = {};
    data.features.forEach(f => {
      const date = parseForecastDate(f.properties.FORECAST_DATE);
      if (!date) return;

      if (!grouped[date]) {
        grouped[date] = {
          date,
          updated: parseDwdDate(f.properties.SYSTEM_DATE),
          pollen: []
        };
      }

      grouped[date].pollen.push({
        name: f.properties.PARAMETER_NAME ?? null,
        value:
          f.properties.PARAMETER_VALUE !== undefined &&
          f.properties.PARAMETER_VALUE !== null
            ? f.properties.PARAMETER_VALUE
            : ""
      });
    });

    // =====================
    // Sortieren + Response
    // =====================
    const days = Object.values(grouped).sort(
      (a, b) => a.date.localeCompare(b.date)
    );

    res.status(200).json({ lat, lon, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
