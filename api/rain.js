// /api/rain.js
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 🔥 TLS ignorieren

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { lat, lon } = req.query;
    if (!lat || !lon) {
        res.status(400).json({ error: 'Bitte Lat und Lon eingeben!' });
        return;
    }

    try {
        const forecast = await getRainForecast(parseFloat(lat), parseFloat(lon));
        res.status(200).json(forecast);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch rain forecast' });
    }
}

// -----------------------------------------------------------
// EIN REQUEST Version mit Maps + BrightSky Fallback
// -----------------------------------------------------------

let rainForecastData = {};

async function getRainForecast(lat, lon) {
    // 1️⃣ Versuche Maps zuerst
    try {
        return await getFromMaps(lat, lon);
    } catch (err) {
        console.warn("Maps fehlgeschlagen, BrightSky als Fallback:", err.message);
        return await getFromBrightSky(lat, lon);
    }
}

// ======================================================================
// Maps DWD WMS
// ======================================================================

async function getFromMaps(lat, lon) {
    rainForecastData = {
        results: [],
        times: [],
        startRain: null,
        endRain: null,
        duration: 0,
        perMinute: [],
        perMinuteTimes: []
    };

    const delta = 0.001;
    const bbox = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;
    const now = new Date();
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0);

    const timeList = [];
    const timeObjects = [];
    for (let i = 0; i < 13; i++) {
        const t = new Date(now.getTime() + i * 5 * 60 * 1000);
        timeList.push(t.toISOString());
        timeObjects.push(t);
    }

    const urls = [
        { url: "https://maps.dwd.de/geoserver/dwd/wms", layer: "dwd:Niederschlagsradar", queryLayer: "dwd:Niederschlagsradar" }
    ];

    let data = null;
    for (let entry of urls) {
        try {
            const url = new URL(entry.url);
            url.searchParams.set("SERVICE", "WMS");
            url.searchParams.set("VERSION", "1.1.1");
            url.searchParams.set("REQUEST", "GetFeatureInfo");
            url.searchParams.set("LAYERS", entry.layer);
            url.searchParams.set("QUERY_LAYERS", entry.queryLayer);
            url.searchParams.set("BBOX", bbox);
            url.searchParams.set("FEATURE_COUNT", "1");
            url.searchParams.set("HEIGHT", "1");
            url.searchParams.set("WIDTH", "1");
            url.searchParams.set("INFO_FORMAT", "application/json");
            url.searchParams.set("SRS", "EPSG:4326");
            url.searchParams.set("X", "0");
            url.searchParams.set("Y", "0");
            url.searchParams.set("TIME", timeList.join(","));

            const res = await fetch(url.toString());
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            data = await res.json();
            break;
        } catch (err) {
            console.warn(`Fetch Maps fehlgeschlagen: ${err.message}`);
        }
    }

    if (!data || !data.features) throw new Error("Maps DWD Daten nicht verfügbar");

    data.features.forEach((f, i) => {
        const raw = parseFloat(f.properties.RV_ANALYSIS) || 0;
        const mmh = Math.max(0, raw * 12);
        rainForecastData.results.push(mmh);
        rainForecastData.times.push(timeObjects[i]);
    });

    buildPerMinuteForecast(rainForecastData, now);

    return rainForecastData;
}

// ======================================================================
// BrightSky Fallback
// ======================================================================

async function getFromBrightSky(lat, lon) {
    rainForecastData = {
        results: [],
        times: [],
        startRain: null,
        endRain: null,
        duration: 0,
        perMinute: [],
        perMinuteTimes: []
    };

    const url = `https://api.brightsky.dev/radar?lat=${lat}&lon=${lon}&distance=1&format=plain&tz=Europe/Berlin`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("BrightSky fetch failed");

    const data = await res.json();
    if (!data.radar || data.radar.length === 0) throw new Error("BrightSky keine Radardaten");

    const now = new Date();
    const timeList = [];
    const results = [];

    // Mappe BrightSky Daten in gleiche Struktur wie Maps
    for (let i = 0; i < Math.min(13, data.radar.length); i++) {
        const item = data.radar[i];
        const timestamp = new Date(item.timestamp);
        timeList.push(timestamp);
        const val = item.precipitation_5?.[0]?.[0] || 0;
        results.push(Math.max(0, val / 100 * 12));
    }

    rainForecastData.results = results;
    rainForecastData.times = timeList;

    buildPerMinuteForecast(rainForecastData, now);

    return rainForecastData;
}

// ======================================================================
// Per-Minute Interpolation (für Maps + BrightSky identisch)
// ======================================================================

function buildPerMinuteForecast(rain, startTime) {
    const realNow = new Date();
    const offsetSeconds = (realNow.getMinutes() % 5) * 60 + realNow.getSeconds();
    const offsetMinutes = offsetSeconds / 60;

    const results = rain.results;
    const times = rain.times;
    const minuteValues = [];
    const minuteTimes = [];

    for (let m = 0; m <= 60; m++) {
        const pos = offsetMinutes + m;
        const segIndex = Math.floor(pos / 5);
        let value = 0;

        if (segIndex >= results.length - 1) value = results[results.length - 1];
        else {
            const left = results[segIndex];
            const right = results[segIndex + 1];
            value = Math.max(0, left + (right - left) * ((pos - segIndex * 5) / 5));
        }

        minuteValues.push(value);
        minuteTimes.push(new Date(times[0].getTime() + pos * 60000));
    }

    rain.perMinute = minuteValues;
    rain.perMinuteTimes = minuteTimes;

    // Regenblock
    const startIdx = minuteValues.findIndex(v => v > 0);
    if (startIdx !== -1) {
        let endIdx = startIdx;
        for (let i = startIdx + 1; i < minuteValues.length; i++) {
            if (minuteValues[i] > 0) endIdx = i; else break;
        }
        rain.startRain = minuteTimes[startIdx];
        rain.endRain = minuteTimes[endIdx];
        rain.duration = endIdx - startIdx + 1;
    }
}
