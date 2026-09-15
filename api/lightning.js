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

    // Fester Raster-Referenzpunkt -> ändert sich NUR alle 5 Minuten
    const nowRoundedSec = Math.floor(nowSec / ROUND_SEC) * ROUND_SEC;

    const vonSec = nowRoundedSec - 60 * MAX_AGE_MIN;
    const bisSec = nowRoundedSec; // <- für die ANZEIGE, bleibt stabil
    const cutoffSec = vonSec;

    const liveRes = await fetch("https://ukwx.duckdns.org/lightning/europe", {
      headers: { "User-Agent": "lightning-api" },
      signal: AbortSignal.timeout(10000),
    });
    if (!liveRes.ok) throw new Error(`HTTP ${liveRes.status} vom Live-Endpoint`);
    const liveData = await liveRes.json();
    const allPoints = liveData.points ?? [];

    // Für die DATEN nutzen wir die echte aktuelle Zeit als Obergrenze,
    // damit nichts zwischen Rundungsmarke und "jetzt" verloren geht
    const filtered = allPoints.filter((p) => inGermany(p) && p.t >= cutoffSec && p.t <= nowSec);

    // Bucket-Zeiten für die ANZEIGE - komplett am Raster, bleibt stabil
    const grouped = {};
    const bucketRanges = {};
    for (const key of BUCKET_DEFS) {
      const [minMin, maxMin] = key.split("-").map(Number);
      grouped[key] = [];
      bucketRanges[key] = {
        von: new Date((bisSec - 60 * maxMin) * 1000).toISOString(),
        bis: new Date((bisSec - 60 * minMin) * 1000).toISOString(),
      };
    }

    // Zuordnung der Blitze: Alter relativ zum Raster-Zeitpunkt,
    // aber negatives Alter (zwischen Raster und echtem "jetzt") auf 0 clampen,
    // damit diese Blitze trotzdem in "0-5" landen statt zu verschwinden
    const getBucketKey = (t) => {
      let ageMinFromRounded = (bisSec - t) / 60;
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
        bis: new Date(bisSec * 1000).toISOString(), // bleibt fest am Raster (z.B. 14:15:00)
        anzahlGesamt: filtered.length,
        anzahlProBucket,
        bucketZeiten: bucketRanges, // alle Buckets fest am Raster
      },
      buckets: grouped,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
