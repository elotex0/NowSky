const TEST_WARNUNG = {
  id: "TEST-2026-ORKAN-HESSEN-001",
  type: 2,
  level: 4,
  start: Date.now() + 6 * 3600 * 1000,
  end: Date.now() + 30 * 3600 * 1000,
  event: "ORKANBÖEN",
  headline: "Vorabinformation extremer Orkanböen für Süd- und Mittelhessen",
  description:
    "Es treten extrem starke Orkanböen mit Geschwindigkeiten zwischen 120 und 140 km/h (Bft 12) auf. " +
    "Örtlich sind noch höhere Böen möglich. Es besteht erhebliche Gefahr für Leib und Leben. " +
    "Bäume können entwurzelt werden, Gebäude können beschädigt werden.",
  instruction:
    "Begeben Sie sich in ein stabiles Gebäude. Halten Sie sich von Fenstern fern. " +
    "Vermeiden Sie unnötige Fahrten. Halten Sie Abstand von Bäumen, Gerüsten und Hochspannungsleitungen. " +
    "Sichern Sie Gegenstände im Freien.",
  isVorabinfo: true,
  regions: [
    {
      polygon: [
        [8.4712, 49.7218], [8.5891, 49.745],  [8.7123, 49.8012],
        [8.8201, 49.8654], [8.9012, 49.9231], [8.9432, 50.0123],
        [8.8765, 50.1234], [8.7543, 50.1876], [8.6234, 50.2012],
        [8.5123, 50.1654], [8.4234, 50.0543], [8.3654, 49.9234],
        [8.3234, 49.8123], [8.3765, 49.7654], [8.4712, 49.7218],
      ],
      polygonGeometry: {
        type: "Polygon",
        coordinates: [[
          [8.4712, 49.7218], [8.5891, 49.745],  [8.7123, 49.8012],
          [8.8201, 49.8654], [8.9012, 49.9231], [8.9432, 50.0123],
          [8.8765, 50.1234], [8.7543, 50.1876], [8.6234, 50.2012],
          [8.5123, 50.1654], [8.4234, 50.0543], [8.3654, 49.9234],
          [8.3234, 49.8123], [8.3765, 49.7654], [8.4712, 49.7218],
        ]],
      },
    },
    {
      polygon: [
        [8.5012, 50.2345], [8.6234, 50.2876], [8.7543, 50.3456],
        [8.8654, 50.4123], [8.9234, 50.5012], [8.9012, 50.6123],
        [8.8123, 50.6876], [8.6876, 50.7234], [8.5543, 50.7012],
        [8.4234, 50.6543], [8.3456, 50.5678], [8.3123, 50.4543],
        [8.3654, 50.3456], [8.4543, 50.2765], [8.5012, 50.2345],
      ],
      polygonGeometry: {
        type: "Polygon",
        coordinates: [[
          [8.5012, 50.2345], [8.6234, 50.2876], [8.7543, 50.3456],
          [8.8654, 50.4123], [8.9234, 50.5012], [8.9012, 50.6123],
          [8.8123, 50.6876], [8.6876, 50.7234], [8.5543, 50.7012],
          [8.4234, 50.6543], [8.3456, 50.5678], [8.3123, 50.4543],
          [8.3654, 50.3456], [8.4543, 50.2765], [8.5012, 50.2345],
        ]],
      },
    },
  ],
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ?test=1    → echte DWD-Daten + Testwarnung vorne dran
    // ?test=only → nur Testwarnung, kein DWD-Request
    const testMode = req.query.test;

    let warnungen = [];
    let deutscheZeit;

    if (testMode !== "only") {
      const dwdRes = await fetch(
        "https://app-prod-static.warnwetter.de/v16/gemeinde_warnings_v2.json"
      );
      if (!dwdRes.ok) {
        return res.status(502).json({ error: "DWD-Daten konnten nicht geladen werden" });
      }
      const data = await dwdRes.json();
      const rawTime = data.time ?? Date.now();
      deutscheZeit = new Date(rawTime).toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      warnungen = (data.warnings ?? []).map((w) => ({
        id: w.warnId ?? w.id ?? null,
        type: w.type ?? null,
        level: w.level ?? null,
        start: w.start ?? null,
        end: w.end ?? null,
        event: w.event ?? null,
        headline: w.headLine ?? null,
        description: w.descriptionText ?? w.description ?? null,
        instruction: w.instruction ?? null,
        isVorabinfo: w.isVorabinfo ?? false,
        regions: (w.regions ?? []).map((r) => ({
          polygon: r.polygon ?? [],
          polygonGeometry: r.polygonGeometry ?? null,
        })),
      }));
    } else {
      deutscheZeit = new Date().toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }

    if (testMode) {
      warnungen = [TEST_WARNUNG, ...warnungen];
    }

    return res.status(200).json({
      time: deutscheZeit,
      warnungen: {
        anzahl: warnungen.length,
        gebiete: warnungen,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
