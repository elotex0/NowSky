export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // Aktuelle Zeit auf die letzte volle 5-Minuten-Marke abrunden
    const now = new Date();
    const minutes = now.getUTCMinutes();
    const roundedMinutes = Math.floor(minutes / 5) * 5;
    const created = new Date(now);
    created.setUTCMinutes(roundedMinutes);
    created.setUTCSeconds(0);
    created.setUTCMilliseconds(0);

    // Format: 2026-06-03T09:50:00Z
    const createdStr = created.toISOString().replace(".000Z", "Z");

    const url =
      `https://maps.dwd.de/geoserver/dwd/ows` +
      `?service=WFS` +
      `&version=2.0.0` +
      `&request=GetFeature` +
      `&typeNames=dwd:Autowarn_Analyse` +
      `&outputFormat=application/json` +
      `&CQL_FILTER=CREATED>='${createdStr}' AND EC_GROUP='Gewitter'`;

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ error: "DWD konnte nicht geladen werden", url });
    }

    const data = await response.json();
    const features = data.features || [];

    const daten = features.map((f) => {
      const p = f.properties;
      let polygon = [];
      if (f.geometry?.type === "Polygon") {
        polygon = f.geometry.coordinates[0].map(([lon, lat]) => ({ lat, lon }));
      } else if (f.geometry?.type === "MultiPolygon") {
        polygon = f.geometry.coordinates.map((poly) =>
          poly[0].map(([lon, lat]) => ({ lat, lon }))
        );
      }
      return {
        id: f.id,
        dbId: p.ID,
        idAlert: p.ID_ALERT,
        source: p.SOURCE,
        category: p.CATEGORY,
        event: p.EVENT,
        ecIi: p.EC_II,
        ecGroup: p.EC_GROUP,
        ecAreaColor: p.EC_AREA_COLOR,
        severity: p.SEVERITY,
        headline: p.HEADLINE,
        senderName: p.SENDERNAME,
        effective: p.EFFECTIVE,
        onset: p.ONSET,
        expires: p.EXPIRES,
        created: p.CREATED,
        altitude: p.ALTITUDE,
        ceiling: p.CEILING,
        polygon,
        bbox: f.bbox,
      };
    });

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      createdFilter: createdStr,
      anzahl: daten.length,
      daten,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
