// api/konrad3d.js
// Abruf: /api/konrad3d
// Liefert alle aktuellen Gewitterzellen aus dem DWD KONRAD3D-Produkt als JSON.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Aktuellen Dateinamen berechnen (5-Min-Raster, ~5 Min Puffer) ────
  const latestFilename = (offsetMin = 5) => {
    const t = new Date(Date.now() - offsetMin * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = t.getUTCFullYear();
    const mm   = pad(t.getUTCMonth() + 1);
    const dd   = pad(t.getUTCDate());
    const hh   = pad(t.getUTCHours());
    const min  = pad(Math.floor(t.getUTCMinutes() / 5) * 5);
    return `KONRAD3D_${yyyy}${mm}${dd}T${hh}${min}00`;
  };

  // ── XML-Attribute eines Tags als Objekt ─────────────────────────────
  const attrsOf = (str) => {
    const obj = {};
    const re = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const val = m[2];
      obj[m[1]] = val !== "" && !isNaN(val) ? parseFloat(val) : val;
    }
    return obj;
  };

  // ── Eine <cell>...</cell> in ein Objekt parsen ───────────────────────
  const parseCell = (cellStr) => {
    const root = attrsOf(cellStr.match(/<cell[^>]*/)?.[0] ?? "");

    const sub = (tag) => {
      const m = cellStr.match(new RegExp(`<${tag}([^/]*)\/?>`));
      return m ? attrsOf(m[0]) : null;
    };

    // forecast_positions (t+5 … t+60)
    const forecasts = [];
    const fRe = /<forecast_position([^/]*)\/>/g;
    let fm;
    while ((fm = fRe.exec(cellStr)) !== null) {
      const f = attrsOf(fm[0]);
      forecasts.push({
        lead_time:   f.lead_time   ?? null,
        lat:         f.lat         ?? null,
        lon:         f.lon         ?? null,
        probability: f.probability ?? null,
      });
    }

    // past_positions
    const history = [];
    const hRe = /<past_position([^/]*)\/>/g;
    let hm;
    while ((hm = hRe.exec(cellStr)) !== null) {
      const p = attrsOf(hm[0]);
      history.push({ time: p.time ?? null, lat: p.lat ?? null, lon: p.lon ?? null });
    }

    const motion = sub("motion");

    return {
      id:                   root.id              ?? null,
      track_id:             root.track_id        ?? null,
      category:             root.category        ?? null,
      severity:             root.severity_class  ?? null,
      lat:                  root.lat             ?? null,
      lon:                  root.lon             ?? null,
      max_dbz:              root.max_zh          ?? null,
      echo_top_km:          root.echo_top        ?? null,
      area_km2:             root.area            ?? null,
      vil:                  root.vil             ?? null,
      lifetime_min:         root.lifetime        ?? null,
      hail_flag:            root.hail_flag       ?? null,
      heavy_rain_flag:      root.heavy_rain_flag ?? null,
      gust_flag:            root.gust_flag       ?? null,
      lightning_flag:       root.lightning_flag  ?? null,
      intensity_trend:      root.intensity_trend ?? null,
      heavy_rain_potential: root.heavy_rain_potential ?? null,
      motion: motion ? {
        speed_kmh:     motion.speed     ?? null,
        direction_deg: motion.direction ?? null,
      } : null,
      forecast_positions: forecasts,
      past_positions:     history,
    };
  };

  // ── DWD-Datei abrufen (Fallback auf ältere Dateien) ──────────────────
  const fetchXml = async () => {
    for (const offset of [5, 10, 15]) {
      const filename = latestFilename(offset);
      const url = `https://opendata.dwd.de/weather/radar/konrad3d/${filename}.xml`;
      const r = await fetch(url, {
        headers: { "User-Agent": "konrad3d-api/1.0" },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) return { xml: await r.text(), filename };
    }
    throw new Error("Keine aktuelle KONRAD3D-Datei verfügbar");
  };

  // ── Hauptlogik ───────────────────────────────────────────────────────
  try {
    const { xml, filename } = await fetchXml();

    const refTime      = xml.match(/<reference_time[^>]*>([^<]+)<\/reference_time>/)?.[1] ?? null;
    const creationDate = xml.match(/<creation-date[^>]*>([^<]+)<\/creation-date>/)?.[1] ?? null;

    // Alle Zellen extrahieren
    const cellStrings = [];
    let m;

    const blockRe = /<cell[\s>]([\s\S]*?)<\/cell>/g;
    while ((m = blockRe.exec(xml)) !== null) cellStrings.push("<cell " + m[1] + "</cell>");

    const selfRe = /<cell([^>]*?)\/>/g;
    while ((m = selfRe.exec(xml)) !== null) cellStrings.push("<cell" + m[1] + "/>");

    const cells = cellStrings.map(parseCell);

    return res.status(200).json({
      reference_time:      refTime,
      creation_date:       creationDate,
      file:                filename + ".xml",
      stormtracking_cells: cells,
    });

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
