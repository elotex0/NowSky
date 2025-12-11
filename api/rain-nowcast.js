import GeoTIFF from "geotiff";
import proj4 from "proj4";
import zlib from "zlib";
import fetch from "node-fetch";

// -------------------------
// FLOAT16 → JS Number
// -------------------------
function fromHalfBits(h) {
  const s = (h & 0x8000) >> 15;
  let e = (h & 0x7C00) >> 10;
  let f = h & 0x03FF;

  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1F) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

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
    const result = await buildNowcast(parseFloat(lat), parseFloat(lng));
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Nowcast failed", details: err.message });
  }
}

// -------------------------
// ALLE 5-MINUTEN FILES VERARBEITEN
// -------------------------
async function getRadvorPixel(urlPattern, lat, lng, steps = [0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100,105,110,115,120]) {
  for (let step of steps) {
    const stepStr = step.toString().padStart(3,'0');
    const url = urlPattern.replace("XXX", stepStr);

    try {
      const response = await fetch(url);
      if (!response.ok) continue;

      const buffer = Buffer.from(await response.arrayBuffer());
      const decompressed = zlib.gunzipSync(buffer);

      const tiff = await GeoTIFF.fromArrayBuffer(decompressed.buffer);
      const img = await tiff.getImage();

      const width = img.getWidth();
      const height = img.getHeight();
      const tie = img.getTiePoints()[0];
      const scale = img.getFileDirectory().ModelPixelScale;

      const originX = tie.x;
      const originY = tie.y;
      const resX = scale[0];
      const resY = -scale[1];

      const [x, y] = proj4(WGS84, RADOLAN_PROJ, [lng, lat]);
      const px = Math.floor((x - originX) / resX);
      const py = Math.floor((y - originY) / resY);

      if (px < 0 || py < 0 || px >= width || py >= height) continue;

      const raster = await img.readRasters({ window: [px, py, px + 1, py + 1] });
      let raw = raster[0][0];

      if (img.getSampleFormat()[0] === 3 && img.getBitsPerSample()[0] === 16) {
        raw = fromHalfBits(raw);
      }

      return raw; // erstes gültiges Step verwenden
    } catch(e) {
      continue;
    }
  }
  return 0; // wenn kein Step existiert
}

// -------------------------
// NOWCAST ERSTELLEN
// -------------------------
async function buildNowcast(lat, lng) {
  const now = new Date();
  const mmh = [];
  const steps = [];

  // --- 1) Analyse der letzten 60 Minuten (RW: mm/5min) ---
  const rwTimes = [];
  for (let i = -12; i <= 0; i++) {
    const t = new Date(now.getTime() + i * 5 * 60 * 1000);
    steps.push(t);
    rwTimes.push(formatRadvorTime(t));
  }

  // Parallel Fetch RW
  const rwPromises = rwTimes.map(ft => {
    const urlPattern = `https://opendata.dwd.de/weather/radar/radvor/re/RE${ft}_XXX.gz`;
    return getRadvorPixel(urlPattern, lat, lng);
  });

  const rwValues = await Promise.all(rwPromises);
  rwValues.forEach(val => mmh.push(val * 12)); // mm/5min → mm/h

  // --- 2) Prognose +120 min (RQ) nur 060 & 120 ---
  const rqTimes = [];
  for (let i = 1; i <= 24; i++) {
    const t = new Date(now.getTime() + i * 5 * 60 * 1000);
    steps.push(t);
    rqTimes.push({ date: t, step: i <= 12 ? "060" : "120" });
  }

  // Lade nur 060 & 120 einmal pro Block
  const rqBlocks = {};
  for (const { date, step } of rqTimes) {
    const ft = formatRadvorTime(date);
    if (!rqBlocks[step]) rqBlocks[step] = `https://opendata.dwd.de/weather/radar/radvor/rq/RQ${ft}_${step}.gz`;
  }

  const rqValuesCache = {};
  await Promise.all(Object.entries(rqBlocks).map(async ([step, url]) => {
    rqValuesCache[step] = await getRadvorPixel(url, lat, lng);
  }));

  // Interpolation für die 5-min Schritte
  for (let i = 1; i <= 24; i++) {
    const step = i <= 12 ? "060" : "120";
    const val = rqValuesCache[step] ?? 0;

    // linear zwischen 060 & 120
    let interpolated = val;
    if (i % 12 !== 0) {
      const prev = mmh[mmh.length - 1];
      const next = val;
      interpolated = prev + (next - prev) * ((i % 12) / 12);
    }

    mmh.push(dbzToRain(interpolated));
  }

  // --- 3) Per-Minute Interpolation ---
  const perMinute = [];
  const perMinuteTimes = [];
  for (let idx = 0; idx < mmh.length - 1; idx++) {
    const a = mmh[idx], b = mmh[idx + 1];
    for (let m = 0; m < 5; m++) {
      perMinute.push(a + (b - a) * (m / 5));
      perMinuteTimes.push(new Date(steps[idx].getTime() + m*60000));
    }
  }

  // --- 4) Regen Start/Ende ---
  let startRain = null, endRain = null;
  const rainIdx = perMinute.findIndex(v => v > 0.1);
  if (rainIdx !== -1) {
    startRain = perMinuteTimes[rainIdx];
    let endIdx = rainIdx;
    while(endIdx < perMinute.length && perMinute[endIdx] > 0.1) endIdx++;
    endRain = perMinuteTimes[endIdx - 1];
  }

  return { lat, lng, analysisForecastSteps: steps.length, per5min: mmh, per5minTimes: steps,
           perMinute, perMinuteTimes, startRain, endRain,
           durationMinutes: startRain ? Math.round((endRain-startRain)/60000) : 0 };
}

// -------------------------
// Hilfsfunktionen
// -------------------------
function formatRadvorTime(date) {
  const pad = (n) => (n < 10 ? "0"+n : n);
  return date.getUTCFullYear().toString().slice(2)+
         pad(date.getUTCMonth()+1)+
         pad(date.getUTCDate())+
         pad(date.getUTCHours())+
         pad(date.getUTCMinutes());
}

function dbzToRain(dbz) {
  if(dbz <= 0) return 0;
  const z = Math.pow(10, dbz / 10);
  return Math.pow(z/200, 1/1.6);
}
