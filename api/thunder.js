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
    const globalTimeout = setTimeout(() => controller.abort(), 6000);

    const requests = servers.map(baseUrl => {

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

        return fetch(url.toString(), {
            signal: controller.signal
        })
        .then(res => {
            if (!res.ok) {
                throw new Error(`HTTP ${res.status} from ${baseUrl}`);
            }
            return res.json();
        });
    });

    try {

        // Schnellster erfolgreicher Server gewinnt
        const data = await Promise.race(requests);

        clearTimeout(globalTimeout);
        controller.abort(); // stoppt den langsameren Request

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
            if (idx > maxSeverityIndex) {
                maxSeverityIndex = idx;
            }
        }

        const strongestSeverity =
            maxSeverityIndex >= 0 ? severityOrder[maxSeverityIndex] : null;

        return {
            thunderstorm: true,
            severity: strongestSeverity
        };

    } catch (err) {

        clearTimeout(globalTimeout);
        controller.abort();

        throw err;
    }
}
