// /api/rain.js

export default async function handler(req, res) {
    // CORS-Header setzen
    res.setHeader('Access-Control-Allow-Origin', '*'); // erlaubt alle Domains
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Preflight Request abfangen
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { lat, lng } = req.query;

    if (!lat || !lng) {
        res.status(400).json({ error: 'lat and lng are required' });
        return;
    }

    try {
        const forecast = await getRainForecast(parseFloat(lat), parseFloat(lng));
        res.status(200).json(forecast);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch rain forecast' });
    }
}

// --- Funktion bleibt unverändert ---
let rainForecastData = {};

async function getRainForecast(lat, lng) {
    if (!lat || !lng) return null;

    rainForecastData = {
        results: [],
        times: [],
        startRain: null,
        endRain: null,
        duration: 0,
        perMinute: [],
        perMinuteTimes: []
    };

    const delta = 0.005; // ca. 500 m
    const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;

    const now = new Date();
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0);

    const requests = [];

    for (let i = 0; i < 13; i++) {
        const frameTime = new Date(now.getTime() + i * 5 * 60 * 1000);
        const isoTime = frameTime.toISOString();

        const url = new URL("https://maps.dwd.de/geoserver/dwd/wms");
        url.searchParams.set("SERVICE", "WMS");
        url.searchParams.set("VERSION", "1.1.1");
        url.searchParams.set("REQUEST", "GetFeatureInfo");
        url.searchParams.set("LAYERS", "dwd:Niederschlagsradar");
        url.searchParams.set("QUERY_LAYERS", "dwd:Niederschlagsradar");
        url.searchParams.set("STYLES", "");
        url.searchParams.set("BBOX", bbox);
        url.searchParams.set("FEATURE_COUNT", "1");
        url.searchParams.set("HEIGHT", "10");
        url.searchParams.set("WIDTH", "10");
        url.searchParams.set("INFO_FORMAT", "application/json");
        url.searchParams.set("SRS", "EPSG:4326");
        url.searchParams.set("X", "5");
        url.searchParams.set("Y", "5");
        url.searchParams.set("TIME", isoTime);

        requests.push({ url: url.toString(), frameTime, index: i });
    }

    const responses = await Promise.all(
        requests.map(async (request) => {
            const res = await fetch(request.url);
            const data = await res.json();
            let val = 0;
            if (data.features && data.features.length > 0) {
                val = parseFloat(data.features[0].properties.RV_ANALYSIS) || 0;
                val = val * 12;
            }
            return { val, frameTime: request.frameTime, index: request.index };
        })
    );

    responses
        .sort((a, b) => a.index - b.index)
        .forEach(result => {
            rainForecastData.results.push(result.val);
            rainForecastData.times.push(result.frameTime);
        });

    // Lineare Interpolation pro Minute
    const realNow = new Date();
    const offsetSeconds = (realNow.getMinutes() % 5) * 60 + realNow.getSeconds();
    const offsetMinutes = offsetSeconds / 60;

    function buildPerMinuteForecast(results, startOffsetMinutes, startTime) {
        const minuteValues = [];
        const minuteTimes = [];
        let pos = startOffsetMinutes;

        for (let m = 0; m <= 60; m++) {
            const segIndex = Math.floor(pos / 5);
            let value = 0;

            if (segIndex >= results.length - 1) {
                value = results[results.length - 1] || 0;
            } else {
                const left = results[segIndex] || 0;
                const right = results[segIndex + 1] || 0;
                const frac = (pos - segIndex * 5) / 5;
                value = left + (right - left) * frac;
            }

            minuteValues.push(value);
            minuteTimes.push(new Date(startTime.getTime() + pos * 60 * 1000));
            pos += 1;
        }

        return { values: minuteValues, times: minuteTimes };
    }

    if (rainForecastData.results.length >= 2) {
        const interp = buildPerMinuteForecast(rainForecastData.results, offsetMinutes, now);
        rainForecastData.perMinute = interp.values;
        rainForecastData.perMinuteTimes = interp.times;
    }

    // Start/Ende des Regens
    if (rainForecastData.perMinute.length > 0) {
        const startIdx = rainForecastData.perMinute.findIndex((v) => v > 0);
        if (startIdx !== -1) {
            let endIdx = startIdx;
            for (let i = startIdx; i < rainForecastData.perMinute.length; i++) {
                if (rainForecastData.perMinute[i] > 0) {
                    endIdx = i;
                } else {
                    break;
                }
            }
            rainForecastData.startRain = rainForecastData.perMinuteTimes[startIdx];
            rainForecastData.endRain = rainForecastData.perMinuteTimes[endIdx];
            rainForecastData.duration = (endIdx - startIdx + 1);
        }
    }

    return rainForecastData;
}
