// /api/rain.js
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
    const data = await getRainForecast(parseFloat(lat), parseFloat(lng));
    res.status(200).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}

async function getRainForecast(lat, lng) {
  const result = {
    mmh: 0,
    timestamp: null,
    startRain: null,
    endRain: null,
    duration: 0
  };

  // -----------------------------
  // 1️⃣ 1-km Bounding Box
  // -----------------------------
  const deltaLat = 0.009;
  const deltaLon = 0.014 / Math.cos(lat * Math.PI / 180);

  const bboxQuery = {
    minLat: lat - deltaLat / 2,
    maxLat: lat + deltaLat / 2,
    minLon: lng - deltaLon / 2,
    maxLon: lng + deltaLon / 2
  };

  // -----------------------------
  // 2️⃣ Bright Sky Radar
  // -----------------------------
  const url = `https://api.brightsky.dev/radar?lat=${lat}&lon=${lng}`;
  const resRadar = await fetch(url);
  const json = await resRadar.json();

  if (!json.radar || json.radar.length === 0) {
    throw new Error("No radar data available");
  }

  const frame = json.radar[0];
  const { width, height, bbox } = frame;

  // -----------------------------
  // 3️⃣ Dekompression (16-bit → mm/h)
  // -----------------------------
  function decompress(raw, factor = 0.1) {
    const compressed = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    const inflated = pako.inflate(compressed);
    const u16 = new Uint16Array(inflated.buffer);
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) out[i] = u16[i] * factor;
    return out;
  }

  const precip = decompress(frame.precipitation_5);

  // -----------------------------
  // 4️⃣ Lat/Lon → Pixel (LINEAR, Bright-Sky-korrekt)
  // -----------------------------
  function latLonToPixel(lat, lon) {
    return {
      px: Math.floor(
        (lon - bbox.minLon) /
        (bbox.maxLon - bbox.minLon) * width
      ),
      py: Math.floor(
        (bbox.maxLat - lat) /
        (bbox.maxLat - bbox.minLat) * height
      )
    };
  }

  // -----------------------------
  // 5️⃣ Bounding Box → Pixel Box
  // -----------------------------
  const corners = [
    latLonToPixel(bboxQuery.minLat, bboxQuery.minLon),
    latLonToPixel(bboxQuery.minLat, bboxQuery.maxLon),
    latLonToPixel(bboxQuery.maxLat, bboxQuery.minLon),
    latLonToPixel(bboxQuery.maxLat, bboxQuery.maxLon)
  ];

  const minPx = Math.max(0, Math.min(...corners.map(c => c.px)));
  const maxPx = Math.min(width - 1, Math.max(...corners.map(c => c.px)));
  const minPy = Math.max(0, Math.min(...corners.map(c => c.py)));
  const maxPy = Math.min(height - 1, Math.max(...corners.map(c => c.py)));

  // -----------------------------
  // 6️⃣ Mittelwert (ECHTE mm/h)
  // -----------------------------
  let sum = 0;
  let count = 0;

  for (let y = minPy; y <= maxPy; y++) {
    for (let x = minPx; x <= maxPx; x++) {
      const v = precip[y * width + x];
      if (v > 0) {
        sum += v;
        count++;
      }
    }
  }

  const mmh = count ? sum / count : 0;

  // -----------------------------
  // 7️⃣ Ergebnis
  // -----------------------------
  const ts = new Date(frame.timestamp);

  result.mmh = mmh;
  result.timestamp = ts;

  if (mmh > 0) {
    result.startRain = ts;
    result.endRain = new Date(ts.getTime() + 5 * 60000);
    result.duration = 5;
  }

  return result;
}