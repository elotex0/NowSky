// om_reader_r2.js
import { inflateSync } from "zlib";

const BASE_URL    = "https://pub-76dea2a1875e47eab49e15efb5bcff2b.r2.dev/warnmos";
const METADATA_URL = `${BASE_URL}/metadata.json`;

export class OMFileR2 {
  constructor() {
    this.blocks = null;
    this.omUrl  = null;
    this.idxUrl = null;
  }

  async init() {
    if (this.blocks) return;

    // 1. Metadata laden → aktuelle Run + Dateiname
    const metaRes = await fetch(METADATA_URL);
    if (!metaRes.ok) throw new Error(`metadata.json fetch failed: ${metaRes.status}`);
    const metadata = await metaRes.json();

    if (!metadata.runs || metadata.runs.length === 0) {
      throw new Error("Keine Runs in metadata.json gefunden");
    }

    // Neuesten Run nehmen
    const latest = metadata.runs[metadata.runs.length - 1];
    const run    = latest.run;
    const file   = latest.file;

    this.omUrl  = `${BASE_URL}/${run}/${file}.om`;
    this.idxUrl = `${BASE_URL}/${run}/${file}.om.idx`;

    console.log(`Aktueller Run: ${run} → ${this.omUrl}`);

    // 2. IDX laden
    const idxRes = await fetch(this.idxUrl);
    if (!idxRes.ok) throw new Error(`IDX fetch failed: ${idxRes.status} – URL: ${this.idxUrl}`);
    this.blocks = await idxRes.json();
    console.log(`Index geladen: ${this.blocks.length} Blocks`);
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

  async getAllForPoint(lat, lon) {
    await this.init();
    if (this.blocks.length === 0) return {};

    const { chunkIndex, lx, ly, chunk } =
      this._getChunkIndex(this.blocks[0].header, lat, lon);

    const ranges = this.blocks.map((b) => ({
      timestamp: b.header.timestamp,
      offset:    b.chunkOffsets[chunkIndex] + 4,
      len:       b.chunkLens[chunkIndex],
    }));

    const minOffset = Math.min(...ranges.map((r) => r.offset));
    const maxOffset = Math.max(...ranges.map((r) => r.offset + r.len));

    const res = await fetch(this.omUrl, {
      headers: { Range: `bytes=${minOffset}-${maxOffset - 1}` },
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`Bulk chunk fetch failed: ${res.status}`);
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

  getTimestamps() {
    if (!this.blocks) throw new Error("init() noch nicht aufgerufen");
    return this.blocks.map((b) => b.header.timestamp);
  }
}
