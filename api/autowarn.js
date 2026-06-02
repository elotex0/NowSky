import { XMLParser } from "fast-xml-parser";

export default async function handler(req, res) {
  // =====================
  // CORS
  // =====================
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    // =====================
    // DWD KML laden
    // =====================
    const response = await fetch(
      "https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.1.0&request=GetMap&layers=dwd%3AAutowarn_Analyse&bbox=5.0%2C47.0%2C16.0%2C55.3&width=768&height=579&srs=EPSG%3A4326&styles=&format=application%2Fvnd.google-earth.kml"
    );

    if (!response.ok) {
      return res.status(502).json({
        error: "DWD KML konnte nicht geladen werden"
      });
    }

    const xml = await response.text();

    // =====================
    // XML Parser
    // =====================
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseTagValue: true,
      trimValues: true
    });

    const kml = parser.parse(xml);

    const folder =
      kml?.kml?.Document?.Folder ||
      kml?.Document?.Folder;

    let placemarks = folder?.Placemark || [];

    if (!Array.isArray(placemarks)) {
      placemarks = [placemarks];
    }

    // =====================
    // Helper: HTML Felder extrahieren
    // =====================
    const getField = (html, key) => {
      const match = html?.match(
        new RegExp(
          `${key}</span>:</strong>\\s*<span class="atr-value">([^<]+)`
        )
      );
      return match ? match[1] : null;
    };

    // =====================
    // Daten bauen
    // =====================
    const daten = placemarks
      .map((p) => {
        const html = p?.description || "";

        const group = getField(html, "EC_GROUP");

        // 👉 NUR GEWITTER
        if (group !== "Gewitter") return null;

        // Mittelpunkt
        let point = null;

        if (p?.MultiGeometry?.Point?.coordinates) {
          const [lon, lat] =
            p.MultiGeometry.Point.coordinates
              .split(",")
              .map(Number);

          point = { lat, lon };
        }

        // Polygon
        let polygon = [];

        const coords =
          p?.MultiGeometry?.Polygon?.outerBoundaryIs?.LinearRing
            ?.coordinates;

        if (coords) {
          polygon = coords
            .trim()
            .split(/\s+/)
            .map((c) => {
              const [lon, lat] = c.split(",").map(Number);
              return { lat, lon };
            });
        }

        return {
          id: p.id,
          group,
          severity: getField(html, "SEVERITY"),
          event: getField(html, "EVENT"),
          created: getField(html, "CREATED"),
          expires: getField(html, "EXPIRES"),
          center: point,
          polygon
        };
      })
      .filter(Boolean);

    // =====================
    // Response
    // =====================
    return res.status(200).json({
      timestamp: new Date().toISOString(),
      anzahl: daten.length,
      type: "Gewitter",
      daten
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
}
