import AdmZip from "adm-zip";

const BASE_URL =
  "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/air_temperature/now/";
const STATIONS_URL = BASE_URL + "zehn_now_tu_Beschreibung_Stationen.txt";

// --- Cache 1: Stationsmetadaten (lat/lon) -> ändert sich quasi nie ---
let stationMetaCache = null;
let stationMetaCacheTime = 0;
const STATION_META_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// --- Cache 2: Messwerte (TT_10) -> ändert sich alle 10 Minuten ---
let dataCache = null;
let dataCacheTime = 0;
const DATA_TTL_MS = 10 * 60 * 1000; // 10 Minuten, passend zum DWD-Update-Rhythmus

async function loadStationMeta() {
  const now = Date.now();
  if (stationMetaCache && now - stationMetaCacheTime < STATION_META_TTL_MS) {
    return stationMetaCache;
  }

  const resp = await fetch(STATIONS_URL);
  if (!resp.ok) throw new Error("Stationsliste konnte nicht geladen werden");
  const buf = await resp.arrayBuffer();
  const text = new TextDecoder("latin1").decode(buf);

  const lines = text.trim().split(/\r?\n/);
  const map = {};
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const stationId = parts[0].padStart(5, "0");
    const lat = parseFloat(parts[4]);
    const lon = parseFloat(parts[5]);
    if (!isNaN(lat) && !isNaN(lon)) map[stationId] = { lat, lon };
  }

  stationMetaCache = map;
  stationMetaCacheTime = now;
  return map;
}

function extractTT10(txtContent) {
  const lines = txtContent.trim().split(/\r?\n/);
  const header = lines[0].split(";").map((h) => h.trim());
  const lastLine = lines[lines.length - 1].split(";").map((v) => v.trim());
  const idxDatum = header.indexOf("MESS_DATUM");
  const idxTT10 = header.indexOf("TT_10");
  return {
    mess_datum: lastLine[idxDatum] ?? null,
    tt_10: lastLine[idxTT10] !== undefined ? parseFloat(lastLine[idxTT10]) : null,
  };
}

async function fetchAllStationData(limit) {
  const [listResp, stationMeta] = await Promise.all([
    fetch(BASE_URL),
    loadStationMeta(),
  ]);
  if (!listResp.ok) throw new Error("Verzeichnis konnte nicht geladen werden");
  const html = await listResp.text();

  const zipFiles = Array.from(
    html.matchAll(/href="(10minutenwerte_TU_\d+_now\.zip)"/g)
  ).map((m) => m[1]);

  const filesToProcess = limit ? zipFiles.slice(0, limit) : zipFiles;

  return Promise.all(
    filesToProcess.map(async (filename) => {
      const stationId = filename.match(/TU_(\d+)_now/)[1];
      try {
        const zipResp = await fetch(BASE_URL + filename);
        if (!zipResp.ok) throw new Error("Download fehlgeschlagen");
        const buffer = Buffer.from(await zipResp.arrayBuffer());

        const zip = new AdmZip(buffer);
        const entry = zip.getEntries().find((e) =>
          e.entryName.toLowerCase().endsWith(".txt")
        );
        if (!entry) throw new Error("Keine TXT-Datei im ZIP");

        const txtContent = entry.getData().toString("utf-8");
        const { mess_datum, tt_10 } = extractTT10(txtContent);
        const meta = stationMeta[stationId] || null;

        return {
          id: stationId,
          lat: meta?.lat ?? null,
          lon: meta?.lon ?? null,
          time: mess_datum,
          tt_10,
        };
      } catch (err) {
        return { id: stationId, error: err.message };
      }
    })
  );
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const t0 = Date.now();
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const forceRefresh = req.query.refresh === "1";

  try {
    const now = Date.now();
    const cacheValid =
      dataCache && !limit && now - dataCacheTime < DATA_TTL_MS && !forceRefresh;

    let results;
    if (cacheValid) {
      results = dataCache;
    } else {
      results = await fetchAllStationData(limit);
      if (!limit) {
        dataCache = results;
        dataCacheTime = now;
      }
    }

    res.status(200).json({
      count: results.length,
      cached: cacheValid,
      cache_age_s: cacheValid ? Math.round((now - dataCacheTime) / 1000) : 0,
      duration_ms: Date.now() - t0,
      stations: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
