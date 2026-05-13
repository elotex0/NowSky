// api/konrad3d.js
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as turf from "@turf/turf";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── GeoJSON-Cache (einmal laden, dann im Speicher halten) ─────────────────────
let _geojsonCache = null;
const loadGeoJson = () => {
  if (_geojsonCache) return _geojsonCache;
  try {
    const filePath = path.join(__dirname, "../deutschland.geojson");
    _geojsonCache = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return _geojsonCache;
  } catch (e) {
    console.error("GeoJSON laden fehlgeschlagen:", e.message);
    return null;
  }
};

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

  // ── fetchXml — parallel statt sequenziell ────────────────────────────────
  const fetchXml = async () => {
    const results = await Promise.allSettled(
      [5, 10, 15, 20].map(async (offset) => {
        const filename = buildFilename(offset);
        const url = `https://opendata.dwd.de/weather/radar/konrad3d/${filename}.xml`;
        const r = await fetch(url, {
          headers: { "User-Agent": "konrad3d-api/1.0" },
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { xml: await r.text(), filename };
      })
    );
    const first = results.find((r) => r.status === "fulfilled");
    if (first) return first.value;
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
    const refMs     = new Date(ref_time).getTime();

    const trackMinLat = Math.min(...trackPoints.map(p => p.lat));
    const trackMaxLat = Math.max(...trackPoints.map(p => p.lat));
    const trackMinLon = Math.min(...trackPoints.map(p => p.lon));
    const trackMaxLon = Math.max(...trackPoints.map(p => p.lon));
    const PAD = 0.5;

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
        featBbox[2] < trackMinLon - PAD ||
        featBbox[0] > trackMaxLon + PAD ||
        featBbox[3] < trackMinLat - PAD ||
        featBbox[1] > trackMaxLat + PAD
      ) continue;

      if (
        featBbox[2] < bufferBbox[0] ||
        featBbox[0] > bufferBbox[2] ||
        featBbox[3] < bufferBbox[1] ||
        featBbox[1] > bufferBbox[3]
      ) continue;

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

      const refPoint = trackPoints[0];
      const quickDist = haversine(centroidCoord[1], centroidCoord[0], refPoint.lat, refPoint.lon);
      if (quickDist > 80) continue;

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

      for (let i = 0; i < trackPoints.length - 1; i++) {
        const p = trackPoints[i];
        const q = trackPoints[i + 1];

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


    // ── NWP-Modell parsen ─────────────────────────────────────────────────
    const nwpBlock = block(inner, "nwp_model") ?? "";
    const nwp_mu_cape    = num(nwpBlock, "nwp_mu_cape");
    const nwp_mu_cin     = num(nwpBlock, "nwp_mu_cin");
    const nwp_mu_lcl_hgt = num(nwpBlock, "nwp_mu_lcl_hgt");
    const nwp_mu_lfc_hgt = num(nwpBlock, "nwp_mu_lfc_hgt");
    const nwp_mu_el_hgt  = num(nwpBlock, "nwp_mu_el_hgt");
    const nwp_bs_01km    = num(nwpBlock, "nwp_bs_01km");
    const nwp_bs_06km    = num(nwpBlock, "nwp_bs_06km");
    const nwp_bs_eff_mu  = num(nwpBlock, "nwp_bs_eff_mu");
    const nwp_srh_1km_rm = num(nwpBlock, "nwp_srh_1km_rm");
    const nwp_srh_3km_rm = num(nwpBlock, "nwp_srh_3km_rm");
    const nwp_lr_500800  = num(nwpBlock, "nwp_lr_500800hPa"); // K/km, negativ = labil
    const nwp_prcp_water = num(nwpBlock, "nwp_prcp_water");
    const nwp_dcape      = num(nwpBlock, "nwp_dcape");

    // ── Konvektionsindizes berechnen ──────────────────────────────────────
    // Alle Formeln auf verfügbare Parameter beschränkt (kein T500 verfügbar)

    // STP — Significant Tornado Parameter (Thompson et al. 2003, vereinfacht)
    // STP = (CAPE/1500) * ((2000-LCL_m)/1000) * (SRH1km/150) * (BS06km/20)
    // LCL-Capping: wenn LCL > 2000m → 0, wenn LCL < 1000m → 1.0
    let nwp_stp = null;
    if (nwp_mu_cape !== null && nwp_mu_lcl_hgt !== null &&
        nwp_srh_1km_rm !== null && nwp_bs_06km !== null) {
      const cape_term = nwp_mu_cape / 1500;
      const lcl_m     = nwp_mu_lcl_hgt;
      const lcl_term  = lcl_m >= 2000 ? 0 : Math.max(0, (2000 - lcl_m) / 1000);
      const srh_term  = Math.max(0, nwp_srh_1km_rm) / 150;
      const shr_term  = nwp_bs_06km / 20;
      nwp_stp = Math.round(cape_term * lcl_term * srh_term * shr_term * 100) / 100;
    }

    // SCP — Supercell Composite Parameter (Thompson et al. 2004)
    // SCP = (CAPE/1000) * (SRH3km/100) * (BS06km/20)
    // DCAPE-Term weggelassen (optional, verschlechtert nicht)
    let nwp_scp = null;
    if (nwp_mu_cape !== null && nwp_srh_3km_rm !== null && nwp_bs_06km !== null) {
      const cape_term = nwp_mu_cape / 1000;
      const srh_term  = Math.max(0, nwp_srh_3km_rm) / 100;
      const shr_term  = nwp_bs_06km / 20;
      nwp_scp = Math.round(cape_term * srh_term * shr_term * 100) / 100;
    }

    // SHIP_modified — Hagelpotenzial ohne T500
    // Fokus auf: Energie, Steilheit der Schichtung und Trockenheit der Luft (Evaporative Cooling)
    let nwp_ship_mod = null;
    if (nwp_mu_cape !== null && nwp_lr_500800 !== null && 
        nwp_prcp_water !== null && nwp_bs_06km !== null) {
        
        // 1. CAPE Term: Basis-Energie (Normierung auf 2000 J/kg)
        const cape_term = nwp_mu_cape / 2000;
        
        // 2. Lapse Rate Term: Je steiler (höherer negativer Wert), desto besser das Partikelwachstum
        // nwp_lr_500800 ist bei dir negativ für labil, daher Math.abs
        const lr_term = Math.abs(nwp_lr_500800) / 7.5;
        
        // 3. Scherungs-Term: Organisierte Zellen produzieren größeren Hagel
        const shr_term = nwp_bs_06km / 20;
        
        // 4. Feuchte-Malus: Zu viel Wasser (PW) führt zu "warmem" Regen/Schmelzen.
        // Ein PW von 20-30mm ist ideal für Hagel, >45mm oft zu tropisch (Schmelzgefahr).
        const pw_factor = nwp_prcp_water > 40 ? 0.7 : (nwp_prcp_water < 15 ? 0.5 : 1.0);

        // Berechnung
        nwp_ship_mod = Math.round(cape_term * lr_term * shr_term * pw_factor * 100) / 100;
    }

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
      forecast_lat = fLat;
      forecast_lon = fLon;
      if (fLat && fLon) allForecasts.push({ forecast_time, lat: fLat, lon: fLon });
    }

    let lat3 = null, lon3 = null;
    let perp_point1_lat = null, perp_point1_lon = null;
    let perp_point2_lat = null, perp_point2_lon = null;

    if (lat && lon && forecast_lat && forecast_lon) {
      const dLat = forecast_lat - lat;
      const dLon = forecast_lon - lon;
      lat3 = dLat;
      lon3 = dLon;

      const trackBearing = bearing(lat, lon, forecast_lat, forecast_lon);
      const trackDist = haversine(lat, lon, forecast_lat, forecast_lon);
      const coneWidth = Math.max(25, trackDist * 0.5);
      const p1 = destPoint(forecast_lat, forecast_lon, (trackBearing + 90)  % 360, coneWidth);
      const p2 = destPoint(forecast_lat, forecast_lon, (trackBearing + 270) % 360, coneWidth);
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
      nwp: {
        mu_cape:    nwp_mu_cape,
        mu_cin:     nwp_mu_cin,
        mu_lcl_hgt: nwp_mu_lcl_hgt,
        mu_lfc_hgt: nwp_mu_lfc_hgt,
        mu_el_hgt:  nwp_mu_el_hgt,
        bs_01km:    nwp_bs_01km,
        bs_06km:    nwp_bs_06km,
        bs_eff_mu:  nwp_bs_eff_mu,
        srh_1km_rm: nwp_srh_1km_rm,
        srh_3km_rm: nwp_srh_3km_rm,
        srh_1km_lm: num(nwpBlock, "nwp_srh_1km_lm"),
        srh_3km_lm: num(nwpBlock, "nwp_srh_3km_lm"),
        lr_500800hPa: nwp_lr_500800,
        prcp_water:   nwp_prcp_water,
        dcape:        nwp_dcape,
      },
      // Berechnete Indizes
      nwp_indices: {
        stp:         nwp_stp,          // Significant Tornado Parameter
        scp:         nwp_scp,          // Supercell Composite Parameter
        vgp:         nwp_vgp,          // Vorticity Generation Parameter
        ship:        nwp_ship_mod,     // Significant Hail Parameter
      },
      centroid_forecasts: allForecasts
        .map(f => ({
          forecast_time:    f.forecast_time,
          latitude:         parseFloat(f.lat.toFixed(5)),
          longitude:        parseFloat(f.lon.toFixed(5)),
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
