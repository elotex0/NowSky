// api/vil-composite.js
//
// Serverless-Handler (Vercel/Next.js-Stil), der das DWD-Radar-Composite "VII"
// (Vertically Integrated Liquid / VIL, .hd5 / HDF5) lädt, dekodiert,
// in ein reguläres lat/lon-Raster reprojiziert und als georeferenziertes
// PNG (Base64) zurückgibt – fertig zum direkten Einbinden in Leaflet:
//
//   const data = await (await fetch("/api/vil-composite")).json();
//   L.imageOverlay(data.imageBase64, data.bounds, { opacity: 0.7 }).addTo(map);
//   // data.bounds = [[south, west], [north, east]]  (Leaflet-Format)
//
// Quelle: https://opendata.dwd.de/weather/radar/composite/vii/composite_VII_latest-hd5
//
// Vorher installieren:   npm install h5wasm pngjs proj4
//
// WICHTIG: Dieser Handler braucht eine Node.js-Laufzeit (kein Edge-Runtime),
// da h5wasm WebAssembly + Node-Filesystem-Bindings nutzt.
// Bei Vercel z.B. oben im File exportieren:
//   export const config = { runtime: "nodejs" };

import * as h5wasm from "h5wasm/node";
import { PNG } from "pngjs";
import proj4 from "proj4";

const VIL_URL =
  "https://opendata.dwd.de/weather/radar/composite/vii/composite_VII_latest-hd5";

// Breite/Höhe des Ausgabe-PNGs (reguläres lat/lon-Raster für Leaflet).
// Höher = schärfer, aber größere Base64-Antwort. 800x800 ist ein guter Mittelweg.
const OUT_WIDTH = 800;
const OUT_HEIGHT = 800;

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
 * Dekodiert eine ODIM-H5-Composite-Datei (Bytes) zu einem strukturierten Objekt
 * mit rohen Werten (raw uint16-Array bleibt erhalten, um beim Reprojizieren
 * Speicher/Zeit zu sparen statt vorher ein riesiges JS-Array zu bauen).
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
    const raw = dataDataset.value; // typed array, z.B. Uint16Array

    const gain = Number(dataWhat.gain ?? 1);
    const offset = Number(dataWhat.offset ?? 0);
    const nodata = Number(dataWhat.nodata);
    const undetect = Number(dataWhat.undetect);

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
      raw, // Uint16Array, Rohwerte (noch nicht dekodiert)
    };
  } finally {
    file.close();
    FS.unlink(virtualFilename);
  }
}

/**
 * Einfache Blau -> Cyan -> Gelb -> Rot Farbskala für VIL-Werte (kg/m²).
 * undetect (0 kg/m², also "gemessen aber kein Niederschlag") wird sehr
 * dezent dargestellt, nodata bleibt komplett transparent.
 */
function colorForValue(physVal, isUndetect, maxVal) {
  if (physVal === null) return [0, 0, 0, 0]; // nodata -> transparent
  if (isUndetect) return [0, 0, 90, 50]; // leichtes dunkelblau, fast transparent
  const t = Math.min(1, Math.max(0, physVal / maxVal));
  let r, g, b;
  if (t < 0.33) {
    const f = t / 0.33;
    r = 0; g = Math.round(255 * f); b = 255;
  } else if (t < 0.66) {
    const f = (t - 0.33) / 0.33;
    r = Math.round(255 * f); g = 255; b = Math.round(255 * (1 - f));
  } else {
    const f = (t - 0.66) / 0.34;
    r = 255; g = Math.round(255 * (1 - f)); b = 0;
  }
  return [r, g, b, 225];
}

/**
 * Reprojiziert das stereografische DWD-Raster auf ein reguläres lat/lon-Raster
 * und rendert es als PNG. Gibt { pngBuffer, bounds } zurück.
 * bounds = { south, west, north, east }  (WGS84, Grad)
 */
function renderToPng(composite) {
  const { rows, cols } = composite.shape;
  const { xscale, yscale, projdef, UL, UR, LL, LR } = composite.geo;
  const { raw, gain, offset, nodata, undetect } = composite;

  const proj = proj4("WGS84", projdef);

  // Projektions-Koordinaten der oberen linken Pixel-Ecke (Ursprung des Rasters)
  const [ulX, ulY] = proj.forward([UL.lon, UL.lat]);

  // Bounding Box in lat/lon: min/max der vier Eckpunkte, da eine
  // Stereoprojektion über diesem Gebiet kein perfektes Rechteck in lat/lon ergibt.
  const corners = [UL, UR, LL, LR];
  const south = Math.min(...corners.map((c) => c.lat));
  const north = Math.max(...corners.map((c) => c.lat));
  const west = Math.min(...corners.map((c) => c.lon));
  const east = Math.max(...corners.map((c) => c.lon));

  // Maximalwert für die Farbskala bestimmen (ohne nodata)
  let maxVal = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === nodata || raw[i] === undetect) continue;
    const v = raw[i] * gain + offset;
    if (v > maxVal) maxVal = v;
  }
  if (maxVal <= 0) maxVal = 1;

  const png = new PNG({ width: OUT_WIDTH, height: OUT_HEIGHT });

  for (let oy = 0; oy < OUT_HEIGHT; oy++) {
    const lat = north - (oy / (OUT_HEIGHT - 1)) * (north - south);
    for (let ox = 0; ox < OUT_WIDTH; ox++) {
      const lon = west + (ox / (OUT_WIDTH - 1)) * (east - west);
      const idx = (oy * OUT_WIDTH + ox) * 4;

      // lat/lon -> Projektions-Koordinaten -> Pixel-Index im Quellraster
      const [x, y] = proj.forward([lon, lat]);
      const col = Math.round((x - ulX) / xscale - 0.5);
      const row = Math.round((ulY - y) / yscale - 0.5);

      if (row < 0 || row >= rows || col < 0 || col >= cols) {
        png.data[idx] = 0; png.data[idx + 1] = 0; png.data[idx + 2] = 0; png.data[idx + 3] = 0;
        continue;
      }

      const rawVal = raw[row * cols + col];
      let physVal = null;
      let isUndetect = false;
      if (rawVal === nodata) {
        physVal = null;
      } else if (rawVal === undetect) {
        physVal = 0;
        isUndetect = true;
      } else {
        physVal = rawVal * gain + offset;
      }

      const [r, g, b, a] = colorForValue(physVal, isUndetect, maxVal);
      png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = a;
    }
  }

  const pngBuffer = PNG.sync.write(png);
  return { pngBuffer, bounds: { south, west, north, east }, maxVal };
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
    const { pngBuffer, bounds, maxVal } = renderToPng(composite);

    return res.status(200).json({
      meta: composite.meta,
      product: composite.product,
      quantity: composite.quantity, // "VIL"
      unit: "kg/m^2",
      maxValueInScale: Math.round(maxVal * 100) / 100,
      // Leaflet-Format: [[south, west], [north, east]]
      bounds: [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      ],
      imageWidth: OUT_WIDTH,
      imageHeight: OUT_HEIGHT,
      imageBase64: `data:image/png;base64,${pngBuffer.toString("base64")}`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
