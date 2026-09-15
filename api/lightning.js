// api/lightning.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const DE_BBOX = { latMin: 46.9, latMax: 55.55, lonMin: 5.5, lonMax: 15.55 }
  const inGermany = (p) =>
    p.lat >= DE_BBOX.latMin && p.lat <= DE_BBOX.latMax &&
    p.lon >= DE_BBOX.lonMin && p.lon <= DE_BBOX.lonMax;

  const BUCKET_DEFS = [
    "0-5","5-10","10-15","15-20","20-25","25-30",
    "30-35","35-40","40-45","45-50","50-55","55-60",
  ];
  const MAX_AGE_MIN = 60;
  const ROUND_SEC = 5 * 60;

  try {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);

    // Raster-Referenzpunkt für die STABILEN, älteren Buckets
    const nowRoundedSec = Math.floor(nowSec / ROUND_SEC) * ROUND_SEC;

    const vonSec = nowRoundedSec - 60 * MAX_AGE_MIN;
    const cutoffSec = vonSec;

    const liveRes = await fetch("https://ukwx.duckdns.org/lightning/europe", {
      headers: { "User-Agent": "lightning-api" },
      signal: AbortSignal.timeout(10000),
    });
    if (!liveRes.ok) throw new Error(`HTTP ${liveRes.status} vom Live-Endpoint`);
    const liveData = await liveRes.json();
    const allPoints = liveData.points ?? [];

    // Obergrenze ist jetzt die ECHTE aktuelle Zeit, nicht die gerundete
    const filtered = allPoints.filter((p) => inGermany(p) && p.t >= cutoffSec && p.t <= nowSec);

    const grouped = {};
    const bucketRanges = {};
    for (const key of BUCKET_DEFS) {
      const [minMin, maxMin] = key.split("-").map(Number);
      grouped[key] = [];
      bucketRanges[key] = {
        von: new Date((nowRoundedSec - 60 * maxMin) * 1000).toISOString(),
        // Der neueste Bucket "0-5" endet bei "jetzt" (real), alle anderen am Raster
        bis: minMin === 0
          ? now.toISOString()
          : new Date((nowRoundedSec - 60 * minMin) * 1000).toISOString(),
      };
    }

    const getBucketKey = (t) => {
      // Alter relativ zum RASTER-Zeitpunkt berechnen
      let ageMinFromRounded = (nowRoundedSec - t) / 60;
      // Blitze, die NACH der Rundungsmarke liegen (also zwischen 14:15:00 und 14:15:59),
      // sollen trotzdem in den neuesten Bucket "0-5" fallen -> Alter auf 0 clampen
      if (ageMinFromRounded < 0) ageMinFromRounded = 0;

      for (const key of BUCKET_DEFS) {
        const [minMin, maxMin] = key.split("-").map(Number);
        if (ageMinFromRounded >= minMin && ageMinFromRounded < maxMin) return key;
      }
      return null;
    };

    for (const p of filtered) {
      const bucketKey = getBucketKey(p.t);
      if (!bucketKey) continue;
      grouped[bucketKey].push({
        lat: p.lat,
        lon: p.lon,
        time: new Date(p.t * 1000).toISOString(),
      });
    }

    const anzahlProBucket = {};
    for (const key of BUCKET_DEFS) anzahlProBucket[key] = grouped[key].length;

    return res.status(200).json({
      meta: {
        von: new Date(vonSec * 1000).toISOString(),
        bis: now.toISOString(), // echte Jetzt-Zeit, nicht gerundet
        anzahlGesamt: filtered.length,
        anzahlProBucket,
        bucketZeiten: bucketRanges,
      },
      buckets: grouped,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
