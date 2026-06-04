// api/konrad3d.js
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as turf from "@turf/turf";
import rbush from "rbush";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Schneller String-Parser (indexOf, unterstützt Tags mit und ohne Attribute) ─
const textFast = (xml, tag) => {
  const open = `<${tag}`;
  const s = xml.indexOf(open);
  if (s === -1) return null;
  // Sicherstellen dass es wirklich dieser Tag ist (kein Prefix-Match wie <latitude_x>)
  const charAfter = xml[s + open.length];
  if (charAfter !== ">" && charAfter !== " " && charAfter !== "\t" && charAfter !== "\n" && charAfter !== "\r") return null;
  const bodyStart = xml.indexOf(">", s);
  if (bodyStart === -1) return null;
  // Self-closing Tag (<tag />) → kein Inhalt
  if (xml[bodyStart - 1] === "/") return null;
  const closeTag = `</${tag}>`;
  const e = xml.indexOf(closeTag, bodyStart);
  return e === -1 ? null : xml.slice(bodyStart + 1, e).trim();
};

const numFast = (xml, tag) => {
  const v = textFast(xml, tag);
  return v !== null && v !== "" && !isNaN(v) ? parseFloat(v) : null;
};

const intFast = (xml, tag) => {
  const v = textFast(xml, tag);
  if (v === null || v === "") return null;
  const n = parseInt(v);
  return n === -1000000000 ? null : n;
};

// Regex-Fallback für Tags wo textFast nicht reicht (z.B. Attribut-Wert lesen)
const textAttr = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}(?:[^>]*)>([^<]*)<\\/${tag}>`));
  return m ? m[1].trim() : null;
};
const numAttr = (xml, tag) => {
  const v = textAttr(xml, tag);
  return v !== null && v !== "" && !isNaN(v) ? parseFloat(v) : null;
};
const intAttr = (xml, tag) => {
  const v = textAttr(xml, tag);
  if (v === null || v === "") return null;
  const n = parseInt(v);
  return n === -1000000000 ? null : n;
};

const _isTagBoundary = (c) => c === ">" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === "/";

const blockFast = (xml, tag) => {
  const open = `<${tag}`;
  const closeTag = `</${tag}>`;
  let pos = 0;
  while (true) {
    const s = xml.indexOf(open, pos);
    if (s === -1) return null;
    if (!_isTagBoundary(xml[s + open.length])) { pos = s + 1; continue; }
    const bodyStart = xml.indexOf(">", s);
    if (bodyStart === -1) return null;
    if (xml[bodyStart - 1] === "/") return null; // self-closing
    const e = xml.indexOf(closeTag, bodyStart);
    return e === -1 ? null : xml.slice(bodyStart + 1, e);
  }
};

const allBlocksFast = (xml, tag) => {
  const open = `<${tag}`;
  const closeTag = `</${tag}>`;
  const results = [];
  let pos = 0;
  while (true) {
    let s = -1;
    let searchPos = pos;
    while (true) {
      const idx = xml.indexOf(open, searchPos);
      if (idx === -1) return results;
      if (_isTagBoundary(xml[idx + open.length])) { s = idx; break; }
      searchPos = idx + 1;
    }
    const bodyStart = xml.indexOf(">", s);
    if (bodyStart === -1) break;
    if (xml[bodyStart - 1] === "/") { pos = bodyStart + 1; continue; }
    const e = xml.indexOf(closeTag, bodyStart);
    if (e === -1) break;
    results.push({ full: xml.slice(s, e + closeTag.length), inner: xml.slice(bodyStart + 1, e) });
    pos = e + closeTag.length;
  }
  return results;
};

const attrFast = (tagStr, attrName) => {
  const m = tagStr.match(new RegExp(`${attrName}="([^"]*)"`));
  return m ? m[1] : null;
};

const noFill = (v) => (v === -1000000000 || v === "-1000000000") ? null : v;

// ── GeoJSON async lesen + Spatial Index bauen ─────────────────────────────────
const loadGeoJsonWithIndex = () => new Promise((resolve, reject) => {
  const filePath = path.join(__dirname, "../deutschland.geojson");
  const chunks = [];
  fs.createReadStream(filePath, { encoding: "utf-8" })
    .on("data", c => chunks.push(c))
    .on("end", () => {
      try {
        const geojson = JSON.parse(chunks.join(""));

        // Spatial Index aufbauen (rbush)
        const tree = new rbush();
        const items = [];
        for (let i = 0; i < geojson.features.length; i++) {
          const f = geojson.features[i];
          try {
            const bbox = turf.bbox(f);
            if (isFinite(bbox[0]) && isFinite(bbox[1]) && isFinite(bbox[2]) && isFinite(bbox[3])) {
              items.push({ minX: bbox[0], minY: bbox[1], maxX: bbox[2], maxY: bbox[3], idx: i });
            }
          } catch { /* Feature überspringen */ }
        }
        tree.load(items);
        resolve({ geojson, spatialIndex: tree });
      } catch (e) {
        reject(e);
      }
    })
    .on("error", reject);
});

// ── Mesozyklonen-Parser ───────────────────────────────────────────────────────
const parseMesoCells = (xml) => {
  const refTimeMatch =
    xml.match(/<time[^>]*time-coordinate="UTC"[^>]*>([^<]+)<\/time>/) ||
    xml.match(/<time[^>]*>([^<]+)<\/time>/);
  const refTime = refTimeMatch ? refTimeMatch[1].trim() : null;

  const dtMatch = refTime?.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):?(\d{2})/);
  const dateStr = dtMatch ? `${dtMatch[1]}${dtMatch[2]}${dtMatch[3]}` : "";
  const timeStr = dtMatch ? `${dtMatch[4]}${dtMatch[5]}`             : "";

  const eventRe = /<event\b([^>]*)>([\s\S]*?)<\/event>/g;
  const cells   = [];
  let m;

  while ((m = eventRe.exec(xml)) !== null) {
    const attrs = m[1];
    const inner = m[2];

    const idMatch  = attrs.match(/ID="([^"]*)"/);
    const event_id = idMatch ? parseInt(idMatch[1]) : null;

    const latitude  = numFast(inner, "latitude");
    const longitude = numFast(inner, "longitude");
    const intensity = (() => {
      const v = textFast(inner, "meso_intensity");
      return v !== null ? parseInt(v) : null;
    })();

    const nwp = blockFast(inner, "nowcast-parameters") ?? inner;

    const mesocyclone_top    = numFast(nwp, "mesocyclone_top");
    const mesocyclone_base   = numFast(nwp, "mesocyclone_base");
    const max_dbz            = numFast(nwp, "max_dbz");
    const rotational_max     = numFast(nwp, "mesocyclone_velocity_rotational_max");
    const base_speed         = numFast(nwp, "mesocyclone_velocity_rotational_max_closest_to_ground");
    const shear_max          = numFast(nwp, "mesocyclone_shear_max");

  
    // ── Radar-Sweeps: alle Stationen mit ihren Elevationen ───────────────────
    const elevations = [];
    const elevBlocks = allBlocksFast(inner, "elevation");
    for (const el of elevBlocks) {
      const site   = attrFast(el.full, "site");
      const angles = el.inner.split(",").map(v => parseFloat(v.trim())).filter(n => !isNaN(n));
      if (site && angles.length > 0) elevations.push({ site, angles });
    }
    
    // Für Tornado-Check: niedrigste Elevation über alle Stationen
    const allAngles     = elevations.flatMap(e => e.angles);
    const min_elevation = allAngles.length > 0 ? Math.min(...allAngles) : null;
    const has_low_sweep = min_elevation !== null && min_elevation <= 1.5;
    const has_surface_sweep = min_elevation !== null && min_elevation <= 0.5;

    // ── Tornado: true / false ─────────────────────────────────────────────
    const tornado = (
      intensity !== null && intensity >= 3 &&
      mesocyclone_base !== null && mesocyclone_base < 1.5 &&
      base_speed !== null && base_speed > 8 &&
      has_low_sweep
    );

    cells.push({
      dateStr, timeStr, event_id,
      latitude, longitude, intensity,
      mesocyclone_top, mesocyclone_base,
      max_dbz, rotational_max, base_speed, shear_max,
      elevations, min_elevation, has_low_sweep, has_surface_sweep,
      tornado,
    });
  }

  return cells;
};

// ── Mesozyklonen-Fetch ────────────────────────────────────────────────────────
const fetchMesoCells = async () => {
  const url = "https://opendata.dwd.de/weather/radar/mesocyclones/meso_latest.xml";
  const r   = await fetch(url, {
    headers: { "User-Agent": "konrad3d-api/1.0", "Connection": "keep-alive" },
    signal:  AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Mesozyklonen-Fetch fehlgeschlagen: HTTP ${r.status}`);
  return parseMesoCells(await r.text());
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Filename-Builder ──────────────────────────────────────────────────────
  const buildFilename = (offsetMin) => {
    const t   = new Date(Date.now() - offsetMin * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = t.getUTCFullYear();
    const mm   = pad(t.getUTCMonth() + 1);
    const dd   = pad(t.getUTCDate());
    const hh   = pad(t.getUTCHours());
    const min  = pad(Math.floor(t.getUTCMinutes() / 5) * 5);
    return `KONRAD3D_${yyyy}${mm}${dd}T${hh}${min}00`;
  };

  // ── Geo-Hilfsfunktionen ───────────────────────────────────────────────────
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;

  const bearing = (lat1, lon1, lat2, lon2) => {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  };

  const destPoint = (lat, lon, brng, dist) => {
    const R    = 6371;
    const b    = toRad(brng);
    const lat1 = toRad(lat);
    const lon1 = toRad(lon);
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(dist / R) +
      Math.cos(lat1) * Math.sin(dist / R) * Math.cos(b)
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(b) * Math.sin(dist / R) * Math.cos(lat1),
      Math.cos(dist / R) - Math.sin(lat1) * Math.sin(lat2)
    );
    return { lat: toDeg(lat2), lon: toDeg(lon2) };
  };

  const haversine = (lat1, lon1, lat2, lon2) => {
    const R    = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a    = Math.sin(dLat / 2) ** 2 +
                 Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const bearingToDirection = (brng) => {
    const dirs = [
      [22.5,  "nördlich"],    [67.5,  "nordöstlich"],
      [112.5, "östlich"],     [157.5, "südöstlich"],
      [202.5, "südlich"],     [247.5, "südwestlich"],
      [292.5, "westlich"],    [337.5, "nordwestlich"],
      [360,   "nördlich"],
    ];
    for (const [limit, label] of dirs) if (brng < limit) return label;
    return "nördlich";
  };

  const getCityName = (properties) =>
    properties?.name || properties?.NAME || properties?.GEN ||
    properties?.name_de || properties?.NAMELSAD || null;

  // ── Ortserkennung mit Spatial Index ──────────────────────────────────────
  const findNearestPlace = (lat, lon, geojson, spatialIndex, maxKm = 30) => {
    if (!geojson?.features || !spatialIndex) return null;

    const degPad = maxKm / 111;
    const candidates = spatialIndex.search({
      minX: lon - degPad, minY: lat - degPad,
      maxX: lon + degPad, maxY: lat + degPad,
    });

    let best = null;
    for (const item of candidates) {
      const f    = geojson.features[item.idx];
      const name = getCityName(f.properties);
      if (!name) continue;

      const geom = f.geometry;
      let centroid = null;
      const getCentroid = (coords) => {
        let sumLon = 0, sumLat = 0;
        for (const [lo, la] of coords) { sumLon += lo; sumLat += la; }
        return { lat: sumLat / coords.length, lon: sumLon / coords.length };
      };
      if (geom.type === "Polygon")           centroid = getCentroid(geom.coordinates[0]);
      else if (geom.type === "MultiPolygon") centroid = getCentroid(geom.coordinates[0][0]);
      else if (geom.type === "Point")        centroid = { lat: geom.coordinates[1], lon: geom.coordinates[0] };
      if (!centroid) continue;

      const dist = haversine(lat, lon, centroid.lat, centroid.lon);
      if (dist <= maxKm && (!best || dist < best.dist)) {
        best = { name, dist, lat: centroid.lat, lon: centroid.lon };
      }
    }

    if (!best) return null;
    const distKm = Math.round(best.dist * 10) / 10;
    const brng   = bearing(best.lat, best.lon, lat, lon);
    const dir    = bearingToDirection(brng);
    if (distKm < 1.5) return { text: `über ${best.name}`, name: best.name, dist_km: distKm };
    return { text: `${distKm} km ${dir} von ${best.name}`, name: best.name, dist_km: distKm, direction: dir };
  };

  // ── Turf-basierte Ortserkennung mit Spatial Index ─────────────────────────
  const findOrteAlongTrack = (trackPoints, geojson, spatialIndex, ref_time) => {
    if (!geojson?.features || trackPoints.length === 0 || !spatialIndex) return [];

    const BUFFER_KM = 2.5;
    const refMs     = new Date(ref_time).getTime();

    let trackBuffer;
    try {
      if (trackPoints.length === 1) {
        trackBuffer = turf.buffer(
          turf.point([trackPoints[0].lon, trackPoints[0].lat]),
          BUFFER_KM, { units: "kilometers" }
        );
      } else {
        const lines = [];
        for (let i = 0; i < trackPoints.length - 1; i++) {
          lines.push([
            [trackPoints[i].lon,     trackPoints[i].lat],
            [trackPoints[i + 1].lon, trackPoints[i + 1].lat],
          ]);
        }
        trackBuffer = turf.buffer(
          turf.multiLineString(lines), BUFFER_KM, { units: "kilometers" }
        );
      }
    } catch { return []; }

    const bufferBbox = turf.bbox(trackBuffer);

    // ← Spatial Index: nur Features im Bounding-Box des Track-Buffers holen
    const candidates = spatialIndex.search({
      minX: bufferBbox[0], minY: bufferBbox[1],
      maxX: bufferBbox[2], maxY: bufferBbox[3],
    });

    const orte = [];
    const seen = new Set();

    for (const item of candidates) {
      const f    = geojson.features[item.idx];
      const name = getCityName(f.properties);
      if (!name || seen.has(name)) continue;

      let centroidCoord;
      try {
        const c = turf.centroid(f);
        centroidCoord = c.geometry.coordinates;
      } catch {
        const bbox = turf.bbox(f);
        centroidCoord = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
      }

      const refPoint  = trackPoints[0];
      const quickDist = haversine(centroidCoord[1], centroidCoord[0], refPoint.lat, refPoint.lon);
      if (quickDist > 80) continue;

      let isAffected = false;
      try {
        if (f.geometry.type === "Point") {
          const place    = f.properties?.place;
          let radiusKm   = 1.0;
          if (place === "village") radiusKm = 1.5;
          else if (place === "town")  radiusKm = 2.0;
          else if (place === "city")  radiusKm = 3.0;
          const bufferedPoint = turf.buffer(turf.point(f.geometry.coordinates), radiusKm, { units: "kilometers" });
          isAffected = turf.booleanIntersects(bufferedPoint, trackBuffer);
        } else {
          isAffected = turf.booleanIntersects(f, trackBuffer);
        }
      } catch { continue; }

      if (!isAffected) continue;

      let bestMs   = trackPoints[0].ms;
      let bestDist = Infinity;

      for (let i = 0; i < trackPoints.length - 1; i++) {
        const p      = trackPoints[i];
        const q      = trackPoints[i + 1];
        const segLen = haversine(p.lat, p.lon, q.lat, q.lon);
        if (segLen === 0) {
          const d = haversine(centroidCoord[1], centroidCoord[0], p.lat, p.lon);
          if (d < bestDist) { bestDist = d; bestMs = p.ms; }
          continue;
        }
        const brngAB   = bearing(p.lat, p.lon, q.lat, q.lon);
        const brngAP   = bearing(p.lat, p.lon, centroidCoord[1], centroidCoord[0]);
        const distAP   = haversine(p.lat, p.lon, centroidCoord[1], centroidCoord[0]);
        const angle    = ((brngAP - brngAB + 360) % 360) * Math.PI / 180;
        const along    = Math.max(0, Math.min(segLen, distAP * Math.cos(angle)));
        const t        = along / segLen;
        const interpMs = p.ms + t * (q.ms - p.ms);
        const across   = Math.abs(distAP * Math.sin(angle));
        if (across < bestDist) { bestDist = across; bestMs = interpMs; }
      }

      const last  = trackPoints[trackPoints.length - 1];
      const dLast = haversine(centroidCoord[1], centroidCoord[0], last.lat, last.lon);
      if (dLast < bestDist) bestMs = last.ms;

      seen.add(name);
      // minutes_until relativ zu jetzt (nicht zur reference_time)
      const nowMs         = Date.now();
      const minutes_until = Math.round((bestMs - nowMs) / 60000);
      // Orte die bereits hinter der Zelle liegen (> 2 min in Vergangenheit) überspringen
      if (minutes_until < -2) continue;
      const arrival_time  = new Date(bestMs).toLocaleTimeString("de-DE", {
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin",
      });
      orte.push({ name, arrival_time, minutes_until: Math.max(0, minutes_until) });
    }

    orte.sort((a, b) => (a.minutes_until ?? 0) - (b.minutes_until ?? 0));
    return orte;
  };

  // ── fetchXml — parallel ───────────────────────────────────────────────────
  const fetchXml = async () => {
    const results = await Promise.allSettled(
      [5, 10, 15, 20].map(async (offset) => {
        const filename = buildFilename(offset);
        const url = `https://opendata.dwd.de/weather/radar/konrad3d/${filename}.xml`;
        const r = await fetch(url, {
          headers: { "User-Agent": "konrad3d-api/1.0", "Connection": "keep-alive" },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { xml: await r.text(), filename };
      })
    );
    const first = results.find((r) => r.status === "fulfilled");
    if (first) return first.value;
    throw new Error("Keine aktuelle KONRAD3D-Datei verfügbar");
  };

  // ── Feature parsen ────────────────────────────────────────────────────────
  const parseFeature = (featureFull, geojson, spatialIndex, refTime) => {
    const featureTag = featureFull.match(/<feature([^>]*)>/)?.[0] ?? "";
    const inner      = blockFast(featureFull, "feature") ?? featureFull;

    const meta       = blockFast(inner, "metadata") ?? "";
    const identifier = textFast(meta, "identifier") ?? attrFast(featureTag, "identifier") ?? "0";
    const ref_time   = (textFast(meta, "reference_time") ?? refTime ?? "").trim();

    const dtMatch = ref_time.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):?(\d{2})/);
    const dateStr = dtMatch ? `${dtMatch[1]}${dtMatch[2]}${dtMatch[3]}` : "";
    const timeStr = dtMatch ? `${dtMatch[4]}${dtMatch[5]}` : "";

    const geo              = blockFast(inner, "geometry") ?? "";
    const covered_area     = numFast(geo, "covered_area");
    const area_growth_rate = numFast(geo, "area_growth_rate");
    const echo_top_msl     = noFill(numFast(geo, "echo_top_msl"));
    const echo_bottom_msl  = noFill(numFast(geo, "echo_bottom_msl"));

    const centroid3d = blockFast(geo, "centroid_3d") ?? blockFast(geo, "centroid3d") ?? "";
    const geodetic   = blockFast(centroid3d, "geodetic_coordinate") ?? centroid3d;
    const lat        = numFast(geodetic, "latitude");
    const lon        = numFast(geodetic, "longitude");

    const intens         = blockFast(inner, "intensity") ?? "";
    const severity       = intFast(intens, "severity") ?? 0;
    const vil_density    = numFast(intens, "cell_based_VIL_density");
    const max_dbz        = numFast(intens, "max_value");
    const max_wind_gust  = numFast(intens, "maximum_estimated_wind_gust");
    const heavy_rain_pot = numFast(intens, "heavy_rain_potential");

    const light          = blockFast(inner, "lightning") ?? "";
    const lightning_rate = intFast(light, "lightning_rate") ?? 0;

    const hymec                  = blockFast(inner, "hymec") ?? "";
    const area_hail              = numFast(hymec, "area_hail")              ?? 0;
    const area_large_hail        = numFast(hymec, "area_large_hail")        ?? 0;
    const echo_top_hail          = noFill(numFast(hymec, "echo_top_hail"));
    const echo_top_large_hail    = noFill(numFast(hymec, "echo_top_large_hail"));
    const echo_bottom_hail       = noFill(numFast(hymec, "echo_bottom_hail"));
    const echo_bottom_large_hail = noFill(numFast(hymec, "echo_bottom_large_hail"));
    const hail_flag              = intFast(inner, "hail_flag");

    // ── NWP-Modell ────────────────────────────────────────────────────────
    const nwpBlock       = blockFast(inner, "nwp_model") ?? "";
    const nwp_mu_cape    = numFast(nwpBlock, "nwp_mu_cape");
    const nwp_mu_cin     = numFast(nwpBlock, "nwp_mu_cin");
    const nwp_mu_lcl_hgt = numFast(nwpBlock, "nwp_mu_lcl_hgt");
    const nwp_mu_lfc_hgt = numFast(nwpBlock, "nwp_mu_lfc_hgt");
    const nwp_mu_el_hgt  = numFast(nwpBlock, "nwp_mu_el_hgt");
    const nwp_bs_01km    = numFast(nwpBlock, "nwp_bs_01km");
    const nwp_bs_06km    = numFast(nwpBlock, "nwp_bs_06km");
    const nwp_bs_eff_mu  = numFast(nwpBlock, "nwp_bs_eff_mu");
    const nwp_srh_1km_rm = numFast(nwpBlock, "nwp_srh_1km_rm");
    const nwp_srh_3km_rm = numFast(nwpBlock, "nwp_srh_3km_rm");
    const nwp_lr_500800  = numAttr(nwpBlock, "nwp_lr_500800hPa");
    const nwp_prcp_water = numFast(nwpBlock, "nwp_prcp_water");
    const nwp_dcape      = numFast(nwpBlock, "nwp_dcape");

    // ── STP ───────────────────────────────────────────────────────────────
    let nwp_stp = null;
    if (nwp_mu_cape !== null && nwp_mu_lcl_hgt !== null &&
        nwp_srh_1km_rm !== null && nwp_bs_06km !== null) {

      const cape_term = nwp_mu_cape / 1500;
      const lcl_m     = nwp_mu_lcl_hgt;
      const lcl_term  = lcl_m < 1000 ? 1.0 : lcl_m > 2000 ? 0.0 : (2000 - lcl_m) / 1000;
      const srh_term  = Math.max(0, nwp_srh_1km_rm) / 150;
      const shr6_ms   = nwp_bs_06km;
      const shr_term  = shr6_ms < 12.5 ? 0.0 : shr6_ms > 30 ? 1.5 : shr6_ms / 20;
      let cin_term    = 1.0;
      if (nwp_mu_cin !== null) {
        const cin = nwp_mu_cin;
        cin_term = cin > -50 ? 1.0 : cin < -200 ? 0.0 : (200 + cin) / 150;
      }
      nwp_stp = Math.round(cape_term * lcl_term * srh_term * shr_term * cin_term * 100) / 100;
    }

    // ── SCP ───────────────────────────────────────────────────────────────
    let nwp_scp = null;
    if (nwp_mu_cape !== null && nwp_srh_3km_rm !== null && nwp_bs_06km !== null) {
      const cape_term = nwp_mu_cape / 1000;
      const srh_term  = Math.max(0, nwp_srh_3km_rm) / 50;
      const ebs_ms    = nwp_bs_06km;
      const ebs_term  = ebs_ms < 10 ? 0.0 : ebs_ms > 20 ? 1.0 : ebs_ms / 20;
      nwp_scp = Math.round(cape_term * srh_term * ebs_term * 100) / 100;
    }

    // ── Hagelberechnung ───────────────────────────────────────────────────
    let hail_cm = null;
    if (hail_flag !== null && hail_flag >= 1) {
      if (hail_flag === 1) {
        const thickness = (echo_top_hail !== null && echo_bottom_hail !== null)
          ? (echo_top_hail - echo_bottom_hail) / 1000 : 0;
        hail_cm = Math.min(0.5 + thickness * 0.1 + area_hail * 0.001, 1.9);
      } else if (hail_flag === 2) {
        const thickness = (echo_top_hail !== null && echo_bottom_hail !== null)
          ? (echo_top_hail - echo_bottom_hail) / 1000 : 0;
        hail_cm = Math.max(1.0, Math.min(1.0 + thickness * 0.2 + area_hail * 0.003, 3.9));
      } else if (hail_flag === 3) {
        const thickness = (echo_top_large_hail !== null && echo_bottom_large_hail !== null)
          ? (echo_top_large_hail - echo_bottom_large_hail) / 1000
          : (echo_top_hail !== null && echo_bottom_hail !== null)
            ? (echo_top_hail - echo_bottom_hail) / 1000 : 0;
        const area = area_large_hail > 0 ? area_large_hail : area_hail;
        hail_cm = Math.max(2.0, 2.0 + thickness * 0.3 + area * 0.005);
      }
      if (hail_cm !== null) hail_cm = Math.round(hail_cm * 10) / 10;
    }

    // ── Tracking ──────────────────────────────────────────────────────────
    const trackBlock     = blockFast(inner, "tracking") ?? "";
    const cell_speed     = numFast(trackBlock, "cell_speed");
    const severity_trend = numFast(trackBlock, "severity_trend") ?? numFast(inner, "severity_trend");
    const mass_trend     = numFast(trackBlock, "mass_trend")     ?? numFast(inner, "mass_trend");

    // ── Zellenentwicklung ─────────────────────────────────────────────────
    let development = null;
    if (area_growth_rate !== null || severity_trend !== null || mass_trend !== null) {
      let pos = 0, neg = 0;
      if (severity_trend !== null) {
        if (severity_trend >  0.5) pos++;
        else if (severity_trend < -0.5) neg++;
      }
      if (area_growth_rate !== null) {
        if (area_growth_rate >  0.5) pos++;
        else if (area_growth_rate < -0.5) neg++;
      }
      if (mass_trend !== null) {
        if (mass_trend >  0.5) pos++;
        else if (mass_trend < -0.5) neg++;
      }
      if      (pos >= 2) development = { status: "wachsend",       color: "red"    };
      else if (neg >= 2) development = { status: "schrumpfend",    color: "green"  };
      else               development = { status: "gleichbleibend", color: "orange" };
    }

    // ── Forecast-Punkte ───────────────────────────────────────────────────
    const forecastBlock     = blockFast(inner, "forecast") ?? "";
    const centroidForecasts = blockFast(forecastBlock, "centroid_forecasts") ?? "";
    const cfBlocks          = allBlocksFast(centroidForecasts, "centroid_forecast");

    let forecast_lat = null;
    let forecast_lon = null;
    const allForecasts = [];

    for (const cf of cfBlocks) {
      const forecast_time = attrFast(cf.full, "forecast_time");
      const fg   = blockFast(cf.inner, "geodetic_coordinate") ?? cf.inner;
      const fLat = numFast(fg, "latitude");
      const fLon = numFast(fg, "longitude");
      forecast_lat = fLat;
      forecast_lon = fLon;
      if (fLat && fLon) allForecasts.push({ forecast_time, lat: fLat, lon: fLon });
    }

    let lat3 = null, lon3 = null;
    let perp_point1_lat = null, perp_point1_lon = null;
    let perp_point2_lat = null, perp_point2_lon = null;

    if (lat && lon && forecast_lat && forecast_lon) {
      lat3 = forecast_lat - lat;
      lon3 = forecast_lon - lon;
      const trackBearing = bearing(lat, lon, forecast_lat, forecast_lon);
      const trackDist    = haversine(lat, lon, forecast_lat, forecast_lon);
      const coneWidth    = Math.max(25, trackDist * 0.5);
      const p1 = destPoint(forecast_lat, forecast_lon, (trackBearing + 90)  % 360, coneWidth);
      const p2 = destPoint(forecast_lat, forecast_lon, (trackBearing + 270) % 360, coneWidth);
      perp_point1_lat = p1.lat; perp_point1_lon = p1.lon;
      perp_point2_lat = p2.lat; perp_point2_lon = p2.lon;
    }

    // ── Track-Punkte + Orte ───────────────────────────────────────────────
    const refMs       = new Date(ref_time).getTime();
    const trackPoints = [];
    if (lat && lon) trackPoints.push({ lat, lon, ms: refMs });
    for (const f of allForecasts) {
      if (!f.forecast_time) continue;
      const ms = new Date(f.forecast_time).getTime();
      if (!isNaN(ms)) trackPoints.push({ lat: f.lat, lon: f.lon, ms });
    }

    const orte    = (trackPoints.length > 0 && geojson)
      ? findOrteAlongTrack(trackPoints, geojson, spatialIndex, ref_time) : [];
    const position = (lat && lon && geojson)
      ? findNearestPlace(lat, lon, geojson, spatialIndex) : null;

    return {
      dateStr, timeStr,
      cell_id:                identifier,
      latitude:               lat,
      longitude:              lon,
      position,
      cell_speed,
      cell_based_vil_density: vil_density,
      dbz_max:                max_dbz,
      hail_flag,
      hail_cm,
      lightning_rate,
      wind_gust:              max_wind_gust,
      heavy_rain_rate:        heavy_rain_pot,
      severity,
      severity_trend,
      mass_trend,
      area_growth_rate,
      development,
      forecast_latitude:      forecast_lat,
      forecast_longitude:     forecast_lon,
      perp_point1_lat, perp_point1_lon,
      perp_point2_lat, perp_point2_lon,
      lon3, lat3,
      echo_top_msl, echo_bottom_msl,
      covered_area,
      orte,
      nwp: {
        mu_cape:      nwp_mu_cape,
        mu_cin:       nwp_mu_cin,
        mu_lcl_hgt:   nwp_mu_lcl_hgt,
        mu_lfc_hgt:   nwp_mu_lfc_hgt,
        mu_el_hgt:    nwp_mu_el_hgt,
        bs_01km:      nwp_bs_01km,
        bs_06km:      nwp_bs_06km,
        bs_eff_mu:    nwp_bs_eff_mu,
        srh_1km_rm:   nwp_srh_1km_rm,
        srh_3km_rm:   nwp_srh_3km_rm,
        srh_1km_lm:   numFast(nwpBlock, "nwp_srh_1km_lm"),
        srh_3km_lm:   numFast(nwpBlock, "nwp_srh_3km_lm"),
        lr_500800hPa: nwp_lr_500800,
        prcp_water:   nwp_prcp_water,
        dcape:        nwp_dcape,
      },
      nwp_indices: {
        stp: nwp_stp,
        scp: nwp_scp,
      },

    };
  };

  // ── Handler ───────────────────────────────────────────────────────────────
  try {
    // Alles parallel: XML-Fetch, GeoJSON + Index-Build, Meso-Fetch
    const [{ xml, filename }, { geojson, spatialIndex }, meso_cells] = await Promise.all([
      fetchXml(),
      loadGeoJsonWithIndex(),
      fetchMesoCells().catch((err) => {
        console.error("Mesozyklonen-Fetch fehlgeschlagen:", err.message);
        return [];
      }),
    ]);

    const reference_time =
      xml.match(/<reference_time[^>]*>([^<]+)<\/reference_time>/)?.[1]?.trim() ??
      xml.match(/<cells[^>]+reference_time="([^"]+)"/)?.[1]?.trim() ??
      null;

    const creation_date =
      xml.match(/<creation-date[^>]*>([^<]+)<\/creation-date>/)?.[1]?.trim() ?? null;

    const featureMatches = xml.match(/<feature[\s\S]*?<\/feature>/g) ?? [];

    // Alle Features parallel parsen
    const cells = await Promise.all(
      featureMatches.map((f) =>
        Promise.resolve(parseFeature(f, geojson, spatialIndex, reference_time))
      )
    );

    // ── Mesozyklone mit KONRAD3D-Zelle verknüpfen ────────────────────────────
    const haversineH = (lat1, lon1, lat2, lon2) => {
      const R = 6371, toR = d => d * Math.PI / 180;
      const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
      const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1))*Math.cos(toR(lat2))*Math.sin(dLon/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    };

    for (const cell of cells) {
      if (!cell.latitude || !cell.longitude) { cell.mesocyclone = null; continue; }
      let best = null, bestDist = Infinity;
      for (const m of meso_cells) {
        if (!m.latitude || !m.longitude) continue;
        const d = haversineH(cell.latitude, cell.longitude, m.latitude, m.longitude);
        if (d < bestDist && d <= 25) { best = m; bestDist = d; }
      }
      cell.mesocyclone     = best ? { ...best, dist_km: Math.round(bestDist * 10) / 10 } : null;
      cell.is_supercell    = best !== null;
      cell.tornado         = best ? best.tornado : null;
    }

    return res.status(200).json({
      reference_time,
      creation_date,
      file: filename + ".xml",
      stormtracking_cells: cells,
      meso_cells,
    });

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
