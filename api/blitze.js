// api/lightning.js
// Abruf: /api/lightning?lat=48.5&lon=8.4&radius=25

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { lat, lon, radius } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon sind erforderlich" });
  }

  const latNum   = parseFloat(lat);
  const lonNum   = parseFloat(lon);
  const radiusKm = parseFloat(radius ?? 5);

  const fmtDE = (isoStr) =>
    new Date(isoStr).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    }) + " Uhr";

  const dateFmt = (d) => d.toISOString().split("T")[0];

  const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const inGermany = (p) =>
    p.lat >= 47.4 && p.lat <= 55.05 &&
    p.lon >=  6.0 && p.lon <= 15.05;

  const countPoints = (points) => ({
    standort:     points.filter(p => haversine(latNum, lonNum, p.lat, p.lon) <= radiusKm).length,
    deutschland:  points.filter(inGermany).length,
    europa:       points.length,
  });

  try {
    // ── Aktuell (letzte 24h) ──────────────────────────────────────────
    const liveRes = await fetch("https://ukwx.duckdns.org/lightning/europe", {
      headers: { "User-Agent": "lightning-api" },
      signal: AbortSignal.timeout(10000),
    });
    if (!liveRes.ok) throw new Error(`HTTP ${liveRes.status} von live-endpoint`);
    const liveData   = await liveRes.json();
    const liveCounts = countPoints(liveData.points ?? []);

    // ── Archiv: letzte 7 Tage ─────────────────────────────────────────
    const today = new Date();
    const archiveDates = Array.from({ length: 8 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - 1 - i);
      return dateFmt(d);
    });

    const archiveResults = await Promise.allSettled(
      archiveDates.map(async (dateStr) => {
        const url = `https://ukwx.duckdns.org/lightning/archive/europe/${dateStr}.json`;
        const r = await fetch(url, {
          headers: { "User-Agent": "lightning-api" },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return null;
        const d = await r.json();
        const counts = countPoints(d.points ?? []);
        // fetched_at vom letzten verfügbaren Archivtag merken
        return { datum: dateStr, fetched_at: d.fetched_at ?? null, ...counts };
      })
    );

    const archiveTage = archiveResults
      .map(r => r.status === "fulfilled" ? r.value : null)
      .filter(Boolean);

    // fetched_at des neuesten Archivtags (erster Eintrag = gestern)
    const archivFetchedAt = archiveTage[0]?.fetched_at ?? null;

    const archivSumme = archiveTage.reduce(
      (acc, t) => ({
        standort:    acc.standort    + t.standort,
        deutschland: acc.deutschland + t.deutschland,
        europa:      acc.europa      + t.europa,
      }),
      { standort: 0, deutschland: 0, europa: 0 }
    );

    return res.status(200).json({
      aktuell: {
        aktualisiert: liveData.fetched_at ? fmtDE(liveData.fetched_at) : null,
        period: {
          von: fmtDE(liveData.period_start),
          bis: fmtDE(liveData.period_end),
        },
        standort:    { lat: latNum, lon: lonNum, radius_km: radiusKm, blitze: liveCounts.standort },
        deutschland: { blitze: liveCounts.deutschland },
        europa:      { blitze: liveCounts.europa },
      },
      archiv_7_tage: {
        aktualisiert: archivFetchedAt ? fmtDE(archivFetchedAt) : null,
        summe: {
          standort:    { blitze: archivSumme.standort },
          deutschland: { blitze: archivSumme.deutschland },
          europa:      { blitze: archivSumme.europa },
        },
        tage: archiveTage.map(t => ({
          datum:       t.datum,
          standort:    t.standort,
          deutschland: t.deutschland,
          europa:      t.europa,
        })),
      },
    });

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
