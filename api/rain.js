// /api/rain.js

import pako from "pako";

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

// -----------------------------------------------------------
// Bright Sky Version
// -----------------------------------------------------------

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

    // --------- 1 km Bounding Box berechnen ----------
    const deltaLat = 0.009; // ca. 1 km in Grad
    const deltaLon = 0.014 / Math.cos(lat * Math.PI / 180); // 1 km korrigiert nach Breitengrad
    const bbox = {
        minLat: lat - deltaLat / 2,
        maxLat: lat + deltaLat / 2,
        minLon: lng - deltaLon / 2,
        maxLon: lng + deltaLon / 2
    };

    // --------- 2. Holen der Bright Sky Radar-Daten ----------
    const radarRes = await fetch("https://api.brightsky.dev/radar");
    const radarJson = await radarRes.json();

    // aktueller Zeitrahmen (5-Minuten-Radar)
    const radarFrame = radarJson.radar[0];

    // Base64 → Uint8Array → dekomprimieren
    const compressed = Uint8Array.from(atob(radarFrame.precipitation_5), c => c.charCodeAt(0));
    const raster = pako.inflate(compressed); // Rohdaten, 900x1100 Pixel

    const width = 1100;
    const height = 900;

    // Lat/Lon → Pixel
    function latLonToPixel(lat, lon) {
        // RADOLAN-Referenz
        const radolanOriginX = -523462.5;
        const radolanOriginY = 4658576.5;
        const pixelSize = 1000; // 1 km

        const R = 6370040;

        const φ = lat * Math.PI / 180;
        const λ = lon * Math.PI / 180;
        const φ0 = 60 * Math.PI / 180;
        const λ0 = 10 * Math.PI / 180;

        const t = Math.tan(Math.PI / 4 - φ / 2);
        const t0 = Math.tan(Math.PI / 4 - φ0 / 2);

        const x = R * (λ - λ0);
        const y = R * Math.log(t0 / t);

        const px = Math.floor((x - radolanOriginX) / pixelSize);
        const py = Math.floor((radolanOriginY - y) / pixelSize);
        return { px, py };
    }

    // Pixel für Bounding Box-Mitte
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const midLon = (bbox.minLon + bbox.maxLon) / 2;
    const { px, py } = latLonToPixel(midLat, midLon);

    // Extrahiere Regenwert an Pixel
    const index = py * width + px;
    const rawValue = raster[index] || 0; // Rohwert 0-255
    const mmh = rawValue * 0.1; // Skaliert auf mm/h (approx.)

    // --------- 3. Ergebnisse speichern ----------
    const now = new Date();
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0);

    rainForecastData.results.push(mmh);
    rainForecastData.times.push(now);

    // -----------------------------------------------------------
    // 4. Per-Minute-Interpolation (wie vorher)
    // -----------------------------------------------------------
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
            minuteTimes.push(new Date(startTime.getTime() + pos * 60000));
            pos += 1;
        }

        return { values: minuteValues, times: minuteTimes };
    }

    if (rainForecastData.results.length >= 1) {
        const interp = buildPerMinuteForecast(rainForecastData.results, offsetMinutes, now);
        rainForecastData.perMinute = interp.values;
        rainForecastData.perMinuteTimes = interp.times;
    }

    // -----------------------------------------------------------
    // 5. Start & Ende des Regens bestimmen
    // -----------------------------------------------------------
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