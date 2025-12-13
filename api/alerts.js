// api/alerts.js
import fetch from 'node-fetch';
import * as turf from '@turf/turf';
import xml2js from 'xml2js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const lat = parseFloat(searchParams.get('lat'));
  const lon = parseFloat(searchParams.get('lon'));

  // NWS Alerts (USA) – optional
  let alerts = [];
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

  // MeteoAlarm France Feed
  try {
    const frUrl = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-france';
    const frResponse = await fetch(frUrl);
    const frXml = await frResponse.text();

    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    const frData = await parser.parseStringPromise(frXml);

    const entries = frData.feed.entry;
    if (entries && lat && lon) {
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        const polygonStr = entry['cap:polygon'];
        if (!polygonStr) continue;

        // Polygon umwandeln: "lat,lon lat,lon ..." → [[lon,lat],...]
        const coords = polygonStr.split(' ').map(pair => {
          const [latStr, lonStr] = pair.split(',');
          return [parseFloat(lonStr), parseFloat(latStr)]; // GeoJSON expects [lon,lat]
        });
        const polygon = turf.polygon([[...coords, coords[0]]]); // Polygon muss geschlossen sein
        const point = turf.point([lon, lat]);

        if (turf.booleanPointInPolygon(point, polygon)) {
          alerts.push({
            event: entry['cap:event'],
            sent: entry['cap:sent'],
            onset: entry['cap:onset'],
            ends: entry['cap:expires'],
          });
        }
      }
    }
  } catch (err) {
    console.error("MeteoAlarm fetch failed", err);
  }

  return new Response(JSON.stringify({ alerts }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
