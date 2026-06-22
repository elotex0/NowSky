// api/hail-point.js
//
// Serverless-Handler (Vercel/Next.js-Stil), der das DWD-Radar-Composite "VII"
// (Vertically Integrated Liquid / VIL, .hd5 / HDF5) lädt und den VIL-Wert
// als hail_cm-Schätzung für einen einzelnen geografischen Punkt zurückgibt.
//
// Aufruf:
//   GET /api/hail-point?lat=48.137&lon=11.575
//
// Antwort (Beispiel):
//   {
//     "lat": 48.137,
//     "lon": 11.575,
//     "hail_cm": 2.4,       // null = kein Niederschlag erkannt (undetect)
//                           // -1   = kein Messwert vorhanden  (nodata)
//     "unit": "cm",
//     "quantity": "VIL",
//     "meta": { ... },
//     "product": { ... }
//   }
//
// Quelle: https://opendata.dwd.de/weather/radar/composite/vii/composite_VII_latest-hd5
//
// Vorher installieren:   npm install h5wasm proj4
//
// WICHTIG: Node.js-Laufzeit erforderlich (kein Edge-Runtime).
// Bei Vercel:
//   export const config = { runtime: "nodejs" };

import * as h5wasm from "h5wasm/node";
import proj4 from "proj4";

export const config = { runtime: "nodejs" };

const VIL_URL =
  "https://opendata.dwd.de/weather/radar/composite/vii/composite_VII_latest-hd5";

// ── HDF5-Hilfsfunktionen ────────────────────────────────────────────────────

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

// ── HDF5 dekodieren ─────────────────────────────────────────────────────────

async function decodeDwdComposite(bytes) {
  await ensureH5Ready();

  const virtualFilename = `/tmp/vil_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}.hd5`;
  const { FS } = h5wasm;
  FS.writeFile(virtualFilename, bytes);

  const file = new h5wasm.File(virtualFilename, "r");
  try {
    const root    = readAllAttrs(file);
    const what    = readAllAttrs(file.get("what"));
    const where   = readAllAttrs(file.get("where"));

    const ds1     = file.get("dataset1");
    const ds1What = readAllAttrs(ds1.get("what"));
    const ds1How  = readAllAttrs(ds1.get("how"));

    const data1       = ds1.get("data1");
    const dataDataset = data1.get("data");
    const dataWhat    = readAllAttrs(data1.get("what"));

    const shape = dataDataset.shape.map((n) => Number(n)); // [rows, cols]
    const raw   = dataDataset.value;                        // z.B. Uint16Array

    return {
      meta: {
        conventions: root.Conventions,
        date:        what.date,
        time:        what.time,
        object:      what.object,
        source:      what.source,
        version:     what.version,
      },
      geo: {
        LL:      { lat: where.LL_lat, lon: where.LL_lon },
        LR:      { lat: where.LR_lat, lon: where.LR_lon },
        UL:      { lat: where.UL_lat, lon: where.UL_lon },
        UR:      { lat: where.UR_lat, lon: where.UR_lon },
        xsize:   where.xsize,
        ysize:   where.ysize,
        xscale:  where.xscale,
        yscale:  where.yscale,
        projdef: where.projdef,
      },
      product: {
        prodname:  ds1What.prodname,
        product:   ds1What.product,
        startdate: ds1What.startdate,
        starttime: ds1What.starttime,
        enddate:   ds1What.enddate,
        endtime:   ds1What.endtime,
        camethod:  ds1How?.camethod,
      },
      quantity: dataWhat.quantity,
      gain:     Number(dataWhat.gain   ?? 1),
      offset:   Number(dataWhat.offset ?? 0),
      nodata:   Number(dataWhat.nodata),
      undetect: Number(dataWhat.undetect),
      shape:    { rows: shape[0], cols: shape[1] },
      raw,
    };
  } finally {
    file.close();
    FS.unlink(virtualFilename);
  }
}

// ── Punkt-Lookup ─────────────────────────────────────────────────────────────

/**
 * Gibt den physikalischen Wert für einen lat/lon-Punkt zurück.
 *
 * Rückgabe:
 *   { hail_cm: number }   – gemessener Wert
 *   { hail_cm: null }     – undetect (kein Niederschlag erkannt)
 *   { hail_cm: -1 }       – nodata (Punkt außerhalb Messbereich)
 */
function lookupPoint(composite, lat, lon) {
  const { rows, cols } = composite.shape;
  const { xscale, yscale, projdef, UL } = composite.geo;
  const { raw, gain, offset, nodata, undetect } = composite;

  // Projektion: WGS84 → stereografisches DWD-Raster
  const proj       = proj4("WGS84", projdef);
  const [ulX, ulY] = proj.forward([UL.lon, UL.lat]);
  const [x, y]     = proj.forward([lon, lat]);

  // Pixel-Index im Quellraster
  const col = Math.round((x - ulX) / xscale - 0.5);
  const row = Math.round((ulY - y) / yscale - 0.5);

  if (row < 0 || row >= rows || col < 0 || col >= cols) {
    return { hail_cm: -1, reason: "Punkt liegt außerhalb des Radar-Composites" };
  }

  const rawVal = raw[row * cols + col];

  if (rawVal === nodata) {
    return { hail_cm: -1, reason: "nodata – kein Messwert für diesen Punkt" };
  }
  if (rawVal === undetect) {
    return { hail_cm: null, reason: "undetect – kein Niederschlag gemessen" };
  }

  const physVal = rawVal * gain + offset;
  return { hail_cm: Math.round(physVal * 100) / 100 };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Parameter validieren ──────────────────────────────────────────────────
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({
      error: "Fehlende oder ungültige Parameter. Bitte ?lat=XX.XX&lon=YY.YY angeben.",
    });
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({
      error: "lat muss zwischen -90 und 90, lon zwischen -180 und 180 liegen.",
    });
  }

  // ── DWD-Datei laden ───────────────────────────────────────────────────────
  try {
    const dwdRes = await fetch(VIL_URL);
    if (!dwdRes.ok) {
      return res.status(502).json({
        error: `DWD-Daten konnten nicht geladen werden (HTTP ${dwdRes.status})`,
      });
    }

    const buf       = await dwdRes.arrayBuffer();
    const composite = await decodeDwdComposite(new Uint8Array(buf));
    const result    = lookupPoint(composite, lat, lon);

    return res.status(200).json({
      lat,
      lon,
      ...result,
      unit:     "cm",
      quantity: composite.quantity,
      meta:     composite.meta,
      product:  composite.product,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
