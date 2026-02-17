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
        res.status(400).json({ error: 'lat and lon required' });
        return;
    }

    try {
        const result = await checkThunderstorm(parseFloat(lat), parseFloat(lon));

        res.status(200).json({
            lat: parseFloat(lat),
            lon: parseFloat(lon),
            thunderstorm: result.thunderstorm,
            severity: result.severity
        });
    } catch (err) {
        console.error("Both DWD servers failed:", err);

        res.status(200).json({
            lat: parseFloat(lat),
            lon: parseFloat(lon),
            thunderstorm: false,
            severity: null
        });
    }
}

async function checkThunderstorm(lat, lon) {
    const delta = 0.05;
    const bbox = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;

    const servers = [
        "https://maps.dwd.de/geoserver/dwd/wms",      // Hauptserver
        "https://brz-maps.dwd.de/geoserver/dwd/wms"   // Backup
    ];

    const controller = new AbortController();
    const timeoutMs = 6000;

    for (const baseUrl of servers) {
        try {
            const url = new URL(baseUrl);
            url.searchParams.set("SERVICE", "WMS");
            url.searchParams.set("VERSION", "1.1.1");
            url.searchParams.set("REQUEST", "GetFeatureInfo");
            url.searchParams.set("LAYERS", "dwd:Autowarn_Analyse");
            url.searchParams.set("QUERY_LAYERS", "dwd:Autowarn_Analyse");
            url.searchParams.set("BBOX", bbox);
            url.searchParams.set("FEATURE_COUNT", "50");
            url.searchParams.set("HEIGHT", "101");
            url.searchParams.set("WIDTH", "101");
            url.searchParams.set("INFO_FORMAT", "application/json");
            url.searchParams.set("SRS", "EPSG:4326");
            url.searchParams.set("X", "50");
            url.searchParams.set("Y", "50");

            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(url.toString(), { signal: controller.signal });
            clearTimeout(timeout);

            // HTTP-Fehler => nächster Server
            if (!response.ok) {
                console.warn(`Server ${baseUrl} returned HTTP ${response.status}, switching to next server.`);
                continue;
            }

            const data = await response.json();

            if (!data.features || data.features.length === 0) {
                return { thunderstorm: false, severity: null };
            }

            const thunderFeatures = data.features.filter(
                f => f.properties?.EC_GROUP === "Gewitter"
            );

            if (thunderFeatures.length === 0) {
                return { thunderstorm: false, severity: null };
            }

            const severityOrder = ["minor", "moderate", "severe", "extrem"];
            let maxSeverityIndex = -1;

            for (const f of thunderFeatures) {
                const sev = f.properties?.SEVERITY?.toLowerCase();
                const idx = severityOrder.indexOf(sev);
                if (idx > maxSeverityIndex) maxSeverityIndex = idx;
            }

            return {
                thunderstorm: true,
                severity: maxSeverityIndex >= 0 ? severityOrder[maxSeverityIndex] : null
            };

        } catch (err) {
            console.warn(`Server ${baseUrl} failed:`, err.message);
            // Fehler => nächster Server
            continue;
        }
    }

    // Wenn beide Server fehlschlagen
    return { thunderstorm: false, severity: null };
}
