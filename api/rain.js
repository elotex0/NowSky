// /api/rain.js

import pako from "pako";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { lat, lng } = req.query;

  if (!lat || !lng) {
    res.status(400).json({ error: 'lat and lng are required' });
    return;
  }

  try {
    const forecast = await getRainForecast(parseFloat(lat), parseFloat(lng));
    res.status(200).json(forecast);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}

let rainForecastData = {};

async function getRainForecast(lat, lng) {
  rainForecastData = {
    results: [],
    times: [],
    startRain: null,
    endRain: null,
    duration: 0,
    perMinute: [],
    perMinuteTimes: []
  };

  // 1 km Bounding Box berechnen
  const deltaLat = 0.009;
  const deltaLon = 0.014 / Math.cos(lat * Math.PI / 180);

  const bbox = {
    minLat: lat - deltaLat/2,
    maxLat: lat + deltaLat/2,
    minLon: lng - deltaLon/2,
    maxLon: lng + deltaLon/2
  };

  // Bright Sky Radar holen (direkt mit lat/lon)
  const url = `https://api.brightsky.dev/radar?lat=${lat}&lon=${lng}`;
  const radarRes = await fetch(url);
  const radarJson = await radarRes.json();

  if (!radarJson.radar || radarJson.radar.length === 0) {
    throw new Error("No radar data available");
  }

  const radarFrame = radarJson.radar[0];

  // Dekompression 16-bit -> mm/h
  function decompress(raw, factor = 0.1) {
    const compressed = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    const rawBytes = pako.inflate(compressed).buffer;
    const u16 = new Uint16Array(rawBytes);
    const data = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) data[i] = u16[i] * factor;
    return data;
  }

  const precipData = decompress(radarFrame.precipitation_5, 0.1);
  const width = radarFrame.width;
  const height = radarFrame.height;

  // Lat/Lon -> Pixel
  function latLonToPixel(lat, lon) {
    const radolanOriginX = -523462.5;
    const radolanOriginY = 4658576.5;
    const pixelSize = 1000; // 1 km
    const R = 6370040;
    const φ = lat * Math.PI / 180;
    const λ = lon * Math.PI / 180;
    const φ0 = 60 * Math.PI / 180;
    const λ0 = 10 * Math.PI / 180;
    const t = Math.tan(Math.PI / 4 - φ / 2);
    const t0 = Math.tan(Math.PI / 4 - φ0 / 2);
    const x = R * (λ - λ0);
    const y = R * Math.log(t0 / t);
    const px = Math.floor((x - radolanOriginX) / pixelSize);
    const py = Math.floor((radolanOriginY - y) / pixelSize);
    return { px, py };
  }

  // Bounding Box Pixel
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

  // Mittelwert über Box (echte mm/h!)
  let sum = 0, count = 0;
  for (let y = minPy; y <= maxPy; y++) {
    for (let x = minPx; x <= maxPx; x++) {
      const idx = y * width + x;
      sum += precipData[idx];
      count++;
    }
  }
  const mmh = count > 0 ? sum / count : 0;

  // Ergebnis speichern
  const now = new Date();
  now.setMinutes(Math.floor(now.getMinutes()/5)*5, 0, 0);
  rainForecastData.results.push(mmh);
  rainForecastData.times.push(now);

  // Per-Minute Interpolation
  const realNow = new Date();
  const offsetMinutes = ((realNow.getMinutes() % 5) * 60 + realNow.getSeconds()) / 60;

  function buildPerMinuteForecast(results, startOffsetMinutes, startTime) {
    const minuteValues = [];
    const minuteTimes = [];
    let pos = startOffsetMinutes;

    for (let m = 0; m <= 60; m++) {
      const segIndex = Math.floor(pos / 5);
      let value = 0;
      if (segIndex >= results.length - 1) value = results[results.length - 1];
      else value = results[segIndex] + (results[segIndex+1] - results[segIndex]) * ((pos - segIndex*5)/5);
      minuteValues.push(value);
      minuteTimes.push(new Date(startTime.getTime() + pos*60000));
      pos++;
    }

    return { values: minuteValues, times: minuteTimes };
  }

  if (rainForecastData.results.length >= 1) {
    const interp = buildPerMinuteForecast(rainForecastData.results, offsetMinutes, now);
    rainForecastData.perMinute = interp.values;
    rainForecastData.perMinuteTimes = interp.times;
  }

  // Start & Ende Regen
  if (rainForecastData.perMinute.length > 0) {
    const startIdx = rainForecastData.perMinute.findIndex(v => v > 0);
    if (startIdx !== -1) {
      let endIdx = startIdx;
      for (let i = startIdx; i < rainForecastData.perMinute.length; i++) {
        if (rainForecastData.perMinute[i] > 0) endIdx = i;
        else break;
      }
      rainForecastData.startRain = rainForecastData.perMinuteTimes[startIdx];
      rainForecastData.endRain = rainForecastData.perMinuteTimes[endIdx];
      rainForecastData.duration = endIdx - startIdx + 1;
    }
  }

  return rainForecastData;
}}
