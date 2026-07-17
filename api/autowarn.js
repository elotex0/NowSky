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
    "extrem heftiger starkregen",
  ]);

  // Primary + Fallback-Server für die statischen DWD-JSON-Dateien
  const BASE_PRIMARY = "https://app-prod-static.warnwetter.de/v16/";
  const BASE_FALLBACK = "https://s3-eu-west-1.amazonaws.com/app-prod-static-irl.warnwetter.de/v16/";

  // Holt eine JSON-Datei von einer URL, gibt null zurück statt zu werfen
  const fetchJsonSafe = async (url) => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  };

  // Holt gewitter_monitor.json von primary UND fallback parallel,
  // nimmt die Antwort, die tatsächlich Gebiete enthält.
  // Falls beide welche haben: primary bevorzugen.
  // Falls beide leer/fehlerhaft sind: leeres Objekt zurückgeben.
  const fetchGewitterWithFallback = async () => {
    const [primary, fallback] = await Promise.all([
      fetchJsonSafe(BASE_PRIMARY + "gewitter_monitor.json"),
      fetchJsonSafe(BASE_FALLBACK + "gewitter_monitor.json"),
    ]);

    const primaryGebiete = primary?.gebiete ?? [];
    const fallbackGebiete = fallback?.gebiete ?? [];

    if (primaryGebiete.length > 0) return { data: primary, source: "primary" };
    if (fallbackGebiete.length > 0) return { data: fallback, source: "fallback" };
    // beide leer -> nimm was auch immer nicht null ist, sonst leeres Objekt
    return { data: primary ?? fallback ?? {}, source: primary ? "primary-empty" : fallback ? "fallback-empty" : "none" };
  };

  try {
    const [nowcastData, gewitterResult] = await Promise.all([
      fetchJsonSafe(BASE_PRIMARY + "warnings_nowcast.json"),
      fetchGewitterWithFallback(),
    ]);

    if (!nowcastData && gewitterResult.source === "none") {
      return res.status(502).json({ error: "DWD-Daten konnten nicht geladen werden" });
    }

    const gewitterData = gewitterResult.data;

    const rawTime = nowcastData?.time ?? gewitterData?.time ?? Date.now();
    const deutscheZeit = new Date(rawTime).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const toDE = (ts) =>
      new Date(ts).toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

    // Nur Gewitter-Warnungen aus nowcast
    const nowcastGebiete = (nowcastData?.warnings ?? [])
      .filter((w) => {
        const event = (w.event ?? "").trim().toLowerCase();
        return GEWITTER_EVENTS.has(event);
      })
      .map((w) => ({
        id: w.warnId ?? w.id,
        level: w.level,
        event: w.event,
        start: w.start ? toDE(w.start) : null,
        end: w.end ? toDE(w.end) : null,
        description: w.descriptionText ?? w.description ?? null,
        polygon: w.regions?.[0]?.polygon ?? [],
      }));

    const gewitterGebiete = (gewitterData?.gebiete ?? []).map((g) => ({
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
        quelle: gewitterResult.source, // "primary" | "fallback" | "primary-empty" | "fallback-empty" | "none"
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
