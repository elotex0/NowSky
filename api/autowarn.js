export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Nur diese Event-Typen durchlassen
  const GEWITTER_EVENTS = new Set([
    "gewitter",
    "starkes gewitter",
    "schweres gewitter",
    "extremes gewitter",
    "starkregen",
    "heftiger starkregen",
    "extrem heftiger starkregen"

  try {
    const [nowcastRes, gewitterRes] = await Promise.all([
      fetch("https://app-prod-static.warnwetter.de/v16/warnings_nowcast.json"),
      fetch("https://app-prod-static.warnwetter.de/v16/gewitter_monitor.json"),
    ]);
    if (!nowcastRes.ok || !gewitterRes.ok) {
      return res.status(502).json({ error: "DWD-Daten konnten nicht geladen werden" });
    }
    const [nowcastData, gewitterData] = await Promise.all([
      nowcastRes.json(),
      gewitterRes.json(),
    ]);

    const rawTime = nowcastData.time ?? gewitterData.time ?? Date.now();
    const deutscheZeit = new Date(rawTime).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    // Nur Gewitter-Warnungen aus nowcast
    const nowcastGebiete = (nowcastData.warnings ?? [])
      .filter((w) => {
        const event = (w.event ?? "").trim().toLowerCase();
        return GEWITTER_EVENTS.has(event);
      })
      .map((w) => ({
        id: w.warnId ?? w.id,
        level: w.level,
        event: w.event,
        description: w.descriptionText ?? w.description ?? null,
        polygon: w.regions?.[0]?.polygon ?? [],
      }));

    const gewitterGebiete = (gewitterData.gebiete ?? []).map((g) => ({
      id: g.id,
      level: g.level,
      polygon: g.polygon ?? [],
    }));

    return res.status(200).json({
      time: deutscheZeit,
      nowcast: {
        anzahl: nowcastGebiete.length,
        gebiete: nowcastGebiete,
      },
      gewitter: {
        anzahl: gewitterGebiete.length,
        gebiete: gewitterGebiete,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
