// /api/temperature.js

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
        const forecast = await getTemperatureForecast(
            parseFloat(lat),
            parseFloat(lon)
        );

        return res.status(200).json(forecast);
    } catch (err) {
        console.error(err);

        return res.status(500).json({
            error: 'Failed to fetch temperature forecast'
        });
    }
}

const GRIBSTREAM_TOKEN = '8d33bd4516a307d649ef511b388acdf77920db94';

async function getTemperatureForecast(lat, lon) {
    const now = new Date();

    // IFS läuft 2x täglich: 00Z und 12Z
    // Wir fragen die nächsten 48h ab
    const fromTime = new Date(now);
    fromTime.setMinutes(0, 0, 0);

    const untilTime = new Date(fromTime);
    untilTime.setHours(untilTime.getHours() + 48);

    const body = {
        fromTime: fromTime.toISOString(),
        untilTime: untilTime.toISOString(),
        coordinates: [{ lat, lon, name: 'location' }],
        variables: [
            {
                name: '2t',
                level: 'sfc',
                info: '',
                alias: 'temp'
            }
        ]
    };

    const response = await fetch(
        'https://gribstream.com/api/v2/ifsoper/timeseries',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${GRIBSTREAM_TOKEN}`
            },
            body: JSON.stringify(body)
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            `GribStream HTTP ${response.status}: ${text}`
        );
    }

    const raw = await response.json();

    // Sortieren nach forecasted_time aufsteigend
    const sorted = [...raw].sort(
        (a, b) =>
            new Date(a.forecasted_time) -
            new Date(b.forecasted_time)
    );

    // Kelvin → Celsius umrechnen, Zeitreihe aufbauen
    const times = [];
    const temps = [];

    for (const entry of sorted) {
        const tempC = entry.temp - 273.15;

        times.push(new Date(entry.forecasted_time));
        temps.push(Math.round(tempC * 10) / 10);
    }

    // Aktuell (nächster Wert), Min und Max ermitteln
    const currentTemp = temps[0] ?? null;
    const minTemp = temps.length
        ? Math.min(...temps)
        : null;
    const maxTemp = temps.length
        ? Math.max(...temps)
        : null;

    return {
        lat,
        lon,
        model: 'ifsoper',
        currentTemp,
        minTemp,
        maxTemp,
        times,
        temps,
        fromTime: fromTime.toISOString(),
        untilTime: untilTime.toISOString()
    };
}
