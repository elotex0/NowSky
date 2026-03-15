// api/thunderstorm.js
import { decompressSync } from "fflate";

export const config = { runtime: "edge" };

const BASE_SHORT = "https://pub-76dea2a1875e47eab49e15efb5bcff2b.r2.dev/warnmos";
const BASE_LONG  = "https://pub-76dea2a1875e47eab49e15efb5bcff2b.r2.dev/warnmoslong";

function interpolateHourly(data) {
  const entries = Object.entries(data)
    .map(([ts, val]) => ({ ts: new Date(ts), val }))
    .sort((a, b) => a.ts - b.ts);

  if (entries.length === 0) return {};

  const result = {};
  const first = entries[0].ts;
  const last  = entries[entries.length - 1].ts;

  for (let t = new Date(first); t <= last; t = new Date(t.getTime() + 3600000)) {
    const tsStr = t.toISOString().replace("T", " ").substring(0, 19);
    const exact = entries.find(e => e.ts.getTime() === t.getTime());
    if (exact) { result[tsStr] = exact.val; continue; }
    const before = [...entries].reverse().find(e => e.ts < t);
    const after  = entries.find(e => e.ts > t);
    if (!before) { result[tsStr] = after.val;  continue; }
    if (!after)  { result[tsStr] = before.val; continue; }
    const ratio = (t - before.ts) / (after.ts - before.ts);
    result[tsStr] = Math.round(before.val + ratio * (after.val - before.val));
  }

  return result;
}

async function loadSource(baseUrl) {
  const metaRes = await fetch(`${baseUrl}/metadata.json`);
  if (!metaRes.ok) throw new Error(`metadata.json fetch failed: ${metaRes.status} – ${baseUrl}/metadata.json`);
  const metadata = await metaRes.json();
  if (!metadata.runs || metadata.runs.length === 0) throw new Error(`Keine Runs: ${baseUrl}`);

  const latest = metadata.runs[metadata.runs.length - 1];
  const omUrl  = `${baseUrl}/${latest.run}/${latest.file}.om`;
  const idxUrl = `${baseUrl}/${latest.run}/${latest.file}.om.idx`;

  const idxRes = await fetch(idxUrl);
  if (!idxRes.ok) throw new Error(`IDX fetch failed: ${idxRes.status} – ${idxUrl}`);
  const blocks = await idxRes.json();

  return { omUrl, blocks };
}

function getChunkIndex(header, lat, lon) {
  const { nx, chunk, latMin, latMax, lonMin, lonMax } = header;
  const dlon = (lonMax - lonMin) / (nx - 1);
  const dlat = (latMax - latMin) / (nx - 1);

  let gx = Math.round((lon - lonMin) / dlon);
  let gy = Math.round((lat - latMin) / dlat);
  gx = Math.min(Math.max(gx, 0), nx - 1);
  gy = Math.min(Math.max(gy, 0), nx - 1);

  const chunksPerRow = Math.ceil(nx / chunk);
  const chunkIndex   = Math.floor(gy / chunk) * chunksPerRow + Math.floor(gx / chunk);
  return { chunkIndex, lx: gx % chunk, ly: gy % chunk, chunk };
}

async function fetchAllChunks(omUrl, blocks, lat, lon) {
  if (blocks.length === 0) return {};

  const { chunkIndex, lx, ly, chunk } = getChunkIndex(blocks[0].header, lat, lon);

  const ranges = blocks.map((b) => ({
    timestamp: b.header.timestamp,
    offset:    b.chunkOffsets[chunkIndex] + 4,
    len:       b.chunkLens[chunkIndex],
  }));

  const minOffset = Math.min(...ranges.map((r) => r.offset));
  const maxOffset = Math.max(...ranges.map((r) => r.offset + r.len));

  const res = await fetch(omUrl, {
    headers: { Range: `bytes=${minOffset}-${maxOffset - 1}` },
  });
  if (!res.ok && res.status !== 206) throw new Error(`Chunk fetch failed: ${res.status}`);

  const blob = new Uint8Array(await res.arrayBuffer());

  const result = {};
  for (const r of ranges) {
    const start        = r.offset - minOffset;
    const slice        = blob.slice(start, start + r.len);
    const decompressed = decompressSync(slice);
    const arr          = new Float32Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength / 4);
    result[r.timestamp] = arr[ly * chunk + lx];
  }

  return result;
}

export default async function handler(req) {
  const { method } = req;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age":       "86400",
      },
    });
  }

  const { searchParams } = new URL(req.url);
  const lat         = parseFloat(searchParams.get("lat"));
  const lon         = parseFloat(searchParams.get("lon"));
  const interpolate = searchParams.get("interpolate") !== "false";

  if (isNaN(lat) || isNaN(lon)) {
    return new Response(JSON.stringify({ error: "lat and lon required" }), {
      status: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const [short, long] = await Promise.all([
      loadSource(BASE_SHORT),
      loadSource(BASE_LONG),
    ]);

    const [shortResult, longResult] = await Promise.all([
      fetchAllChunks(short.omUrl, short.blocks, lat, lon),
      fetchAllChunks(long.omUrl,  long.blocks,  lat, lon),
    ]);

    // Short hat Vorrang bei Duplikaten
    const merged = { ...longResult, ...shortResult };
    const sorted = Object.fromEntries(
      Object.entries(merged).sort(([a], [b]) => new Date(a) - new Date(b))
    );
    const allResults = interpolate ? interpolateHourly(sorted) : sorted;

    // UTC → Berlin
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    const pad = (n) => String(n).padStart(2, "0");
    const currentHourStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:00:00`;
    const in24h    = new Date(now.getTime() + 24 * 3600000);
    const in24hStr = `${in24h.getFullYear()}-${pad(in24h.getMonth() + 1)}-${pad(in24h.getDate())} ${pad(in24h.getHours())}:00:00`;

    // Timestamps -1h verschieben
    const shifted = {};
    for (const [ts, val] of Object.entries(allResults)) {
      const d = new Date(ts.replace(" ", "T"));
      d.setHours(d.getHours() - 1);
      const newTs = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00:00`;
      shifted[newTs] = val;
    }

    // Nächste 24h
    const hourly = Object.fromEntries(
      Object.entries(shifted).filter(([ts]) => ts >= currentHourStr && ts <= in24hStr)
    );

    // Tages-Maxima ab heute
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const dailyMax = {};
    for (const [ts, val] of Object.entries(shifted)) {
      const day = ts.substring(0, 10);
      if (day < todayStr) continue;
      if (dailyMax[day] === undefined || val > dailyMax[day]) dailyMax[day] = val;
    }

    return new Response(JSON.stringify({
      W_GEW_01: { hourly, daily: dailyMax },
      meta: {
        lat,
        lon,
        timestepsHourly: Object.keys(hourly).length,
        timestepsDaily:  Object.keys(dailyMax).length,
        interpolated:    interpolate,
        from:            currentHourStr,
        to:              in24hStr,
      },
    }), {
      status: 200,
      headers: {
        "Content-Type":              "application/json",
        "Cache-Control":             "public, max-age=0, s-maxage=3600, stale-while-revalidate=0",
        "Access-Control-Allow-Origin": "*",
      },
    });

  } catch (err) {
    console.error("thunderstorm error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
}
