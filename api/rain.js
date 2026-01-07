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

  // Radar holen (zentriert auf lat/lon!)
  const res = await fetch(
    `https://api.brightsky.dev/radar?lat=${lat}&lon=${lng}`
  );
  const json = await res.json();

  if (!json.radar?.length) {
    throw new Error("No radar data");
  }

  const frame = json.radar[0];
  const { width, height } = frame;

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

  // 🎯 ZENTRALE PIXEL (lat/lon liegt IMMER hier)
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);

  // 3×3-Pixel Mittelwert (~1 km)
  let sum = 0, count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && y >= 0 && x < width && y < height) {
        sum += precip[y * width + x];
        count++;
      }
    }
  }

  const mmh = count ? sum / count : 0;

  // 5-Min Zeit
  const now = new Date();
  now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0);
  rainForecastData.results.push(mmh);
  rainForecastData.times.push(now);

  // 1-Min Interpolation (stabil)
  const realNow = new Date();
  const offset =
    ((realNow.getMinutes() % 5) * 60 + realNow.getSeconds()) / 60;

  for (let i = 0; i <= 60; i++) {
    rainForecastData.perMinute.push(mmh);
    rainForecastData.perMinuteTimes.push(
      new Date(now.getTime() + (offset + i) * 60000)
    );
  }

  // Start / Ende Regen
  const startIdx = rainForecastData.perMinute.findIndex(v => v > 0);
  if (startIdx !== -1) {
    let endIdx = startIdx;
    for (let i = startIdx; i < rainForecastData.perMinute.length; i++) {
      if (rainForecastData.perMinute[i] > 0) endIdx = i;
      else break;
    }
    rainForecastData.startRain =
      rainForecastData.perMinuteTimes[startIdx];
    rainForecastData.endRain =
      rainForecastData.perMinuteTimes[endIdx];
    rainForecastData.duration = endIdx - startIdx + 1;
  }

  return rainForecastData;
}