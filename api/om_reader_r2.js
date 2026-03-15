// om_reader_r2.js
import { inflateSync } from "zlib";

const OM_URL  = "https://pub-76dea2a1875e47eab49e15efb5bcff2b.r2.dev/warnmos/13/warnmos_2026031513.om";
const IDX_URL = "https://pub-76dea2a1875e47eab49e15efb5bcff2b.r2.dev/warnmos/13/warnmos_2026031513.om.idx";

export class OMFileR2 {
  constructor() {
    this.blocks = null;
  }

  async init() {
    if (this.blocks) return;
    const idxRes = await fetch(IDX_URL);
    if (!idxRes.ok) throw new Error(`IDX fetch failed: ${idxRes.status}`);
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

    const res = await fetch(OM_URL, {
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
