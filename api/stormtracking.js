// api/konrad3d.js
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

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

  const findPlacesNearPoint = (lat, lon, geojson, radiusKm = 8) => {
    if (!geojson?.features) return [];
    const results = [];
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
      if (dist <= radiusKm) results.push({ name, dist });
    }
    results.sort((a, b) => a.dist - b.dist);
    return results.map(r => r.name);
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

    let hail_cm = null;
    if (hail_flag !== null && hail_flag >= 1) {
      if (hail_flag >= 3 && echo_top_large_hail !== null && echo_bottom_large_hail !== null) {
        const thickness = (echo_top_large_hail - echo_bottom_large_hail) / 1000;
        hail_cm = Math.round((2.0 + thickness * 0.8 + area_large_hail * 0.05) * 10) / 10;
      } else if (hail_flag >= 2 && echo_top_hail !== null && echo_bottom_hail !== null) {
        const thickness = (echo_top_hail - echo_bottom_hail) / 1000;
        hail_cm = Math.round((1.0 + thickness * 0.4 + area_hail * 0.02) * 10) / 10;
      } else {
        hail_cm = Math.round((0.5 + area_hail * 0.01) * 10) / 10;
      }
      if (hail_flag === 1) hail_cm = Math.min(hail_cm, 1.9);
      if (hail_flag === 2) hail_cm = Math.min(hail_cm, 3.9);
      if (hail_flag === 3) hail_cm = Math.max(hail_cm, 2.0);
    }

    const track      = block(inner, "tracking") ?? "";
    const cell_speed = num(track, "cell_speed");

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
    let orte = [];

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

    // ── Orte entlang der Zugbahn ──────────────────────────────────────────
    const TRACK_RADIUS_KM = 8;

    if (lat && lon && geojson) {
      const seenNames = new Set();
      const refDate   = new Date(ref_time);
      const nowMs     = Date.now();

      const trackPoints = [
        { lat, lon, ms: refDate.getTime() },
        ...allForecasts
          .filter(f => f.forecast_time)
          .map(f => ({ lat: f.lat, lon: f.lon, ms: new Date(f.forecast_time).getTime() })),
      ];

      // Hilfsfunktion: Ort zu orte[] hinzufügen
      const addOrt = (name, ms) => {
        if (seenNames.has(name)) return;
        if (ms < nowMs - 2 * 60 * 1000) return;
        seenNames.add(name);
        const minutes_until = Math.round((ms - refDate.getTime()) / 60000);
        const arrival_time  = new Date(ms).toLocaleTimeString("de-DE", {
          hour:     "2-digit",
          minute:   "2-digit",
          timeZone: "Europe/Berlin",
        });
        orte.push({ name, arrival_time, minutes_until });
      };

      // Schritt 1: Für jeden Trackpunkt direkt alle Orte im Radius erfassen
      for (const p of trackPoints) {
        const nearbyNames = findPlacesNearPoint(p.lat, p.lon, geojson, TRACK_RADIUS_KM);
        for (const name of nearbyNames) {
          addOrt(name, p.ms);
        }
      }

      // Schritt 2: Segment-Interpolation für Orte zwischen zwei Trackpunkten
      const getCentroidFromFeature = (f) => {
        const geom = f.geometry;
        const getCentroid = (coords) => {
          let sumLon = 0, sumLat = 0;
          for (const [lo, la] of coords) { sumLon += lo; sumLat += la; }
          return { lat: sumLat / coords.length, lon: sumLon / coords.length };
        };
        if (geom.type === "Polygon")           return getCentroid(geom.coordinates[0]);
        if (geom.type === "MultiPolygon")      return getCentroid(geom.coordinates[0][0]);
        return null;
      };

      for (let i = 0; i < trackPoints.length - 1; i++) {
        const p  = trackPoints[i];
        const q  = trackPoints[i + 1];
        const ax = q.lat - p.lat, ay = q.lon - p.lon;

        for (const f of geojson.features) {
          const name = f.properties?.name || f.properties?.NAME ||
                       f.properties?.GEN  || f.properties?.name_de || null;
          if (!name || seenNames.has(name)) continue;

          const centroid = getCentroidFromFeature(f);
          if (!centroid) continue;

          const bx = centroid.lat - p.lat, by = centroid.lon - p.lon;
          const t  = Math.max(0, Math.min(1, (bx * ax + by * ay) / (ax * ax + ay * ay)));
          const projLat = p.lat + t * ax;
          const projLon = p.lon + t * ay;
          const dProj   = haversine(centroid.lat, centroid.lon, projLat, projLon);

          if (dProj <= TRACK_RADIUS_KM) {
            const ms = p.ms + t * (q.ms - p.ms);
            addOrt(name, ms);
          }
        }
      }

      orte.sort((a, b) => (a.minutes_until ?? 0) - (b.minutes_until ?? 0));
    }

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
      area_growth_rate,
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

  try {
    const [{ xml, filename }, geojson] = await Promise.all([
      fetchXml(),
      Promise.resolve(loadGeoJson()),
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
    });

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}