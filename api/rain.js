```js
// /api/rain.js

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { lat, lon } = req.query;

    if (!lat || !lon) {
        return res.status(400).json({
            error: 'Bitte lat und lon angeben'
        });
    }

    try {
        const forecast = await getRainForecast(
            parseFloat(lat),
            parseFloat(lon)
        );

        return res.status(200).json(forecast);
    } catch (err) {
        console.error(err);

        return res.status(500).json({
            error: 'Failed to fetch rain forecast'
        });
    }
}

async function getRainForecast(lat, lon) {
    const rainForecastData = {
        results: [],
        times: [],
        startRain: null,
        endRain: null,
        duration: 0,
        perMinute: [],
        perMinuteTimes: []
    };

    const url =
        `https://api.brightsky.dev/radar?lat=${lat}` +
        `&lon=${lon}` +
        `&distance=1` +
        `&format=plain` +
        `&tz=Europe/Berlin`;

    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`BrightSky HTTP ${res.status}`);
    }

    const data = await res.json();

    if (!data.radar || data.radar.length === 0) {
        return rainForecastData;
    }

    const now = new Date();
    let lastPast = null;

    for (const item of data.radar) {
        const timestamp = new Date(item.timestamp);

        if (timestamp <= now) {
            lastPast = item;
            continue;
        }

        if (lastPast) {
            const valPast =
                lastPast.precipitation_5?.[0]?.[0] || 0;

            rainForecastData.results.push(
                (valPast / 100) * 12
            );

            rainForecastData.times.push(
                new Date(lastPast.timestamp)
            );

            lastPast = null;
        }

        const val =
            item.precipitation_5?.[0]?.[0] || 0;

        rainForecastData.results.push(
            (val / 100) * 12
        );

        rainForecastData.times.push(timestamp);
    }

    if (
        rainForecastData.results.length === 0 &&
        lastPast
    ) {
        const valPast =
            lastPast.precipitation_5?.[0]?.[0] || 0;

        rainForecastData.results.push(
            (valPast / 100) * 12
        );

        rainForecastData.times.push(
            new Date(lastPast.timestamp)
        );
    }

    if (
        rainForecastData.results.length > 0 &&
        rainForecastData.times.length > 0
    ) {
        buildPerMinuteForecast(rainForecastData);
    }

    return rainForecastData;
}

function buildPerMinuteForecast(rain) {
    const realNow = new Date();

    const offsetSeconds =
        (realNow.getMinutes() % 5) * 60 +
        realNow.getSeconds();

    const offsetMinutes = offsetSeconds / 60;

    const minuteValues = [];
    const minuteTimes = [];

    for (let m = 0; m <= 60; m++) {
        const pos = offsetMinutes + m;
        const segIndex = Math.floor(pos / 5);

        let value = 0;

        if (segIndex >= rain.results.length - 1) {
            value =
                rain.results[rain.results.length - 1] || 0;
        } else {
            const left = rain.results[segIndex];
            const right = rain.results[segIndex + 1];

            value =
                left +
                (right - left) *
                    ((pos - segIndex * 5) / 5);
        }

        minuteValues.push(
            Math.max(0, Number(value))
        );

        minuteTimes.push(
            new Date(
                rain.times[0].getTime() +
                pos * 60 * 1000
            )
        );
    }

    rain.perMinute = minuteValues;
    rain.perMinuteTimes = minuteTimes;

    const startIdx = minuteValues.findIndex(
        v => v > 0
    );

    if (startIdx !== -1) {
        let endIdx = startIdx;

        for (
            let i = startIdx + 1;
            i < minuteValues.length;
            i++
        ) {
            if (minuteValues[i] > 0) {
                endIdx = i;
            } else {
                break;
            }
        }

        rain.startRain = minuteTimes[startIdx];
        rain.endRain = minuteTimes[endIdx];
        rain.duration = endIdx - startIdx + 1;
    }
}
```
