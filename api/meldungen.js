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
    const jetzt = Date.now();

    // =====================
    // 2️⃣ Zeitstempel → Europe/Berlin
    // =====================
    const toBerlinTime = (ts) => {
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
    // 3️⃣ Filtern: nur Meldungen bis jetzt, neueste zuerst
    // =====================
    const meldungen = (dwdData.meldungen ?? [])
      .filter((m) => m.timestamp <= jetzt)
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((m) => ({
        meldungId: m.meldungId,
        zeit: toBerlinTime(m.timestamp),
        category: m.category,
        auspraegung: m.auspraegung,
        place: m.place,
        lat: m.lat,
        lon: m.lon,
        ...(m.imageUrl ? { imageUrl: m.imageUrl } : {})
      }));

    // =====================
    // 4️⃣ Response
    // =====================
    res.status(200).json({
      abgerufen_um: toBerlinTime(jetzt),
      anzahl: meldungen.length,
      meldungen
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
