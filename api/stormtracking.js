// api/konrad3d.js
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as turf from "@turf/turf";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Mesozyklonen-Parser ───────────────────────────────────────────────────────
const parseMesoCells = (xml) => {
  const text = (xml, tag) => {
    const m = xml.match(new RegExp(`<${tag}(?:[^>]*)>([^<]*)<\\/${tag}>`));
    return m ? m[1].trim() : null;
  };
  const num = (xml, tag) => {
    const v = text(xml, tag);
    return v !== null && v !== "" && !isNaN(v) ? parseFloat(v) : null;
  };

  // Referenzzeit aus dem Root-Element oder dem ersten Event
  const refTimeMatch =
    xml.match(/<time[^>]*time-coordinate="UTC"[^>]*>([^<]+)<\/time>/) ||
    xml.match(/<time[^>]*>([^<]+)<\/time>/);
  const refTime = refTimeMatch ? refTimeMatch[1].trim() : null;

  const dtMatch = refTime?.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):?(\d{2})/);
  const dateStr = dtMatch ? `${dtMatch[1]}${dtMatch[2]}${dtMatch[3]}` : "";
  const timeStr = dtMatch ? `${dtMatch[4]}${dtMatch[5]}`             : "";

  // Alle <event>-Blöcke
  const eventRe = /<event\b([^>]*)>([\s\S]*?)<\/event>/g;
  const cells   = [];
  let m;

  while ((m = eventRe.exec(xml)) !== null) {
    const attrs = m[1];
    const inner = m[2];

    const idMatch = attrs.match(/ID="([^"]*)"/);
    const event_id = idMatch ? parseInt(idMatch[1]) : null;

    const latitude  = num(inner, "latitude");
    const longitude = num(inner, "longitude");
    const intensity = (() => {
      const v = text(inner, "meso_intensity");
      return v !== null ? parseInt(v) : null;
    })();
    const mesocyclone_top  = num(inner, "mesocyclone_top");
    const mesocyclone_base = num(inner, "mesocyclone_base");
    const max_dbz          = num(inner, "max_dbz");
    const base_speed       = num(inner, "mesocyclone_velocity_rotational_max_closest_to_ground");

    cells.push({
      dateStr,
      timeStr,
      event_id,
      latitude,
      longitude,
      intensity,
      mesocyclone_top,
      mesocyclone_base,
      max_dbz,
      base_speed,
    });
  }

  return cells;
};

// ── Mesozyklonen-Fetch ────────────────────────────────────────────────────────
const fetchMesoCells = async () => {
  const url = "https://opendata.dwd.de/weather/radar/mesocyclones/meso_latest.xml";
  const r   = await fetch(url, {
    headers: { "User-Agent": "konrad3d-api/1.0" },
    signal:  AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`Mesozyklonen-Fetch fehlgeschlagen: HTTP ${r.status}`);
  return parseMesoCells(await r.text());
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Test-Endpunkt ─────────────────────────────────────────────────────────
  if (req.url?.includes("test=meso") || req.query?.test === "meso") {
    const TEST_MESO_CELLS = [
      {
        dateStr: "20260505", timeStr: "1530", event_id: 1,
        latitude: 53.289025, longitude: 6.941067,
        intensity: 1, mesocyclone_top: 3.637998, mesocyclone_base: 2.519183,
        max_dbz: 59.7, base_speed: 8.619404,
      },
      {
        dateStr: "20260505", timeStr: "1530", event_id: 3,
        latitude: 51.312500, longitude: 12.437500,
        intensity: 2, mesocyclone_top: 5.200000, mesocyclone_base: 1.400000,
        max_dbz: 47.3, base_speed: 6.210000,
      },
    ];

    const TEST_STORMTRACKING_CELLS = [
      {
        dateStr: "20260505", timeStr: "1530",
        cell_id: "T1",
        latitude: 53.286025, longitude: 6.941067,
        position: { text: "Testgebiet Nord", name: "Testgebiet Nord", dist_km: 0 },
        cell_speed: 45.0,
        cell_based_vil_density: 3.5,
        dbz_max: 62.0,
        hail_flag: 2, hail_cm: 2.5,
        lightning_rate: 12,
        wind_gust: 28.5,
        heavy_rain_rate: 15.0,
        severity: 3,
        severity_trend: 1.2, mass_trend: 0.8, area_growth_rate: 1.5,
        development: { status: "wachsend", color: "red" },
        forecast_latitude: 53.52, forecast_longitude: 7.10,
        echo_top_msl: 8500, echo_bottom_msl: 500,
        covered_area: 120,
        orte: [],
        centroid_forecasts: [
          { forecast_time: "2026-05-05T15:40:00Z", latitude: 53.38, longitude: 6.98, minutes_from_ref: 10 },
          { forecast_time: "2026-05-05T15:50:00Z", latitude: 53.45, longitude: 7.04, minutes_from_ref: 20 },
          { forecast_time: "2026-05-05T16:00:00Z", latitude: 53.52, longitude: 7.10, minutes_from_ref: 30 },
        ],
      },
      {
        dateStr: "20260505", timeStr: "1530",
        cell_id: "T2",
        latitude: 48.775112, longitude: 10.941110,
        position: { text: "Testgebiet Süd", name: "Testgebiet Süd", dist_km: 0 },
        cell_speed: 38.0,
        cell_based_vil_density: 5.2,
        dbz_max: 68.0,
        hail_flag: 3, hail_cm: 4.1,
        lightning_rate: 25,
        wind_gust: 42.0,
        heavy_rain_rate: 22.0,
        severity: 5,
        severity_trend: 2.1, mass_trend: 1.5, area_growth_rate: 2.3,
        development: { status: "wachsend", color: "red" },
        forecast_latitude: 48.95, forecast_longitude: 11.15,
        echo_top_msl: 12000, echo_bottom_msl: 300,
        covered_area: 280,
        orte: [],
        centroid_forecasts: [
          { forecast_time: "2026-05-05T15:40:00Z", latitude: 48.83, longitude: 11.01, minutes_from_ref: 10 },
          { forecast_time: "2026-05-05T15:50:00Z", latitude: 48.89, longitude: 11.08, minutes_from_ref: 20 },
          { forecast_time: "2026-05-05T16:00:00Z", latitude: 48.95, longitude: 11.15, minutes_from_ref: 30 },
        ],
      },
      {
        dateStr: "20260505", timeStr: "1530",
        cell_id: "T3",
        latitude: 51.312500, longitude: 12.437500,
        position: { text: "Testgebiet Mitte", name: "Testgebiet Mitte", dist_km: 0 },
        cell_speed: 30.0,
        cell_based_vil_density: 2.8,
        dbz_max: 55.0,
        hail_flag: 1, hail_cm: 1.2,
        lightning_rate: 5,
        wind_gust: 22.0,
        heavy_rain_rate: 8.5,
        severity: 2,
        severity_trend: 0.3, mass_trend: -0.2, area_growth_rate: 0.1,
        development: { status: "gleichbleibend", color: "orange" },
        forecast_latitude: 51.46, forecast_longitude: 12.58,
        echo_top_msl: 6200, echo_bottom_msl: 700,
        covered_area: 75,
        orte: [],
        centroid_forecasts: [
          { forecast_time: "2026-05-05T15:40:00Z", latitude: 51.36, longitude: 12.49, minutes_from_ref: 10 },
          { forecast_time: "2026-05-05T15:50:00Z", latitude: 51.41, longitude: 12.53, minutes_from_ref: 20 },
          { forecast_time: "2026-05-05T16:00:00Z", latitude: 51.46, longitude: 12.58, minutes_from_ref: 30 },
        ],
      },
    ];

    try {
      const live = await fetchMesoCells();
      const meso_cells = live.length > 0 ? live : TEST_MESO_CELLS;
      return res.status(200).json({
        meso_cells,
        stormtracking_cells: TEST_STORMTRACKING_CELLS,
      });
    } catch (err) {
      return res.status(200).json({
        meso_cells: TEST_MESO_CELLS,
        stormtracking_cells: TEST_STORMTRACKING_CELLS,
      });
    }
  }

  // ── XML-Hilfsfunktionen ────────────────────────────────────────────────
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

  const text = (xml, tag) => {
    const m = xml.match(new RegExp(`<${tag}(?:[^>]*)>([^<]*)<\\/${tag}>`));
    return m ? m[1].trim() : null;
  };
  const num = (xml, tag) => {
    const v = text(xml, tag);
    return v !== null && v !== "" && !isNaN(v) ? parseFloat(v) : null;
  };
  const int = (xml, tag) => {
    const v = text(xml, tag);
    if (v === null || v === "") return null;
    const n = parseInt(v);
    return n === -1000000000 ? null : n;
  };
  const block = (xml, tag) => {
    const m = xml.match(new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1] : null;
  };
  const allBlocks = (xml, tag) => {
    const re = new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g");
    const results = [];
    let m;
    while ((m = re.exec(xml)) !== null) results.push({ full: m[0], inner: m[1] });
    return results;
  };
  const attr = (tagStr, attrName) => {
    const m = tagStr.match(new RegExp(`${attrName}="([^"]*)"`));
    return m ? m[1] : null;
  };
  const noFill = (v) => (v === -1000000000 || v === "-1000000000") ? null : v;

  // ── Geo-Hilfsfunktionen ───────────────────────────────────────────────
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
      [22.5,  "nördlich"],
      [67.5,  "nordöstlich"],
      [112.5, "östlich"],
      [157.5, "südöstlich"],
      [202.5, "südlich"],
      [247.5, "südwestlich"],
      [292.5, "westlich"],
      [337.5, "nordwestlich"],
      [360,   "nördlich"],
    ];
    for (const [limit, label] of dirs) if (brng < limit) return label;
    return "nördlich";
  };

  const findNearestPlace = (lat, lon, geojson, maxKm = 30) => {
    if (!geojson?.features) return null;
    let best = null;
    for (const f of geojson.features) {
      const name = f.properties?.name || f.properties?.NAME ||
                   f.properties?.GEN  || f.properties?.name_de || null;
      if (!name) continue;
      const geom = f.geometry;
      const getCentroid = (coords) => {
        let sumLon = 0, sumLat = 0;
        for (const [lo, la] of coords) { sumLon += lo; sumLat += la; }
        return { lat: sumLat / coords.length, lon: sumLon / coords.length };
      };
      let centroid = null;
      if (geom.type === "Polygon")           centroid = getCentroid(geom.coordinates[0]);
      else if (geom.type === "MultiPolygon") centroid = getCentroid(geom.coordinates[0][0]);
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

  const loadGeoJson = () => {
    try {
      const filePath = path.join(__dirname, "../deutschland.geojson");
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (e) {
      console.error("GeoJSON laden fehlgeschlagen:", e.message);
      return null;
    }
  };

  const fetchXml = async () => {
    for (const offset of [5, 10, 15, 20]) {
      const filename = buildFilename(offset);
      const url = `https://opendata.dwd.de/weather/radar/konrad3d/${filename}.xml`;
      const r = await fetch(url, {
        headers: { "User-Agent": "konrad3d-api/1.0" },
        signal:  AbortSignal.timeout(12000),
      });
      if (r.ok) return { xml: await r.text(), filename };
    }
    throw new Error("Keine aktuelle KONRAD3D-Datei verfügbar");
  };

  // ── getCityName ───────────────────────────────────────────────────────
  const getCityName = (properties) =>
    properties?.name || properties?.NAME || properties?.GEN ||
    properties?.name_de || properties?.NAMELSAD || null;

  // ── Turf-basierte Ortserkennung entlang des Forecast-Tracks ──────────
  const findOrteAlongTrack = (trackPoints, geojson, ref_time) => {
    if (!geojson?.features || trackPoints.length === 0) return [];

    const BUFFER_KM = 2.5;
    const nowMs     = Date.now();
    const refMs     = new Date(ref_time).getTime();

    let trackBuffer;
    if (trackPoints.length === 1) {
      trackBuffer = turf.buffer(
        turf.point([trackPoints[0].lon, trackPoints[0].lat]),
        BUFFER_KM,
        { units: "kilometers" }
      );
    } else {
      const lines = [];
      for (let i = 0; i < trackPoints.length - 1; i++) {
        lines.push([
          [trackPoints[i].lon,     trackPoints[i].lat],
          [trackPoints[i + 1].lon, trackPoints[i + 1].lat],
        ]);
      }
      const multiLine = turf.multiLineString(lines);
      trackBuffer = turf.buffer(multiLine, BUFFER_KM, { units: "kilometers" });
    }

    const bufferBbox = turf.bbox(trackBuffer);
    const orte       = [];
    const seen       = new Set();

    for (const f of geojson.features) {
      const name = getCityName(f.properties);
      if (!name || seen.has(name)) continue;

      const featBbox = turf.bbox(f);
      if (
        featBbox[2] < bufferBbox[0] ||
        featBbox[0] > bufferBbox[2] ||
        featBbox[3] < bufferBbox[1] ||
        featBbox[1] > bufferBbox[3]
      ) continue;

      let isAffected = false;

      if (f.geometry.type === "Point") {
        const pt    = turf.point(f.geometry.coordinates);
        const place = f.properties?.place;
        let radiusKm = 1.0;
        if (place === "village") radiusKm = 1.5;
        else if (place === "town") radiusKm = 2.0;
        else if (place === "city") radiusKm = 3.0;
        const bufferedPoint = turf.buffer(pt, radiusKm, { units: "kilometers" });
        isAffected = turf.booleanIntersects(bufferedPoint, trackBuffer);
      } else {
        isAffected = turf.booleanIntersects(f, trackBuffer);
      }

      if (!isAffected) continue;

      let bestMs   = trackPoints[0].ms;
      let bestDist = Infinity;

      let centroidCoord;
      try {
        const c = turf.centroid(f);
        centroidCoord = c.geometry.coordinates;
      } catch {
        centroidCoord = [
          (featBbox[0] + featBbox[2]) / 2,
          (featBbox[1] + featBbox[3]) / 2,
        ];
      }

      for (let i = 0; i < trackPoints.length - 1; i++) {
        const p = trackPoints[i];
        const q = trackPoints[i + 1];
        if (q.ms < nowMs - 2 * 60 * 1000) continue;

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
      if (dLast < bestDist) { bestMs = last.ms; }

      if (bestMs < nowMs - 2 * 60 * 1000) continue;

      seen.add(name);
      const minutes_until = Math.round((bestMs - refMs) / 60000);
      const arrival_time  = new Date(bestMs).toLocaleTimeString("de-DE", {
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin",
      });
      orte.push({ name, arrival_time, minutes_until });
    }

    orte.sort((a, b) => (a.minutes_until ?? 0) - (b.minutes_until ?? 0));
    return orte;
  };

  // ── Feature parsen ────────────────────────────────────────────────────────
  const parseFeature = (featureFull, geojson, refTime) => {
    const featureTag = featureFull.match(/<feature([^>]*)>/)?.[0] ?? "";
    const inner      = block(featureFull, "feature") ?? featureFull;

    const meta       = block(inner, "metadata") ?? "";
    const identifier = text(meta, "identifier") ?? attr(featureTag, "identifier") ?? "0";
    const ref_time   = (text(meta, "reference_time") ?? refTime ?? "").trim();

    const dtMatch = ref_time.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):?(\d{2})/);
    const dateStr = dtMatch ? `${dtMatch[1]}${dtMatch[2]}${dtMatch[3]}` : "";
    const timeStr = dtMatch ? `${dtMatch[4]}${dtMatch[5]}` : "";

    const geo              = block(inner, "geometry") ?? "";
    const covered_area     = num(geo, "covered_area");
    const area_growth_rate = num(geo, "area_growth_rate");
    const echo_top_msl     = noFill(num(geo, "echo_top_msl"));
    const echo_bottom_msl  = noFill(num(geo, "echo_bottom_msl"));

    const centroid3d = block(geo, "centroid_3d") ?? block(geo, "centroid3d") ?? "";
    const geodetic   = block(centroid3d, "geodetic_coordinate") ?? centroid3d;
    const lat        = num(geodetic, "latitude");
    const lon        = num(geodetic, "longitude");

    const intens         = block(inner, "intensity") ?? "";
    const severity       = int(intens, "severity") ?? 0;
    const vil_density    = num(intens, "cell_based_VIL_density");
    const max_dbz        = num(intens, "max_value");
    const max_wind_gust  = num(intens, "maximum_estimated_wind_gust");
    const heavy_rain_pot = num(intens, "heavy_rain_potential");

    const light          = block(inner, "lightning") ?? "";
    const lightning_rate = int(light, "lightning_rate") ?? 0;

    const hymec                  = block(inner, "hymec") ?? "";
    const area_hail              = num(hymec, "area_hail")              ?? 0;
    const area_large_hail        = num(hymec, "area_large_hail")        ?? 0;
    const echo_top_hail          = noFill(num(hymec, "echo_top_hail"));
    const echo_top_large_hail    = noFill(num(hymec, "echo_top_large_hail"));
    const echo_bottom_hail       = noFill(num(hymec, "echo_bottom_hail"));
    const echo_bottom_large_hail = noFill(num(hymec, "echo_bottom_large_hail"));
    const hail_flag              = int(inner, "hail_flag");

    // ── Hagelberechnung ───────────────────────────────────────────────
    let hail_cm = null;

    if (hail_flag !== null && hail_flag >= 1) {
      if (hail_flag === 1) {
        const thickness = (echo_top_hail !== null && echo_bottom_hail !== null)
          ? (echo_top_hail - echo_bottom_hail) / 1000
          : 0;
        hail_cm = 0.5 + thickness * 0.1 + area_hail * 0.001;
        hail_cm = Math.min(hail_cm, 1.9);

      } else if (hail_flag === 2) {
        const thickness = (echo_top_hail !== null && echo_bottom_hail !== null)
          ? (echo_top_hail - echo_bottom_hail) / 1000
          : 0;
        hail_cm = 1.0 + thickness * 0.2 + area_hail * 0.003;
        hail_cm = Math.max(hail_cm, 1.0);
        hail_cm = Math.min(hail_cm, 3.9);

      } else if (hail_flag === 3) {
        const thickness = (echo_top_large_hail !== null && echo_bottom_large_hail !== null)
          ? (echo_top_large_hail - echo_bottom_large_hail) / 1000
          : (echo_top_hail !== null && echo_bottom_hail !== null)
            ? (echo_top_hail - echo_bottom_hail) / 1000
            : 0;
        const area = area_large_hail > 0 ? area_large_hail : area_hail;
        hail_cm = 2.0 + thickness * 0.3 + area * 0.005;
        hail_cm = Math.max(hail_cm, 2.0);
      }

      hail_cm = Math.round(hail_cm * 10) / 10;
    }

    // ── Tracking ──────────────────────────────────────────────────────
    const trackBlock = block(inner, "tracking") ?? "";
    const cell_speed = num(trackBlock, "cell_speed");

    const severity_trend = num(trackBlock, "severity_trend") ?? num(inner, "severity_trend");
    const mass_trend     = num(trackBlock, "mass_trend")     ?? num(inner, "mass_trend");

    // ── Zellenentwicklung ─────────────────────────────────────────────
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

    // ── Forecast-Punkte ───────────────────────────────────────────────
    const forecastBlock     = block(inner, "forecast") ?? "";
    const centroidForecasts = block(forecastBlock, "centroid_forecasts") ?? "";
    const cfBlocks          = allBlocks(centroidForecasts, "centroid_forecast");

    let forecast_lat = null;
    let forecast_lon = null;
    const allForecasts = [];

    for (const cf of cfBlocks) {
      const forecast_time = attr(cf.full, "forecast_time");
      const fg   = block(cf.inner, "geodetic_coordinate") ?? cf.inner;
      const fLat = num(fg, "latitude");
      const fLon = num(fg, "longitude");
      if (forecast_lat === null) { forecast_lat = fLat; forecast_lon = fLon; }
      if (fLat && fLon) allForecasts.push({ forecast_time, lat: fLat, lon: fLon });
    }

    let lat3 = null, lon3 = null;
    let perp_point1_lat = null, perp_point1_lon = null;
    let perp_point2_lat = null, perp_point2_lon = null;

    if (lat && lon && forecast_lat && forecast_lon) {
      const dLat = forecast_lat - lat;
      const dLon = forecast_lon - lon;
      const mag  = Math.sqrt(dLat ** 2 + dLon ** 2) || 1;
      lat3 = dLat / mag;
      lon3 = dLon / mag;

      const trackBearing = bearing(lat, lon, forecast_lat, forecast_lon);
      const p1 = destPoint(lat, lon, (trackBearing + 90)  % 360, 25);
      const p2 = destPoint(lat, lon, (trackBearing + 270) % 360, 25);
      perp_point1_lat = p1.lat;
      perp_point1_lon = p1.lon;
      perp_point2_lat = p2.lat;
      perp_point2_lon = p2.lon;
    }

    // ── Turf-basierte Ortserkennung ───────────────────────────────────
    const refMs      = new Date(ref_time).getTime();
    const trackPoints = [];

    if (lat && lon) trackPoints.push({ lat, lon, ms: refMs });
    for (const f of allForecasts) {
      if (!f.forecast_time) continue;
      const ms = new Date(f.forecast_time).getTime();
      if (!isNaN(ms)) trackPoints.push({ lat: f.lat, lon: f.lon, ms });
    }

    const orte = (trackPoints.length > 0 && geojson)
      ? findOrteAlongTrack(trackPoints, geojson, ref_time)
      : [];

    const position = (lat && lon && geojson) ? findNearestPlace(lat, lon, geojson) : null;

    return {
      dateStr,
      timeStr,
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
      perp_point1_lat,
      perp_point1_lon,
      perp_point2_lat,
      perp_point2_lon,
      lon3,
      lat3,
      echo_top_msl,
      echo_bottom_msl,
      covered_area,
      orte,
      centroid_forecasts: allForecasts
        .map(f => ({
          forecast_time:    f.forecast_time,
          latitude:         f.lat,
          longitude:        f.lon,
          minutes_from_ref: f.forecast_time
            ? Math.round((new Date(f.forecast_time) - new Date(ref_time)) / 60000)
            : null,
        }))
        .filter(f => f.minutes_from_ref !== null && f.minutes_from_ref % 10 === 0),
    };
  };

  // ── Handler ───────────────────────────────────────────────────────────────
  try {
    const [{ xml, filename }, geojson, meso_cells] = await Promise.all([
      fetchXml(),
      Promise.resolve(loadGeoJson()),
      fetchMesoCells().catch((err) => {
        console.error("Mesozyklonen-Fetch fehlgeschlagen:", err.message);
        return [];
      }),
    ]);

    const reference_time =
      xml.match(/<reference_time[^>]*>([^<]+)<\/reference_time>/)?.[1]?.trim() ??
      xml.match(/<cells[^>]+reference_time="([^"]+)"/)?.[1]?.trim() ??
      null;

    const creation_date = xml.match(/<creation-date[^>]*>([^<]+)<\/creation-date>/)?.[1]?.trim() ?? null;

    const featureMatches = xml.match(/<feature[\s\S]*?<\/feature>/g) ?? [];
    const cells = featureMatches.map((f) => parseFeature(f, geojson, reference_time));

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