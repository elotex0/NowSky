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
        res.status(400).json(false);
        return;
    }

    try {
        const result = await checkThunderstorm(
            parseFloat(lat),
            parseFloat(lon)
        );

        res.status(200).json(result); // ← gibt nur true oder false zurück
    } catch (err) {
        console.error(err);
        res.status(200).json(false); // bei Fehler einfach false
    }
}


// ======================================================================
// Prüft Autowarn_Analyse auf GEWITTER
// ======================================================================

async function checkThunderstorm(lat, lon) {

    const delta = 0.02; // größerer Radius für Polygon
    const bbox = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;

    const url = new URL("https://maps.dwd.de/geoserver/dwd/wms");

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

    const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
        throw new Error(`DWD HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.features || data.features.length === 0) {
        return false;
    }

    // 🔥 Nur EC_GROUP === "GEWITTER"
    const hasThunderstorm = data.features.some(f =>
        f.properties?.EC_GROUP === "GEWITTER"
    );

    return hasThunderstorm;
}
