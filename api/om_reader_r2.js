// om_reader_r2.js
import { inflateSync } from "zlib";

const BASE_SHORT = "https://pub-76dea2a1875e47eab49e15efb5bcff2b.r2.dev/warnmos";
const BASE_LONG  = "https://pub-76dea2a1875e47eab49e15efb5bcff2b.r2.dev/warnmoslong";
const LONG_RUNS  = new Set(["04", "09", "16", "21"]);

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

export class OMFileR2 {
  constructor() {
    this.blocksShort    = null;
    this.blocksLong     = null;
    this.omUrlShort     = null;
    this.omUrlLong      = null;
    this.generatedShort = null;
    this.generatedLong  = null;
  }

  async _loadSource(baseUrl) {
    const metaRes = await fetch(`${baseUrl}/metadata.json`);
    if (!metaRes.ok) throw new Error(`metadata.json fetch failed: ${metaRes.status} – ${baseUrl}/metadata.json`);
    const metadata = await metaRes.json();

    if (!metadata.runs || metadata.runs.length === 0) {
      throw new Error(`Keine Runs in metadata.json: ${baseUrl}`);
    }

    const latest = metadata.runs[metadata.runs.length - 1];
    const omUrl  = `${baseUrl}/${latest.run}/${latest.file}.om`;
    const idxUrl = `${baseUrl}/${latest.run}/${latest.file}.om.idx`;

    const idxRes = await fetch(idxUrl);
    if (!idxRes.ok) throw new Error(`IDX fetch failed: ${idxRes.status} – ${idxUrl}`);
    const blocks = await idxRes.json();

    return { omUrl, blocks, generatedAt: metadata.generatedAt };
  }

  async init() {
    if (this.blocksShort && this.blocksLong) return;

    const [short, long] = await Promise.all([
      this._loadSource(BASE_SHORT),
      this._loadSource(BASE_LONG),
    ]);

    this.omUrlShort     = short.omUrl;
    this.blocksShort    = short.blocks;
    this.generatedShort = short.generatedAt;
    this.omUrlLong      = long.omUrl;
    this.blocksLong     = long.blocks;
    this.generatedLong  = long.generatedAt;
  }

  _getChunkIndex(header, lat, lon) {
    const { nx, chunk, latMin, latMax, lonMin, lonMax } = header;
    const dlon = (lonMax - lonMin) / (nx - 1);
    const dlat = (latMax - latMin) / (nx - 1);

    let gx = Math.round((lon - lonMin) / dlon);
    let gy = Math.round((lat - latMin) / dlat);
    gx = Math.min(Math.max(gx, 0), nx - 1);
    gy = Math.min(Math.max(gy, 0), nx - 1);

    const chunksPerRow = Math.ceil(nx / chunk);
    const chunkIndex   = Math.floor(gy / chunk) * chunksPerRow + Math.floor(gx / chunk);
    const lx = gx % chunk;
    const ly = gy % chunk;

    return { chunkIndex, lx, ly, chunk };
  }

  async _fetchAllChunks(omUrl, blocks, lat, lon) {
    if (blocks.length === 0) return {};

    const { chunkIndex, lx, ly, chunk } =
      this._getChunkIndex(blocks[0].header, lat, lon);

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
    if (!res.ok && res.status !== 206) {
      throw new Error(`Bulk chunk fetch failed: ${res.status} – ${omUrl}`);
    }

    const blob = Buffer.from(await res.arrayBuffer());

    const result = {};
    for (const r of ranges) {
      const start        = r.offset - minOffset;
      const slice        = blob.subarray(start, start + r.len);
      const decompressed = inflateSync(slice);
      const arr          = new Float32Array(
        decompressed.buffer,
        decompressed.byteOffset,
        decompressed.byteLength / 4
      );
      result[r.timestamp] = arr[ly * chunk + lx];
    }

    return result;
  }

  async getAllForPoint(lat, lon, interpolate = true) {
    await this.init();

    const [shortResult, longResult] = await Promise.all([
      this._fetchAllChunks(this.omUrlShort, this.blocksShort, lat, lon),
      this._fetchAllChunks(this.omUrlLong,  this.blocksLong,  lat, lon),
    ]);

    // Aktuellen Short-Run aus URL extrahieren z.B. /13/warnmos_2026031513.om → "13"
    const runMatch   = this.omUrlShort.match(/\/(\d{2})\/warnmos_/);
    const currentRun = runMatch ? runMatch[1] : null;
    console.log("omUrlShort:", this.omUrlShort);
    console.log("currentRun:", currentRun);
    console.log("isLongRun:", LONG_RUNS.has(currentRun));

    let merged;
    if (LONG_RUNS.has(currentRun)) {
      // Run 04/09/16/21 → Long hat Vorrang für alle Timestamps
      merged = { ...shortResult, ...longResult };
    } else {
      // Normale Stunden → Short hat Vorrang für erste 24h
      merged = { ...longResult, ...shortResult };
    }

    const sorted = Object.fromEntries(
      Object.entries(merged).sort(([a], [b]) => new Date(a) - new Date(b))
    );

    return {
      data:           interpolate ? interpolateHourly(sorted) : sorted,
      generatedShort: this.generatedShort,
      generatedLong:  this.generatedLong,
      currentRun:     currentRun,
      source:         LONG_RUNS.has(currentRun) ? "long" : "short",
    };
  }

  getTimestamps() {
    if (!this.blocksShort) throw new Error("init() noch nicht aufgerufen");
    const shortTs = new Set(this.blocksShort.map((b) => b.header.timestamp));
    const longTs  = this.blocksLong
      .map((b) => b.header.timestamp)
      .filter((ts) => !shortTs.has(ts));
    return [...shortTs, ...longTs].sort((a, b) => new Date(a) - new Date(b));
  }
}
