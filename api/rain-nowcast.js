import GeoTIFF from "geotiff";
import proj4 from "proj4";
import zlib from "zlib";

// --------------------------------------------------------------
// FLOAT16 -> FLOAT32
// --------------------------------------------------------------
function fromHalfBits(h) {
    const s = (h & 0x8000) >> 15;
    let e = (h & 0x7C00) >> 10;
    let f = h & 0x03FF;

    if (e === 0) {
        return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    } else if (e === 0x1F) {
        return f ? NaN : ((s ? -1 : 1) * Infinity);
    }

    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

// --------------------------------------------------------------
// Projektionen
// --------------------------------------------------------------
const RADOLAN_PROJ = "+proj=stere +lat_0=90 +lon_0=10 +lat_ts=60 +a=6370000 +b=6370000 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

// --------------------------------------------------------------
// API Handler
// --------------------------------------------------------------
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
        res.status(500).json({ error: "Nowcast failed" });
    }
}

// --------------------------------------------------------------
// GZ entpacken und GeoTIFF laden
// --------------------------------------------------------------
async function fetchGzGeoTiff(url) {
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const decompressed = zlib.gunzipSync(buffer);
    return await GeoTIFF.fromArrayBuffer(decompressed.buffer);
}

// --------------------------------------------------------------
// Pixel aus RADVOR GeoTIFF auslesen
// --------------------------------------------------------------
async function getRadvorPixel(url, lat, lng) {
    const tiff = await fetchGzGeoTiff(url);
    const img = await tiff.getImage();

    const width = img.getWidth();
    const height = img.getHeight();
    const tie = img.getTiePoints()[0];
    const scale = img.getFileDirectory().ModelPixelScale;

    const originX = tie.x;
    const originY = tie.y;
    const resX = scale[0];
    const resY = -scale[1];

    // WGS84 -> RADOLAN Projektion
    const [x, y] = proj4(WGS84, RADOLAN_PROJ, [lng, lat]);

    const px = Math.floor((x - originX) / resX);
    const py = Math.floor((y - originY) / resY);

    if (px < 0 || py < 0 || px >= width || py >= height) return null;

    const raster = await img.readRasters({ window: [px, py, px + 1, py + 1] });
    let raw = raster[0][0];

    // float16 -> echte Zahl
    if (img.getSampleFormat()[0] === 3 && img.getBitsPerSample()[0] === 16) {
        raw = fromHalfBits(raw);
    }

    return raw;
}

// --------------------------------------------------------------
// Nowcast erstellen
// --------------------------------------------------------------
async function buildNowcast(lat, lng) {
    const now = new Date();
    const steps = [];
    const mmh = [];

    // --- 1) Analyse der letzten 60 Minuten (RW: mm/5min) ---
    for (let i = -12; i <= 0; i++) {
        const t = new Date(now.getTime() + i * 5 * 60 * 1000);
        const fileTime = formatRadvorTime(t);
        const url = `https://opendata.dwd.de/weather/radar/radvor/radvor_rw_10000-${fileTime}_000.gz`;

        let val = await getRadvorPixel(url, lat, lng);
        if (val == null) val = 0;

        mmh.push(val * 12); // mm/5min -> mm/h
        steps.push(t);
    }

    // --- 2) RADVOR Prognose +120 min (RQ: dBZ) ---
    for (let i = 1; i <= 24; i++) {
        const t = new Date(now.getTime() + i * 5 * 60 * 1000);
        const fileTime = formatRadvorTime(t);
        const url = `https://opendata.dwd.de/weather/radar/radvor/radvor_rq_10000-${fileTime}_000.gz`;

        let val = await getRadvorPixel(url, lat, lng);
        if (val == null) val = 0;

        const mmhVal = dbzToRain(val);
        mmh.push(mmhVal);
        steps.push(t);
    }

    // --- PRO-MINUTE INTERPOLATION (1-Min-Serie für 3h) ---
    const perMinute = [];
    const perMinuteTimes = [];

    for (let idx = 0; idx < mmh.length - 1; idx++) {
        const a = mmh[idx];
        const b = mmh[idx + 1];
        for (let m = 0; m < 5; m++) {
            const frac = m / 5;
            perMinute.push(a + (b - a) * frac);
            perMinuteTimes.push(new Date(steps[idx].getTime() + m * 60000));
        }
    }

    // --- Start / Ende des Regens bestimmen ---
    let startRain = null;
    let endRain = null;

    const rainIdx = perMinute.findIndex(v => v > 0.1);
    if (rainIdx !== -1) {
        startRain = perMinuteTimes[rainIdx];
        let endIdx = rainIdx;
        while (endIdx < perMinute.length && perMinute[endIdx] > 0.1) endIdx++;
        endRain = perMinuteTimes[endIdx - 1];
    }

    return {
        lat,
        lng,
        analysisForecastSteps: steps.length,
        per5min: mmh,
        per5minTimes: steps,
        perMinute,
        perMinuteTimes,
        startRain,
        endRain,
        durationMinutes: startRain ? Math.round((endRain - startRain) / 60000) : 0
    };
}

// --------------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------------
function formatRadvorTime(date) {
    const pad = n => (n < 10 ? "0" + n : n);
    return (
        date.getUTCFullYear() +
        pad(date.getUTCMonth() + 1) +
        pad(date.getUTCDate()) +
        pad(date.getUTCHours()) +
        pad(date.getUTCMinutes())
    );
}

function dbzToRain(dbz) {
    if (dbz <= 0) return 0;
    const z = Math.pow(10, dbz / 10);
    return Math.pow(z / 200, 1 / 1.6);
}
