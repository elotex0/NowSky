import fetch from "node-fetch";
import tar from "tar-stream";
import { Buffer } from "buffer";
import { Access, File } from "hdf5.node";
import proj4 from "proj4";

// -------------------------
// PROJEKTIONEN
// -------------------------
const RADOLAN_PROJ = "+proj=stere +lat_0=90 +lon_0=10 +lat_ts=60 +a=6370000 +b=6370000 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

// -------------------------
// NEXT.js API HANDLER
// -------------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat & lng required" });

  try {
    const forecast = await buildForecast(parseFloat(lat), parseFloat(lng));
    res.status(200).json(forecast);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Forecast failed", details: err.message });
  }
}

// -------------------------
// FORECAST aus tar erstellen
// -------------------------
async function buildForecast(lat, lng) {
  const tarUrl = "https://opendata.dwd.de/weather/radar/composite/rv/composite_rv_LATEST.tar";

  const response = await fetch(tarUrl);
  if (!response.ok) throw new Error("Failed to fetch tar");

  const buffer = Buffer.from(await response.arrayBuffer());
  const extract = tar.extract();
  const values5min = [];
  const steps = [];

  // proj4 Koordinaten einmal berechnen
  const [xCoord, yCoord] = proj4(WGS84, RADOLAN_PROJ, [lng, lat]);

  extract.on("entry", async (header, stream, next) => {
    if (!header.name.endsWith("-hd5")) {
      stream.resume();
      return next();
    }

    // nur erste 3 Vorhersagen: 0, 5, 10
    const step = parseInt(header.name.split("_").pop().split("-")[0]);
    if (![0, 5, 10].includes(step)) {
      stream.resume();
      return next();
    }

    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      const fileBuffer = Buffer.concat(chunks);

      // HDF5-Datei öffnen
      const file = new File(fileBuffer, Access.ACC_RDONLY);
      const dataset = file.openDataset("/dataset"); // Pfad anpassen falls nötig
      const arr = dataset.read();
      const nx = dataset.dims[1], ny = dataset.dims[0];

      // Pixel berechnen
      const px = Math.floor((xCoord - dataset.attrs.originX) / dataset.attrs.resX);
      const py = Math.floor((yCoord - dataset.attrs.originY) / dataset.attrs.resY);

      let val = 0;
      if (px >= 0 && py >= 0 && px < nx && py < ny) {
        val = arr[py * nx + px];
      }

      values5min[step / 5] = val;
      steps[step / 5] = step;

      dataset.close();
      file.close();

      next();
    });
  });

  await new Promise((resolve, reject) => {
    extract.on("finish", resolve);
    extract.on("error", reject);
    extract.end(buffer);
  });

  // --- 1-Minuten Interpolation ---
  const perMinute = [];
  const perMinuteTimes = [];
  const now = new Date();
  for (let idx = 0; idx < values5min.length - 1; idx++) {
    const a = values5min[idx], b = values5min[idx + 1];
    const t0 = new Date(now.getTime() + idx * 5 * 60 * 1000);
    for (let m = 0; m < 5; m++) {
      perMinute.push(a + (b - a) * (m / 5));
      perMinuteTimes.push(new Date(t0.getTime() + m * 60000));
    }
  }
  perMinute.push(values5min[values5min.length - 1]);
  perMinuteTimes.push(new Date(now.getTime() + (values5min.length - 1) * 5 * 60 * 1000));

  return {
    lat,
    lng,
    per5min: values5min,
    per5minTimes: steps.map((s) => new Date(now.getTime() + s * 60000)),
    perMinute,
    perMinuteTimes,
  };
}
