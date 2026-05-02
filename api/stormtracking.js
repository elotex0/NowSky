// api/konrad3d.js
// Abruf: /api/konrad3d
// Liefert alle aktuellen Gewitterzellen aus dem DWD KONRAD3D-Produkt (XML v1.4/1.7/1.8)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Aktuellen Dateinamen berechnen (5-Min-Raster + Offset) ──────────
  const buildFilename = (offsetMin) => {
    const t = new Date(Date.now() - offsetMin * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = t.getUTCFullYear();
    const mm   = pad(t.getUTCMonth() + 1);
    const dd   = pad(t.getUTCDate());
    const hh   = pad(t.getUTCHours());
    const min  = pad(Math.floor(t.getUTCMinutes() / 5) * 5);
    return `KONRAD3D_${yyyy}${mm}${dd}T${hh}${min}00`;
  };

  // ── XML-Hilfsfunktionen ──────────────────────────────────────────────

  const text = (xml, tag) => {
    const m = xml.match(new RegExp(`<${tag}(?:[^>]*)>([^<]*)<\/${tag}>`));
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

  // ── Geo-Hilfsfunktionen ──────────────────────────────────────────────

  // Grad → Radiant
  const toRad = (d) => d * Math.PI / 180;
  // Radiant → Grad
  const toDeg = (r) => r * 180 / Math.PI;

  // Haversine-Distanz in km
  const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  // Punkt auf Großkreis: von (lat, lon) in Richtung bearing (°) über dist (km)
  const destPoint = (lat, lon, bearing, dist) => {
    const R = 6371;
    const b = toRad(bearing);
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

  // Kurs (bearing) von Punkt A nach B in Grad
  const bearing = (lat1, lon1, lat2, lon2) => {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
               Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  };

  // Prüft ob ein Punkt (lat/lon) in einem GeoJSON-Polygon liegt (ray-casting)
  const pointInPolygon = (lat, lon, coords) => {
    let inside = false;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const xi = coords[i][0], yi = coords[i][1];
      const xj = coords[j][0], yj = coords[j][1];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  };

  // Findet den Namen des Ortes/Gebiets aus GeoJSON für einen Punkt
  const findPlaceName = (lat, lon, geojson) => {
    if (!geojson || !geojson.features) return null;
    for (const feature of geojson.features) {
      const geom = feature.geometry;
      const name = feature.properties?.name || feature.properties?.NAME ||
                   feature.properties?.GEN  || feature.properties?.name_de || null;
      if (!name) continue;
      if (geom.type === "Polygon") {
        if (pointInPolygon(lat, lon, geom.coordinates[0])) return name;
      } else if (geom.type === "MultiPolygon") {
        for (const poly of geom.coordinates) {
          if (pointInPolygon(lat, lon, poly[0])) return name;
        }
      }
    }
    return null;
  };

  // ── Zugbahn berechnen ────────────────────────────────────────────────
  // Gibt { zielort, lat3, lon3, perp_point1_lat, perp_point1_lon,
  //        perp_point2_lat, perp_point2_lon } zurück
  const computeTrack = (cell, geojson, referenceTime) => {
    const { centroid, cell_speed_kmh, forecast_positions } = cell;
    const lat = centroid?.lat;
    const lon = centroid?.lon;

    if (!lat || !lon || !cell_speed_kmh || !forecast_positions?.length) {
      return { zielort: null, lat3: null, lon3: null,
               perp_point1_lat: null, perp_point1_lon: null,
               perp_point2_lat: null, perp_point2_lon: null };
    }

    // Richtungsvektor aus erstem Forecast-Punkt
    const fp = forecast_positions[0];
    const dLat = fp.lat - lat;
    const dLon = fp.lon - lon;
    const mag  = Math.sqrt(dLat ** 2 + dLon ** 2) || 1;
    const lat3 = dLat / mag;
    const lon3 = dLon / mag;

    // Kurs (bearing) der Zugbahn
    const trackBearing = bearing(lat, lon, fp.lat, fp.lon);

    // Senkrechte Punkte (±25 km quer zur Zugbahn, auf Zentroid-Position)
    const perpDist = 25; // km
    const perp1 = destPoint(lat, lon, (trackBearing + 90)  % 360, perpDist);
    const perp2 = destPoint(lat, lon, (trackBearing + 270) % 360, perpDist);

    // Zugbahn-Stützpunkte: Startpunkt + alle Forecast-Positionen
    const waypoints = [
      { lat, lon, time: referenceTime },
      ...forecast_positions.map(f => ({ lat: f.lat, lon: f.lon, time: f.forecast_time })),
    ];

    // Zeitpunkt berechnen wann Zugbahn einen Punkt passiert
    const arrivalTime = (wpLat, wpLon, wpTime) => {
      if (!wpTime) return null;
      try { return new Date(wpTime); } catch { return null; }
    };

    // Ortsnamen entlang der Zugbahn sammeln (alle 5 min = jeder Forecast-Schritt)
    const stops = [];
    const seenNames = new Set();

    for (const wp of waypoints) {
      const name = findPlaceName(wp.lat, wp.lon, geojson);
      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        const t = arrivalTime(wp.lat, wp.lon, wp.time);
        const timeStr = t
          ? t.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })
          : null;
        stops.push(timeStr ? `${name} (${timeStr})` : name);
      }
    }

    // Zielort: letzter Forecast-Punkt
    if (!stops.length) {
      // Fallback: nur Koordinaten des letzten Forecast-Punkts
      const last = waypoints[waypoints.length - 1];
      const t = arrivalTime(last.lat, last.lon, last.time);
      const timeStr = t
        ? t.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })
        : null;
      stops.push(timeStr ? `${last.lat.toFixed(2)}°N ${last.lon.toFixed(2)}°E (${timeStr})` : null);
    }

    const zielort = stops.filter(Boolean).join(" → ");

    return {
      zielort: zielort || null,
      lat3,
      lon3,
      perp_point1_lat: perp1.lat,
      perp_point1_lon: perp1.lon,
      perp_point2_lat: perp2.lat,
      perp_point2_lon: perp2.lon,
    };
  };

  // ── Feature (= Zelle) parsen ─────────────────────────────────────────
  const parseFeature = (featureFull) => {
    const featureTag = featureFull.match(/<feature([^>]*)>/)?.[0] ?? "";
    const inner = block(featureFull, "feature") ?? featureFull;

    const meta = block(inner, "metadata") ?? "";
    const identifier         = text(meta, "identifier");
    const code               = text(meta, "code");
    const reference_time     = text(meta, "reference_time");
    const dimension          = int(meta, "dimension");
    const number_2d_features = int(meta, "number_2D_features");

    const geo = block(inner, "geometry") ?? "";
    const covered_area     = num(geo, "covered_area");
    const area_growth_rate = num(geo, "area_growth_rate");
    const echo_top_msl     = noFill(num(geo, "echo_top_msl"));
    const echo_bottom_msl  = noFill(num(geo, "echo_bottom_msl"));
    const vertical_extent  = num(geo, "vertical_extent");
    const volume_km3       = num(geo, "volume");

    const centroid3d = block(geo, "centroid_3d") ?? block(geo, "centroid3d") ?? "";
    const geodetic   = block(centroid3d, "geodetic_coordinate") ?? centroid3d;
    const lat        = num(geodetic, "latitude");
    const lon        = num(geodetic, "longitude");
    const height_msl = num(geodetic, "height_msl");

    const ue_centroid = block(centroid3d, "uncertainty_ellipse") ?? "";
    const uncertainty_ellipse = ue_centroid ? {
      major_axis_km: num(ue_centroid, "major_axis"),
      minor_axis_km: num(ue_centroid, "minor_axis"),
      angle_deg:     num(ue_centroid, "angle"),
    } : null;

    const polygons = [];
    const geoCoords = block(geo, "geodetic_coordinates") ?? "";
    const polyBlocks = allBlocks(geoCoords, "polygon");
    for (const pb of polyBlocks) {
      const latsRaw = text(pb.inner, "latitudes") ?? "";
      const lonsRaw = text(pb.inner, "longitudes") ?? "";
      const lats = latsRaw.trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
      const lons = lonsRaw.trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
      polygons.push(lats.map((la, i) => ({ lat: la, lon: lons[i] ?? null })));
    }

    const intens = block(inner, "intensity") ?? "";
    const severity             = int(intens, "severity");
    const severity_decimal     = num(intens, "severity_decimal");
    const severity_trend_cat   = int(block(intens, "trends") ?? "", "severity_trend_category");
    const hail_flag            = int(intens, "hail_flag");
    const heavy_rain_flag      = int(intens, "heavy_rain_flag");
    const gust_flag            = (() => { const v = int(intens, "gust_flag"); return v === -1000000000 ? null : v; })();
    const max_wind_gust_kmh    = num(intens, "maximum_estimated_wind_gust");
    const vil                  = num(intens, "cell_based_VIL");
    const vil_density          = num(intens, "cell_based_VIL_density");
    const max_dbz              = num(intens, "max_value");
    const min_dbz              = num(intens, "min_value");
    const avg_dbz              = num(intens, "average_value");
    const heavy_rain_potential = num(intens, "heavy_rain_potential");
    const hrp_accum_time_min   = num(intens, "heavy_rain_potential_accumulation_time");
    const blue_chimney_m       = num(intens, "blue_chimney_mean_vertical_extent");

    const trendsBlock = block(intens, "trends") ?? "";
    const trends = {
      severity_trend:          num(trendsBlock, "severity_trend"),
      severity_trend_category: severity_trend_cat,
      vil_trend:               num(trendsBlock, "cell_based_VIL_trend"),
      max_dbz_trend:           num(trendsBlock, "max_value_trend"),
      area_45dbz_trend_km2:    num(trendsBlock, "area_of_projected_polygon_above_45_dBZ_trend"),
      echo_top_45dbz_trend_m:  num(trendsBlock, "echo_top_45_dBZ_trend"),
      mass_trend:              num(trendsBlock, "mass_trend"),
    };

    const areaThresh = {};
    for (const m of (intens.matchAll(/<area_of_projected_polygon threshold="([^"]+)"[^>]*>([^<]+)<\/area_of_projected_polygon>/g) ?? [])) {
      areaThresh[m[1]] = parseFloat(m[2]);
    }

    const echoTopThresh = {};
    for (const m of (intens.matchAll(/<echo_top threshold="([^"]+)"[^>]*>([^<]+)<\/echo_top>/g) ?? [])) {
      echoTopThresh[m[1]] = parseFloat(m[2]);
    }

    const hymec = block(inner, "hymec") ?? "";
    const hail_info = hymec ? {
      echo_top_hail_m:       noFill(num(hymec, "echo_top_hail")),
      echo_top_large_hail_m: noFill(num(hymec, "echo_top_large_hail")),
      echo_top_hail_total_m: noFill(num(hymec, "echo_top_hail_total")),
      area_hail_km2:         num(hymec, "area_hail"),
      area_large_hail_km2:   num(hymec, "area_large_hail"),
      area_hail_total_km2:   num(hymec, "area_hail_total"),
      volume_hail_km3:       num(hymec, "volume_hail"),
      volume_large_hail_km3: num(hymec, "volume_large_hail"),
    } : null;

    const light = block(inner, "lightning") ?? "";
    const lightning_info = light ? {
      rate_per_5min:  int(light, "lightning_rate"),
      density:        num(light, "lightning_density"),
      jumps_detected: int(light, "number_detected_lightning_jumps"),
      last_jump_time: (() => {
        const v = text(light, "reference_time_last_lightning_jump");
        return v === "not-a-date-time" ? null : v;
      })(),
    } : null;

    const track = block(inner, "tracking") ?? "";
    const first_detected    = text(track, "reference_time_first_detection");
    const number_detections = int(track, "number_detections");
    const cell_speed_kmh    = num(track, "cell_speed");
    const merge_event       = text(track, "merge_event") === "true";
    const split_event       = text(track, "split_event") === "true";

    const predecessors = [];
    for (const pb of allBlocks(block(track, "predecessors") ?? "", "predecessor")) {
      predecessors.push({
        identifier:  text(pb.inner, "identifier"),
        code:        text(pb.inner, "code"),
        time:        text(pb.inner, "time"),
        probability: num(pb.inner, "probability"),
      });
    }

    const forecasts = [];
    const forecastBlock     = block(inner, "forecast") ?? "";
    const centroidForecasts = block(forecastBlock, "centroid_forecasts") ?? "";
    for (const cf of allBlocks(centroidForecasts, "centroid_forecast")) {
      const forecast_time = attr(cf.full, "forecast_time");
      const fg  = block(cf.inner, "geodetic_coordinate") ?? cf.inner;
      const fue = block(cf.inner, "uncertainty_ellipse") ?? "";
      forecasts.push({
        forecast_time,
        lat: num(fg, "latitude"),
        lon: num(fg, "longitude"),
        uncertainty_ellipse: fue ? {
          major_axis_km: num(fue, "major_axis"),
          minor_axis_km: num(fue, "minor_axis"),
          angle_deg:     num(fue, "angle"),
        } : null,
      });
    }

    return {
      identifier,
      code,
      type: attr(featureTag, "type"),
      reference_time,
      first_detected: first_detected === "not-a-date-time" ? null : first_detected,
      number_detections,
      dimension,
      number_2d_features,
      centroid: { lat, lon, height_msl_m: height_msl, uncertainty_ellipse },
      covered_area_km2: covered_area,
      area_growth_rate,
      echo_top_msl_m:    echo_top_msl,
      echo_bottom_msl_m: echo_bottom_msl,
      vertical_extent_m: vertical_extent,
      volume_km3,
      polygon: polygons.length > 0 ? polygons[0] : [],
      severity,
      severity_decimal,
      max_dbz,
      min_dbz,
      avg_dbz,
      vil_kg_m2:        vil,
      vil_density_g_m3: vil_density,
      blue_chimney_m,
      flags: { hail: hail_flag, heavy_rain: heavy_rain_flag, gust: gust_flag },
      max_wind_gust_kmh,
      heavy_rain_potential_mm:   heavy_rain_potential,
      hrp_accumulation_time_min: hrp_accum_time_min,
      hail:      hail_info,
      lightning: lightning_info,
      trends,
      area_above_threshold_km2:  Object.keys(areaThresh).length   > 0 ? areaThresh    : undefined,
      echo_top_threshold_m:      Object.keys(echoTopThresh).length > 0 ? echoTopThresh : undefined,
      cell_speed_kmh,
      merge_event,
      split_event,
      predecessors,
      forecast_positions: forecasts,
    };
  };

  // ── DWD-Datei abrufen (Fallback auf ältere Dateien) ──────────────────
  const fetchXml = async () => {
    for (const offset of [5, 10, 15, 20]) {
      const filename = buildFilename(offset);
      const url = `https://opendata.dwd.de/weather/radar/konrad3d/${filename}.xml`;
      const r = await fetch(url, {
        headers: { "User-Agent": "konrad3d-api/1.0" },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) return { xml: await r.text(), filename };
    }
    throw new Error("Keine aktuelle KONRAD3D-Datei verfügbar (tried offsets 5–20 min)");
  };

  // ── GeoJSON laden ────────────────────────────────────────────────────
  const fetchGeoJson = async () => {
    try {
      const baseUrl = `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`;
      const r = await fetch(`${baseUrl}/api/deutschland.geojson`, {
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) return await r.json();
    } catch (_) {}
    return null;
  };

  // ── Hauptlogik ───────────────────────────────────────────────────────
  try {
    const [{ xml, filename }, geojson] = await Promise.all([
      fetchXml(),
      fetchGeoJson(),
    ]);

    const reference_time = xml.match(/<reference_time[^>]*>([^<]+)<\/reference_time>/)?.[1] ?? null;
    const creation_date  = xml.match(/<creation-date[^>]*>([^<]+)<\/creation-date>/)?.[1]  ?? null;

    const featureRe      = /<feature[\s\S]*?<\/feature>/g;
    const featureMatches = xml.match(featureRe) ?? [];

    const cells = featureMatches.map((f) => {
      const cell  = parseFeature(f);
      const track = computeTrack(cell, geojson, cell.reference_time);
      return { ...cell, ...track };
    });

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
