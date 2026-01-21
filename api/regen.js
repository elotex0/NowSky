// /api/rain.js

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
// EIN REQUEST BrightSky Version
// -----------------------------------------------------------

let rainForecastData = {};

async function getRainForecast(lat, lon) {
    rainForecastData = {
        results: [],        // mm/h pro 5 Minuten
        times: [],          // Zeitobjekte der 5-Minuten-Steps
        startRain: null,
        endRain: null,
        duration: 0,
        perMinute: [],      // per minute mm/h
        perMinuteTimes: []
    };

    // BrightSky liefert alle Radar timestamps automatisch
    const url = `https://api.brightsky.dev/radar?lat=${lat}&lon=${lon}&distance=1&format=plain`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("BrightSky Radar fetch failed");
    const data = await res.json();

    if (!data.radar || data.radar.length === 0) {
        throw new Error("Keine Radardaten gefunden");
    }

    // BrightSky Werte:
    // precipitation_5 = HUNDERTSTEL-mm / 5 Minuten
    // → Umrechnung: value(plain) / 100 mm in 5 Minuten
    // → mm/h = (value / 100) * 12

    const timeObjects = [];

    for (let item of data.radar) {
        const val = item.precipitation_5?.[0]?.[0] || 0; // 1x1 raster
        const mmh = (val / 100) * 12; // mm/h

        rainForecastData.results.push(mmh);
        rainForecastData.times.push(new Date(item.timestamp));
        timeObjects.push(new Date(item.timestamp));
    }


    // -------- Per-minute Interpolation ----------
    const realNow = new Date();
    const firstTimestamp = timeObjects[0];

    // Abstand zwischen realNow und dem ersten 5-min Block in Minuten
    const diffMs = realNow - firstTimestamp;
    const offsetMinutes = diffMs / 60000;

    function buildPerMinuteForecast(results, startOffsetMinutes, startTime) {
        const minuteValues = [];
        const minuteTimes = [];

        for (let m = 0; m <= 60; m++) {
            const pos = startOffsetMinutes + m;
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
            minuteTimes.push(new Date(startTime.getTime() + pos * 60000));
        }

        return { values: minuteValues, times: minuteTimes };
    }

    if (rainForecastData.results.length >= 2) {
        const interp = buildPerMinuteForecast(rainForecastData.results, offsetMinutes, firstTimestamp);
        rainForecastData.perMinute = interp.values;
        rainForecastData.perMinuteTimes = interp.times;
    }

    // -------- Start & Ende des Regens ----------
    if (rainForecastData.perMinute.length > 0) {
        const startIdx = rainForecastData.perMinute.findIndex(v => v > 0);

        if (startIdx !== -1) {
            let endIdx = startIdx;
            for (let i = startIdx; i < rainForecastData.perMinute.length; i++) {
                if (rainForecastData.perMinute[i] > 0) endIdx = i;
                else break;
            }

            rainForecastData.startRain = rainForecastData.perMinuteTimes[startIdx];
            rainForecastData.endRain = rainForecastData.perMinuteTimes[endIdx];
            rainForecastData.duration = endIdx - startIdx + 1;
        }
    }

    return rainForecastData;
}