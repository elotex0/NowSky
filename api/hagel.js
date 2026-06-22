// api/vil-composite.js
//
// Serverless-Handler (Vercel/Next.js-Stil), der das DWD-Radar-Composite "VII"
// (Vertically Integrated Liquid / VIL, .hd5 / HDF5) lädt, dekodiert und als
// JSON zurückgibt.
//
// Quelle: https://opendata.dwd.de/weather/radar/composite/vii/composite_VII_latest-hd5
//
// Vorher installieren:   npm install h5wasm
//
// WICHTIG: Dieser Handler braucht eine Node.js-Laufzeit (kein Edge-Runtime),
// da h5wasm WebAssembly + Node-Filesystem-Bindings nutzt.
// Bei Vercel z.B. oben im File exportieren:
//   export const config = { runtime: "nodejs" };

import * as h5wasm from "h5wasm/node";

const VIL_URL =
  "https://opendata.dwd.de/weather/radar/composite/vii/composite_VII_latest-hd5";

let h5ready = null;
function ensureH5Ready() {
  if (!h5ready) h5ready = h5wasm.ready;
  return h5ready;
}

function readAttr(attrs, name) {
  if (!attrs || !(name in attrs)) return undefined;
  let val = attrs[name].value;
  if (Array.isArray(val) && val.length === 1) val = val[0];
  if (typeof val === "bigint") val = Number(val);
  return val;
}

function readAllAttrs(node) {
  const out = {};
  if (!node || !node.attrs) return out;
  for (const name of Object.keys(node.attrs)) {
    out[name] = readAttr(node.attrs, name);
  }
  return out;
}

/**
 * Dekodiert eine ODIM-H5-Composite-Datei (Bytes) zu einem strukturierten Objekt.
 * @param {Uint8Array} bytes
 */
async function decodeDwdComposite(bytes) {
  await ensureH5Ready();

  const virtualFilename = `/tmp/composite_${Date.now()}_${Math.random().toString(36).slice(2)}.hd5`;
  const { FS } = h5wasm;
  FS.writeFile(virtualFilename, bytes);

  const file = new h5wasm.File(virtualFilename, "r");
  try {
    const root = readAllAttrs(file);
    const what = readAllAttrs(file.get("what"));
    const where = readAllAttrs(file.get("where"));
    const how = readAllAttrs(file.get("how"));

    const ds1 = file.get("dataset1");
    const ds1What = readAllAttrs(ds1.get("what"));
    const ds1How = readAllAttrs(ds1.get("how"));

    const data1 = ds1.get("data1");
    const dataDataset = data1.get("data");
    const dataWhat = readAllAttrs(data1.get("what"));

    const shape = dataDataset.shape.map((n) => Number(n)); // [rows, cols]
    const raw = dataDataset.value; // z.B. Uint16Array

    const gain = Number(dataWhat.gain ?? 1);
    const offset = Number(dataWhat.offset ?? 0);
    const nodata = Number(dataWhat.nodata);
    const undetect = Number(dataWhat.undetect);

    // physikalischer Wert = raw * gain + offset; nodata -> null, undetect -> 0
    const values = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      if (v === nodata) values[i] = null;
      else if (v === undetect) values[i] = 0;
      else values[i] = Math.round((v * gain + offset) * 1000) / 1000;
    }

    return {
      meta: {
        conventions: root.Conventions,
        date: what.date,
        time: what.time,
        object: what.object,
        source: what.source,
        version: what.version,
      },
      geo: {
        LL: { lat: where.LL_lat, lon: where.LL_lon },
        LR: { lat: where.LR_lat, lon: where.LR_lon },
        UL: { lat: where.UL_lat, lon: where.UL_lon },
        UR: { lat: where.UR_lat, lon: where.UR_lon },
        xsize: where.xsize,
        ysize: where.ysize,
        xscale: where.xscale,
        yscale: where.yscale,
        projdef: where.projdef,
      },
      product: {
        prodname: ds1What.prodname,
        product: ds1What.product,
        startdate: ds1What.startdate,
        starttime: ds1What.starttime,
        enddate: ds1What.enddate,
        endtime: ds1What.endtime,
        camethod: ds1How.camethod,
      },
      quantity: dataWhat.quantity,
      gain,
      offset,
      nodata,
      undetect,
      shape: { rows: shape[0], cols: shape[1] },
      nodes: how.nodes,
      values, // flaches Array, row-major, length = rows*cols, null = nodata
    };
  } finally {
    file.close();
    FS.unlink(virtualFilename);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const dwdRes = await fetch(VIL_URL);
    if (!dwdRes.ok) {
      return res.status(502).json({ error: "DWD-Daten konnten nicht geladen werden" });
    }

    const buf = await dwdRes.arrayBuffer();
    const composite = await decodeDwdComposite(new Uint8Array(buf));

    return res.status(200).json(composite);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
