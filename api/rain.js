async function getRainForecast(lat, lng) {
    if (!lat || !lng) return null;

    let rainForecastData = {
        results: [],
        times: [],
        startRain: null,
        endRain: null,
        duration: 0,
        perMinute: [],
        perMinuteTimes: []
    };

    const isNorway = (lat >= 57 && lat <= 72 && lng >= 4 && lng <= 31); // grobe Grenze für Norwegen

    if (isNorway) {
        // -------------------- MET.NO --------------------
        const url = `https://api.met.no/weatherapi/nowcast/2.0/complete?lat=${lat}&lon=${lng}`;
        const response = await fetch(url, {
            headers: { 'User-Agent': 'rain-forecast-demo' } // met.no verlangt User-Agent
        });
        const data = await response.json();

        const timeseries = data.properties.timeseries || [];

        timeseries.forEach(entry => {
            const rate = entry.data.instant.details.precipitation_rate || 0; // mm/h
            rainForecastData.results.push(rate);
            rainForecastData.times.push(new Date(entry.time));
        });
    } else {
        // -------------------- DWD --------------------
        const delta = 0.001;
        const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;
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
        url.searchParams.set("STYLES", "");
        url.searchParams.set("BBOX", bbox);
        url.searchParams.set("FEATURE_COUNT", "1");
        url.searchParams.set("HEIGHT", "1");
        url.searchParams.set("WIDTH", "1");
        url.searchParams.set("INFO_FORMAT", "application/json");
        url.searchParams.set("SRS", "EPSG:4326");
        url.searchParams.set("X", "0");
        url.searchParams.set("Y", "0");
        url.searchParams.set("TIME", timeList.join(","));

        const resDWD = await fetch(url.toString());
        const dataDWD = await resDWD.json();

        (dataDWD.features || []).forEach((f, i) => {
            const raw = parseFloat(f.properties.RV_ANALYSIS) || 0;
            const mmh = raw * 12;
            rainForecastData.results.push(mmh);
            rainForecastData.times.push(timeObjects[i]);
        });
    }

    // -------------------- PER-MINUTE INTERPOLATION --------------------
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
        const interp = buildPerMinuteForecast(rainForecastData.results, offsetMinutes, rainForecastData.times[0]);
        rainForecastData.perMinute = interp.values;
        rainForecastData.perMinuteTimes = interp.times;
    }

    // -------------------- Start & Ende des Regens --------------------
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
