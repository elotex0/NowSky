export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const dwdRes = await fetch(
      "https://app-prod-static.warnwetter.de/v16/gemeinde_warnings_v2.json"
    );
    if (!dwdRes.ok) {
      return res.status(502).json({ error: "DWD-Daten konnten nicht geladen werden" });
    }

    const data = await dwdRes.json();

    const rawTime = data.time ?? Date.now();
    const deutscheZeit = new Date(rawTime).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const warnungen = (data.warnings ?? []).map((w) => ({
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
