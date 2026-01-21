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
// BrightSky Version MIT FIX: letzter Block + ETA/Alarm
// -----------------------------------------------------------

let rainForecastData = {};

async function getRainForecast(lat, lon) {
    rainForecastData = {
        results: [],        // mm/h pro 5 Minuten
        times: [],          // Zeitobjekte der 5-Minuten-Schritte
        startRain: null,
        endRain: null,
        durationMinutes: 0,
        perMinute: [],      // per minute mm/h
        perMinuteTimes: [],
        rainInMinutes: null,        // ETA bis Regen
        rainDurationMinutes: null   // Dauer des Regenblocks
    };

    const url = `https://api.brightsky.dev/radar?lat=${lat}&lon=${lon}&distance=1&format=plain`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("BrightSky Radar fetch failed");
    const data = await res.json();

    if (!data.radar || data.radar.length === 0) {
        throw new Error("Keine Radardaten gefunden");
    }

    const now = new Date();
    let lastPast = null;

    // --- 1️⃣ Ergebnisse vorbereiten, letzter Block vor jetzt noch einfügen ---
    for (let item of data.radar) {
        const timestamp = new Date(item.timestamp);

        if (timestamp <= now) {
            lastPast = item; // letzten Block merken
        } else {
            // letzten vergangene Block einmal einfügen
            if (lastPast) {
                const valPast = lastPast.precipitation_5?.[0]?.[0] || 0;
                const mmhPast = (valPast / 100) * 12;
                rainForecastData.results.push(mmhPast);
                rainForecastData.times.push(new Date(lastPast.timestamp));
                lastPast = null; // nur einmal einfügen
            }

            const val = item.precipitation_5?.[0]?.[0] || 0;
            const mmh = (val / 100) * 12;
            rainForecastData.results.push(mmh);
            rainForecastData.times.push(timestamp);
        }
    }

    // Falls alle Blöcke in der Vergangenheit, letzten trotzdem einfügen
    if (rainForecastData.results.length === 0 && lastPast) {
        const valPast = lastPast.precipitation_5?.[0]?.[0] || 0;
        const mmhPast = (valPast / 100) * 12;
        rainForecastData.results.push(mmhPast);
        rainForecastData.times.push(new Date(lastPast.timestamp));
    }

    if (rainForecastData.results.length === 0) return rainForecastData;

    // --- 2️⃣ Per-minute Interpolation ---
    const firstTimestamp = rainForecastData.times[0];
    const offsetMinutes = 0; // starten direkt ab dem ersten Block

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

    // --- 3️⃣ Start & Ende des Regens + ETA/Alarm ---
    const filtered = rainForecastData.perMinuteTimes
        .map((t, i) => ({ t, v: rainForecastData.perMinute[i] }));

    const nowMinutes = new Date();

    const startIdx = filtered.findIndex(x => x.v > 0);

    if (startIdx === -1) {
        // kein Regen
        rainForecastData.startRain = null;
        rainForecastData.endRain = null;
        rainForecastData.durationMinutes = 0;
        rainForecastData.rainInMinutes = null;
        rainForecastData.rainDurationMinutes = null;
    } else {
        const start = filtered[startIdx];
        let end = start;

        for (let i = startIdx + 1; i < filtered.length; i++) {
            if (filtered[i].v > 0) end = filtered[i];
            else break;
        }

        rainForecastData.startRain = start.t;
        rainForecastData.endRain = end.t;
        rainForecastData.durationMinutes = Math.round((end.t - start.t) / 60000);

        // ETA: Minuten bis Regen von jetzt
        rainForecastData.rainInMinutes = Math.max(0, Math.round((start.t - nowMinutes) / 60000));

        // Dauer des Regenblocks
        rainForecastData.rainDurationMinutes = rainForecastData.durationMinutes;
    }

    return rainForecastData;
}