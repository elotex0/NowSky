// api/lightning.js
// Abruf: /api/lightning
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Deutschland Bounding Box
  const DE_BBOX = { latMin: 47.4, latMax: 55.05, lonMin: 6.0, lonMax: 15.05 }
  const inGermany = (p) =>
    p.lat >= DE_BBOX.latMin && p.lat <= DE_BBOX.latMax &&
    p.lon >= DE_BBOX.lonMin && p.lon <= DE_BBOX.lonMax;

  // Zeit-Buckets in Minuten (Alter des Blitzes relativ zu "jetzt")
  const BUCKETS = [
    { key: "0-5", minMin: 0, maxMin: 5 },
    { key: "5-10", minMin: 5, maxMin: 10 },
    { key: "10-15", minMin: 10, maxMin: 15 },
    { key: "15-20", minMin: 15, maxMin: 20 },
    { key: "20-25", minMin: 20, maxMin: 25 },
    { key: "25-30", minMin: 25, maxMin: 30 },
  ];
  const MAX_AGE_MIN = BUCKETS[BUCKETS.length - 1].maxMin; // 30

  const getBucket = (ageMin) => {
    for (const b of BUCKETS) {
      if (ageMin >= b.minMin && ageMin < b.maxMin) return b.key;
    }
    return null; // älter als MAX_AGE_MIN -> wird verworfen
  };

  try {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const cutoffSec = nowSec - 60 * MAX_AGE_MIN; // bis 30 min zurück

    const liveRes = await fetch("https://ukwx.duckdns.org/lightning/europe", {
      headers: { "User-Agent": "lightning-api" },
      signal: AbortSignal.timeout(10000),
    });
    if (!liveRes.ok) throw new Error(`HTTP ${liveRes.status} vom Live-Endpoint`);
    const liveData = await liveRes.json();
    const allPoints = liveData.points ?? [];

    // Nur Deutschland + Zeitfilter letzte 30 min
    // Zeitfeld ist "t" (Unix-Sekunden)
    const filtered = allPoints.filter((p) => inGermany(p) && p.t >= cutoffSec);

    // Buckets initialisieren
    const grouped = {};
    for (const b of BUCKETS) grouped[b.key] = [];

    for (const p of filtered) {
      const ageMin = (nowSec - p.t) / 60;
      const bucketKey = getBucket(ageMin);
      if (!bucketKey) continue;
      grouped[bucketKey].push({
        lat: p.lat,
        lon: p.lon,
        time: new Date(p.t * 1000).toISOString(),
      });
    }

    const anzahlProBucket = {};
    for (const b of BUCKETS) anzahlProBucket[b.key] = grouped[b.key].length;

    return res.status(200).json({
      meta: {
        von: new Date(cutoffSec * 1000).toISOString(),
        bis: now.toISOString(),
        anzahlGesamt: filtered.length,
        anzahlProBucket,
      },
      buckets: grouped,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
