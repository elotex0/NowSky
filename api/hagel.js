// api/hail-point.js
//
// GET /api/hail-point?lat=48.137&lon=11.575
// Antwort: { "lat": 48.137, "lon": 11.575, "hail_cm": 2.4 }
//          hail_cm = null  → undetect (kein Niederschlag)
//          hail_cm = -1    → nodata / außerhalb Messbereich
//

import * as h5wasm from "h5wasm/node";
import proj4 from "proj4";

export const config = { runtime: "nodejs" };

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
  if (!node?.attrs) return out;
  for (const name of Object.keys(node.attrs)) {
    out[name] = readAttr(node.attrs, name);
  }
  return out;
}

async function decodeDwdComposite(bytes) {
  await ensureH5Ready();

  const fname = `/tmp/vil_${Date.now()}.hd5`;
  const { FS } = h5wasm;
  FS.writeFile(fname, bytes);

  const file = new h5wasm.File(fname, "r");
  try {
    const where    = readAllAttrs(file.get("where"));
    const data1    = file.get("dataset1/data1");
    const dataWhat = readAllAttrs(data1.get("what"));
    const dataset  = data1.get("data");
    const shape    = dataset.shape.map(Number);
    const raw      = dataset.value; // Uint16Array

    // nodata/undetect als INTEGER speichern – Vergleich mit rawVal (uint16)
    const nodata   = Math.round(Number(dataWhat.nodata));    // 65535
    const undetect = Math.round(Number(dataWhat.undetect));  // 0

    return {
      geo: {
        UL:      { lat: where.UL_lat, lon: where.UL_lon },
        xscale:  where.xscale,
        yscale:  where.yscale,
        projdef: where.projdef,
      },
      gain:     Number(dataWhat.gain),
      offset:   Number(dataWhat.offset),
      nodata,
      undetect,
      rows:     shape[0],
      cols:     shape[1],
      raw,
    };
  } finally {
    file.close();
    FS.unlink(fname);
  }
}

function lookupPoint(c, lat, lon) {
  const proj       = proj4("WGS84", c.geo.projdef);
  const [ulX, ulY] = proj.forward([c.geo.UL.lon, c.geo.UL.lat]);
  const [x, y]     = proj.forward([lon, lat]);

  const col = Math.round((x - ulX) / c.geo.xscale - 0.5);
  const row = Math.round((ulY - y) / c.geo.yscale - 0.5);

  if (row < 0 || row >= c.rows || col < 0 || col >= c.cols) {
    return -1; // außerhalb
  }

  const rawVal = c.raw[row * c.cols + col];

  if (rawVal === c.nodata)   return -1;   // 65535 → kein Messwert
  if (rawVal === c.undetect) return null; // 0     → kein Niederschlag

  return Math.round((rawVal * c.gain + c.offset) * 100) / 100;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: "?lat=XX.XX&lon=YY.YY erforderlich" });
  }

  try {
    const dwdRes = await fetch(VIL_URL);
    if (!dwdRes.ok) {
      return res.status(502).json({ error: `DWD HTTP ${dwdRes.status}` });
    }

    const composite = await decodeDwdComposite(new Uint8Array(await dwdRes.arrayBuffer()));
    const hail_cm   = lookupPoint(composite, lat, lon);

    return res.status(200).json({ lat, lon, hail_cm });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
