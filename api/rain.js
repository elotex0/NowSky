import pako from "pako";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const { lat, lng } = req.query;
  if (!lat || !lng) {
    res.status(400).json({ error: "lat and lng are required" });
    return;
  }

  try {
    const forecast = await getRainForecast(+lat, +lng);
    res.status(200).json(forecast);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}

async function getRainForecast(lat, lng) {
  const rainForecastData = {
    results: [],
    times: [],
    startRain: null,
    endRain: null,
    duration: 0,
    perMinute: [],
    perMinuteTimes: []
  };

  // 1 km Box
  const deltaLat = 0.009;
  const deltaLon = 0.014 / Math.cos(lat * Math.PI / 180);

  const bbox = {
    minLat: lat - deltaLat / 2,
    maxLat: lat + deltaLat / 2,
    minLon: lng - deltaLon / 2,
    maxLon: lng + deltaLon / 2
  };

  // Radar holen
  const radarRes = await fetch(
    `https://api.brightsky.dev/radar?lat=${lat}&lon=${lng}`
  );
  const radarJson = await radarRes.json();

  if (!radarJson.radar?.length) {
    throw new Error("No radar data");
  }

  const frame = radarJson.radar[0];

  // ---- Dekompression → mm/h ----
  function decompress(raw, factor = 0.1) {
    const compressed = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    const buffer = pako.inflate(compressed).buffer;
    const u16 = new Uint16Array(buffer);
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) out[i] = u16[i] * factor;
    return out;
  }

  const precip = decompress(frame.precipitation_5);
  const { width, height } = frame;

  // ✅ WICHTIG: bbox kommt ALS ARRAY
  const [minLon, minLat, maxLon, maxLat] = frame.bbox;

  // ✅ LINEARE Pixelprojektion (RICHTIG!)
  function latLonToPixel(lat, lon) {
    return {
      px: Math.floor((lon - minLon) / (maxLon - minLon) * width),
      py: Math.floor((maxLat - lat) / (maxLat - minLat) * height)
    };
  }

  const corners = [
    latLonToPixel(bbox.minLat, bbox.minLon),
    latLonToPixel(bbox.minLat, bbox.maxLon),
    latLonToPixel(bbox.maxLat, bbox.minLon),
    latLonToPixel(bbox.maxLat, bbox.maxLon)
  ];

  const minPx = Math.max(0, Math.min(...corners.map(c => c.px)));
  const maxPx = Math.min(width - 1, Math.max(...corners.map(c => c.px)));
  const minPy = Math.max(0, Math.min(...corners.map(c => c.py)));
  const maxPy = Math.min(height - 1, Math.max(...corners.map(c => c.py)));

  let sum = 0, count = 0;
  for (let y = minPy; y <= maxPy; y++) {
    for (let x = minPx; x <= maxPx; x++) {
      sum += precip[y * width + x];
      count++;
    }
  }

  const mmh = count ? sum / count : 0;

  // 5-Min-Zeit
  const now = new Date();
  now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0);
  rainForecastData.results.push(mmh);
  rainForecastData.times.push(now);

  // 1-Min-Interpolation
  const realNow = new Date();
  const offset =
    ((realNow.getMinutes() % 5) * 60 + realNow.getSeconds()) / 60;

  const perMinute = [];
  const perMinuteTimes = [];
  for (let m = 0; m <= 60; m++) {
    perMinute.push(mmh);
    perMinuteTimes.push(new Date(now.getTime() + (offset + m) * 60000));
  }

  rainForecastData.perMinute = perMinute;
  rainForecastData.perMinuteTimes = perMinuteTimes;

  // Start / Ende Regen
  const startIdx = perMinute.findIndex(v => v > 0);
  if (startIdx !== -1) {
    let endIdx = startIdx;
    for (let i = startIdx; i < perMinute.length; i++) {
      if (perMinute[i] > 0) endIdx = i;
      else break;
    }
    rainForecastData.startRain = perMinuteTimes[startIdx];
    rainForecastData.endRain = perMinuteTimes[endIdx];
    rainForecastData.duration = endIdx - startIdx + 1;
  }

  return rainForecastData;
}