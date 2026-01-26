// /api/rain.js
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

// ======================================================================
// MAIN
// ======================================================================

async function getRainForecast(lat, lon) {
    try {
        return await getFromDwdWms(lat, lon);
    } catch (e) {
        console.warn("DWD WMS failed → BrightSky fallback");
        return await getFromBrightSky(lat, lon);
    }
}

// ======================================================================
// 1️⃣ DWD WMS API
// ======================================================================

async function getFromDwdWms(lat, lon) {
    let rainForecastData = {
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

    const url = new URL("https://maps.dwd.de/geoserver/dwd/wms");
    url.searchParams.set("SERVICE", "WMS");
    url.searchParams.set("VERSION", "1.1.1");
    url.searchParams.set("REQUEST", "GetFeatureInfo");
    url.searchParams.set("LAYERS", "dwd:Niederschlagsradar");
    url.searchParams.set("QUERY_LAYERS", "dwd:Niederschlagsradar");
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
    if (!res.ok) throw new Error(`DWD HTTP ${res.status}`);

    const data = await res.json();
    if (!data || !data.features) throw new Error("DWD JSON leer");

    data.features.forEach((f, i) => {
        const raw = parseFloat(f.properties.RV_ANALYSIS) || 0;
        const mmh = Math.max(0, raw * 12);
        rainForecastData.results.push(mmh);
        rainForecastData.times.push(timeObjects[i]);
    });

    buildMinuteForecast(rainForecastData);

    return rainForecastData;
}

// ======================================================================
// 2️⃣ BrightSky Fallback
// ======================================================================

async function getFromBrightSky(lat, lon) {
    let rainForecastData = {
        results: [],
        times: [],
        perMinute: [],
        perMinuteTimes: [],
        startRain: null,
        endRain: null,
        duration: 0
    };

    const url = `https://api.brightsky.dev/radar?lat=${lat}&lon=${lon}&distance=1&format=plain`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("BrightSky Radar fetch failed");

    const data = await res.json();
    if (!data.radar || data.radar.length === 0) throw new Error("BrightSky keine Radardaten");

    const now = new Date();
    let lastPast = null;

    for (let item of data.radar) {
        const timestamp = new Date(item.timestamp);

        if (timestamp <= now) {
            lastPast = item;
        } else {
            if (lastPast) {
                const valPast = lastPast.precipitation_5?.[0]?.[0] || 0;
                const mmhPast = (valPast / 100) * 12;
                rainForecastData.results.push(mmhPast);
                rainForecastData.times.push(new Date(lastPast.timestamp));
                lastPast = null;
            }

            const val = item.precipitation_5?.[0]?.[0] || 0;
            const mmh = (val / 100) * 12;
            rainForecastData.results.push(mmh);
            rainForecastData.times.push(timestamp);
        }
    }

    // Falls alles Vergangenheit war
    if (rainForecastData.results.length === 0 && lastPast) {
        const valPast = lastPast.precipitation_5?.[0]?.[0] || 0;
        const mmhPast = (valPast / 100) * 12;
        rainForecastData.results.push(mmhPast);
        rainForecastData.times.push(new Date(lastPast.timestamp));
    }

    // Wenn nichts → zurückgeben
    if (rainForecastData.results.length === 0) return rainForecastData;

    // per minute Interpolation wie DWD
    const startTime = rainForecastData.times[0];
    const results = rainForecastData.results;
    const minuteValues = [];
    const minuteTimes = [];

    for (let m = 0; m <= 60; m++) {
        const pos = m;
        const segIndex = Math.floor(pos / 5);
        let value = 0;

        if (segIndex >= results.length - 1) {
            value = results[results.length - 1];
        } else {
            const left = results[segIndex];
            const right = results[segIndex + 1];
            const frac = (pos - segIndex * 5) / 5;
            value = left + (right - left) * frac;
        }

        minuteValues.push(value);
        minuteTimes.push(new Date(startTime.getTime() + pos * 60000));
    }

    rainForecastData.perMinute = minuteValues;
    rainForecastData.perMinuteTimes = minuteTimes;

    // Regenblock ermitteln -> wie DWD
    const startIdx = minuteValues.findIndex(v => v > 0);

    if (startIdx !== -1) {
        let endIdx = startIdx;
        for (let i = startIdx + 1; i < minuteValues.length; i++) {
            if (minuteValues[i] > 0) endIdx = i;
            else break;
        }

        rainForecastData.startRain = minuteTimes[startIdx];
        rainForecastData.endRain = minuteTimes[endIdx];
        rainForecastData.duration = endIdx - startIdx + 1;
    }

    return rainForecastData;
}


// ======================================================================
// Minute Interpolation für DWD
// ======================================================================

function buildMinuteForecast(rain) {
    const realNow = new Date();
    const offsetSeconds = (realNow.getMinutes() % 5) * 60 + realNow.getSeconds();
    const offsetMinutes = offsetSeconds / 60;

    const results = rain.results;
    const startTime = rain.times[0];

    const minuteValues = [];
    const minuteTimes = [];

    for (let m = 0; m <= 60; m++) {
        const pos = offsetMinutes + m;
        const segIndex = Math.floor(pos / 5);
        let value = 0;

        if (segIndex >= results.length - 1) {
            value = results[results.length - 1] || 0;
        } else {
            const left = results[segIndex] || 0;
            const right = results[segIndex + 1] || 0;
            const frac = (pos - segIndex * 5) / 5;
            value = Math.max(0, left + (right - left) * frac);
        }

        minuteValues.push(value);
        minuteTimes.push(new Date(startTime.getTime() + pos * 60000));
    }

    rain.perMinute = minuteValues;
    rain.perMinuteTimes = minuteTimes;
}

// ======================================================================
// Minute Interpolation + ETA für BrightSky
// ======================================================================

function buildMinuteForecastBrightSky(rain) {
    if (rain.results.length < 1) return;

    const startTime = rain.times[0];
    const results = rain.results;

    const minuteValues = [];
    const minuteTimes = [];

    for (let m = 0; m <= 60; m++) {
        const pos = m;
        const segIndex = Math.floor(pos / 5);

        let value = 0;
        if (segIndex >= results.length - 1) {
            value = results[results.length - 1];
        } else {
            const left = results[segIndex];
            const right = results[segIndex + 1];
            const frac = (pos - segIndex * 5) / 5;
            value = left + (right - left) * frac;
        }

        minuteValues.push(value);
        minuteTimes.push(new Date(startTime.getTime() + pos * 60000));
    }

    rain.perMinute = minuteValues;
    rain.perMinuteTimes = minuteTimes;

    const now = new Date();
    const filtered = minuteTimes.map((t, i) => ({ t, v: minuteValues[i] }));
    const startIdx = filtered.findIndex(x => x.v > 0);

    if (startIdx !== -1) {
        let endIdx = startIdx;
        for (let i = startIdx; i < filtered.length; i++) {
            if (filtered[i].v > 0) endIdx = i; else break;
        }

        rain.startRain = filtered[startIdx].t;
        rain.endRain = filtered[endIdx].t;
        rain.rainDurationMinutes = endIdx - startIdx + 1;
        rain.rainInMinutes = Math.max(0, Math.round((filtered[startIdx].t - now) / 60000));
    }
}
