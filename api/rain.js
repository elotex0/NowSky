// /api/rain.js

// Globale Variable, um letzten bekannten Wert pro Location zu speichern
// Wenn du mehrere Locations hast, am besten als Map: lastKnownRate[lat+","+lng]
async function getMetNowcastRain(lat, lng) {
    const url = `https://api.met.no/weatherapi/nowcast/2.0/complete?lat=${lat}&lon=${lng}`;

    const res = await fetch(url, {
        headers: {
            "User-Agent": "wetter-crx/1.0 kettnerjustin8@gmail.com"
        }
    });

    if (!res.ok) throw new Error("MET Nowcast request failed");

    const data = await res.json();
    const timeseries = data.properties?.timeseries || [];

    const rainForecastData = {
        results: [],
        times: [],
        startRain: null,
        endRain: null,
        duration: 0,
        perMinute: [],
        perMinuteTimes: []
    };

    // MET liefert nur aktuelle 5-Minuten-Punkte
    const times = [];
    const results = [];

    timeseries.forEach(ts => {
        const rate = ts.data?.instant?.details?.precipitation_rate ?? 0;
        results.push(rate);
        times.push(new Date(ts.time));
    });

    // ---------------------------------------------------------
    // 1️⃣ 5-Minuten-Lücken füllen / interpolieren
    // ---------------------------------------------------------
    function fillAndInterpolateMET(times, values) {
        const filledTimes = [];
        const filledValues = [];

        for (let i = 0; i < times.length - 1; i++) {
            const t1 = times[i];
            const t2 = times[i + 1];
            const v1 = values[i];
            const v2 = values[i + 1];

            // push original
            filledTimes.push(t1);
            filledValues.push(v1);

            // Zwischenzeiten im 5-Minuten-Raster
            let t = new Date(t1.getTime() + 5 * 60000);
            while (t < t2) {
                const frac = (t - t1) / (t2 - t1);
                const val = v1 + frac * (v2 - v1);
                filledTimes.push(new Date(t));
                filledValues.push(val);
                t = new Date(t.getTime() + 5 * 60000);
            }
        }

        // letzter Punkt
        filledTimes.push(times[times.length - 1]);
        filledValues.push(values[values.length - 1]);

        return { filledTimes, filledValues };
    }

    const { filledTimes, filledValues } = fillAndInterpolateMET(times, results);

    rainForecastData.times = filledTimes;
    rainForecastData.results = filledValues;

    // ---------------------------------------------------------
    // 2️⃣ 1-Minuten Interpolation (wie bisher)
    // ---------------------------------------------------------
    const realNow = new Date();
    const baseTime = filledTimes[0];
    const offsetMinutes = (realNow - baseTime) / 60000;

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

    const interp = buildPerMinuteForecast(filledValues, offsetMinutes, baseTime);
    rainForecastData.perMinute = interp.values;
    rainForecastData.perMinuteTimes = interp.times;

    // ---------------------------------------------------------
    // 3️⃣ Start / Ende Regen
    // ---------------------------------------------------------
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
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);

    const isGermany =
    latNum >= 47 && latNum <= 55 &&
    lngNum >= 5 && lngNum <= 16;

    const isNorway =
    latNum >= 57 && latNum <= 72 &&
    lngNum >= 4 && lngNum <= 32;


    let dwdForecast = null;
    let metForecast = null;
    
    // 🇩🇪 Deutschland → DWD
    if (isGermany) {
        dwdForecast = await getRainForecast(latNum, lngNum);
    }
    
    // 🇳🇴 Norwegen → MET
    if (isNorway) {
        metForecast = await getMetNowcastRain(latNum, lngNum);
    }


    const response = {};

    if (isGermany) {
        response.dwd = dwdForecast;
    }
    
    if (isNorway) {
        response.met = metForecast;
    }
    
    res.status(200).json(response);


} catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch rain forecast' });
    }
}

// -----------------------------------------------------------
// EIN REQUEST Version
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

    // Kleinere Box = schneller
    const delta = 0.001; // ~100–200m
    const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;

    const now = new Date();
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0);

    // --------- 1. Alle Zeitpunkte sammeln ----------
    const timeList = [];
    const timeObjects = [];

    for (let i = 0; i < 13; i++) {
        const t = new Date(now.getTime() + i * 5 * 60 * 1000);
        timeList.push(t.toISOString());
        timeObjects.push(t);
    }

    // --------- 2. EIN Request an den DWD ----------
    const url = new URL("https://maps.dwd.de/geoserver/dwd/wms");
    url.searchParams.set("SERVICE", "WMS");
    url.searchParams.set("VERSION", "1.1.1");
    url.searchParams.set("REQUEST", "GetFeatureInfo");
    url.searchParams.set("LAYERS", "dwd:Niederschlagsradar");
    url.searchParams.set("QUERY_LAYERS", "dwd:Niederschlagsradar");
    url.searchParams.set("STYLES", "");
    url.searchParams.set("BBOX", bbox);
    url.searchParams.set("FEATURE_COUNT", "1");
    url.searchParams.set("HEIGHT", "1");
    url.searchParams.set("WIDTH", "1");
    url.searchParams.set("INFO_FORMAT", "application/json");
    url.searchParams.set("SRS", "EPSG:4326");
    url.searchParams.set("X", "0");
    url.searchParams.set("Y", "0");

    // WICHTIG: mehrere Zeiten, durch Komma getrennt = 1 Request
    url.searchParams.set("TIME", timeList.join(","));

    const res = await fetch(url.toString());
    const data = await res.json();

    // --------- 3. Werte extrahieren ----------
    // Die Antwort enthält features[] pro Zeitscheibe
    // Reihenfolge = Reihenfolge der TIME-Liste

    (data.features || []).forEach((f, i) => {
        const raw = parseFloat(f.properties.RV_ANALYSIS) || 0;
        const mmh = raw * 12;

        rainForecastData.results.push(mmh);
        rainForecastData.times.push(timeObjects[i]);
    });

    // -----------------------------------------------------------
    // 4. PER-MINUTE INTERPOLATION (unverändert zu deinem Code)
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

    if (rainForecastData.results.length >= 2) {
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
