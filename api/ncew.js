// pages/api/lightning.js (Next.js)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const response = await fetch(
      "https://www.wetterdienst.de/warnwetter/lightning.php"
    );
    if (!response.ok) {
      return res.status(502).json({ error: "Wetterdienst nicht erreichbar" });
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
        polygonId: p.POLYGON_ID,
        objectId: p.OBJECT_ID,
        producerId: p.PRODUCER_ID,
        producerName: p.PRODUCER_NAME,
        analyseDate: p.ANALYSE_DATE,
        validDate: p.VALID_DATE,
        polygon,
        bbox: f.bbox,
      };
    });

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      anzahl: daten.length,
      daten,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
