export default async function handler(req, res) {
  // =====================
  // CORS
  // =====================
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // =====================
    // 1️⃣ DWD Crowd-Meldungen laden
    // =====================
    const dwdRes = await fetch(
      "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16/crowd_meldungen_overview_v2.json",
      { headers: { "User-Agent": "meldungen-api" } }
    );

    if (!dwdRes.ok) {
      return res.status(502).json({ error: "Fehler beim Laden der DWD-Meldungen" });
    }

    const dwdData = await dwdRes.json();

    // =====================
    // 2️⃣ Zeitstempel → Europe/Berlin
    // =====================
    const toberlinTime = (ts) => {
      if (!ts) return null;
      return new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(new Date(ts));
    };

    // =====================
    // 3️⃣ Optionaler Filter: ?category=WIND
    // =====================
    const { category, limit } = req.query;

    let meldungen = dwdData.meldungen ?? [];

    if (category) {
      meldungen = meldungen.filter(
        (m) => m.category?.toUpperCase() === category.toUpperCase()
      );
    }

    // Optional: Anzahl begrenzen (Standard: alle)
    const maxItems = limit ? parseInt(limit, 10) : meldungen.length;
    meldungen = meldungen.slice(0, maxItems);

    // =====================
    // 4️⃣ Meldungen aufbereiten (Zeitstempel als Berlin-Zeit ergänzen)
    // =====================
    const meldungenMitZeit = meldungen.map((m) => ({
      ...m,
      timestamp_berlin: toberlinTime(m.timestamp)
    }));

    // =====================
    // 5️⃣ Response bauen
    // =====================
    res.status(200).json({
      meta: {
        start: dwdData.start,
        start_berlin: toberlinTime(dwdData.start),
        end: dwdData.end,
        end_berlin: toberlinTime(dwdData.end),
        windowsSizeHours: dwdData.windowsSizeHours,
        total: meldungenMitZeit.length,
        fetched_at_berlin: toberlinTime(Date.now())
      },
      highestSeverities: dwdData.highestSeverities ?? [],
      meldungen: meldungenMitZeit
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
