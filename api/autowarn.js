// Letzte 5-Minuten-Marke in UTC als ISO-String
function getLast5MinUTC() {
  const now = new Date();
  now.setUTCSeconds(0, 0);
  now.setUTCMinutes(Math.floor(now.getUTCMinutes() / 5) * 5);
  return now.toISOString().slice(0, 19) + "Z";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const since = getLast5MinUTC();
    const filter = `ONSET>=${since} AND EC_GROUP='Gewitter'`;
    const url = `https://maps.dwd.de/geoserver/dwd/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=dwd:Autowarn_Vorhersage&outputFormat=application/json&CQL_FILTER=${encodeURIComponent(filter)}`;

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ error: "DWD konnte nicht geladen werden" });
    }

    const data = await response.json();
    const features = data.features || [];

    const daten = features.map((f) => {
      const p = f.properties;
      let polygon = [];
      if (f.geometry?.type === "Polygon") {
        polygon = f.geometry.coordinates[0].map(([lon, lat]) => ({ lat, lon }));
      }

      return {
        id: p.ID,
        group: p.EC_GROUP,
        severity: p.SEVERITY,
        event: p.EC_II,
        created: p.CREATED,
        onset: p.ONSET,
        expires: p.EXPIRES,
        source: p.SOURCE,
        areaColor: p.EC_AREA_COLOR,
        polygon,
      };
    });

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      since,
      anzahl: daten.length,
      type: "Gewitter",
      daten,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
