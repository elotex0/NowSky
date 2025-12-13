// api/alerts.js
export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const lat = parseFloat(searchParams.get('lat'));
  const lon = parseFloat(searchParams.get('lon'));

  let alerts = [];

  // --- NWS Alerts (USA) ---
  if (lat && lon) {
    try {
      const nwsUrl = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
      const nwsResponse = await fetch(nwsUrl, {
        headers: {
          "User-Agent": "vercel-serverless-weather-api",
          "Accept": "application/geo+json",
        },
      });
      const nwsData = await nwsResponse.json();
      alerts.push(...(nwsData.features?.map(f => ({
        source: "NWS",
        sent: f.properties.sent,
        onset: f.properties.onset,
        ends: f.properties.ends,
        event: f.properties.event,
        description: f.properties.description,
        updated: f.properties.updated,
      })) || []));
    } catch (e) {
      console.error("NWS fetch failed", e);
    }
  }

  // --- MeteoAlarm France ---
  if (lat && lon) {
    try {
      const frUrl = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-france';
      const frResponse = await fetch(frUrl);
      const frXml = await frResponse.text();

      // Edge-kompatibler XML-Parser
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(frXml, "text/xml");
      const entries = Array.from(xmlDoc.getElementsByTagName("entry"));

      for (const entry of entries) {
        const polygonStr = entry.getElementsByTagName("cap:polygon")[0]?.textContent;
        if (!polygonStr) continue;

        // Polygon umwandeln: "lat,lon lat,lon ..." → [[lon,lat],...]
        const coords = polygonStr.split(' ').map(pair => {
          const [latStr, lonStr] = pair.split(',');
          return [parseFloat(lonStr), parseFloat(latStr)];
        });

        const point = [lon, lat];
        if (pointInPolygon(point, coords)) {
          alerts.push({
            source: "MeteoAlarm-France",
            event: entry.getElementsByTagName("cap:event")[0]?.textContent,
            area: entry.getElementsByTagName("cap:areaDesc")[0]?.textContent,
            sent: entry.getElementsByTagName("cap:sent")[0]?.textContent,
            onset: entry.getElementsByTagName("cap:onset")[0]?.textContent,
            expires: entry.getElementsByTagName("cap:expires")[0]?.textContent,
            severity: entry.getElementsByTagName("cap:severity")[0]?.textContent,
            urgency: entry.getElementsByTagName("cap:urgency")[0]?.textContent,
            certainty: entry.getElementsByTagName("cap:certainty")[0]?.textContent,
            title: entry.getElementsByTagName("title")[0]?.textContent,
            link: entry.getElementsByTagName("link")[0]?.getAttribute("href"),
          });
        }
      }
    } catch (err) {
      console.error("MeteoAlarm fetch failed", err);
    }
  }

  return new Response(JSON.stringify({ alerts }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// --- Point-in-Polygon Funktion (Ray Casting) ---
function pointInPolygon(point, vs) {
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1];
    const xj = vs[j][0], yj = vs[j][1];

    const intersect = ((yi > y) !== (yj > y)) &&
                      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-10) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
