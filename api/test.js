import AdmZip from "adm-zip";

const BASE_URL =
  "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/air_temperature/now/";
const STATIONS_URL = BASE_URL + "zehn_now_tu_Beschreibung_Stationen.txt";

// Lädt und parsed die Stationsbeschreibung -> Map<stationId, {lat, lon, name, bundesland}>
async function loadStationMeta() {
  const resp = await fetch(STATIONS_URL);
  if (!resp.ok) throw new Error("Stationsliste konnte nicht geladen werden");
  // Encoding ist meist Latin-1, daher über ArrayBuffer + TextDecoder
  const buf = await resp.arrayBuffer();
  const text = new TextDecoder("latin1").decode(buf);

  const lines = text.trim().split(/\r?\n/);
  const map = {};

  // Erste beiden Zeilen sind Header/Trennzeile -> überspringen
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;

    const stationId = parts[0].padStart(5, "0");
    const stationshoehe = parts[3];
    const lat = parseFloat(parts[4]);
    const lon = parseFloat(parts[5]);

    // Rest der Zeile enthält Name/Bundesland/Abgabe, hier nicht benötigt
    if (!isNaN(lat) && !isNaN(lon)) {
      map[stationId] = { lat, lon, height: parseInt(stationshoehe, 10) };
    }
  }

  return map;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const [listResp, stationMeta] = await Promise.all([
      fetch(BASE_URL),
      loadStationMeta(),
    ]);

    if (!listResp.ok) {
      return res.status(502).json({ error: "Verzeichnis konnte nicht geladen werden" });
    }
    const html = await listResp.text();

    const zipFiles = Array.from(
      html.matchAll(/href="(10minutenwerte_TU_\d+_now\.zip)"/g)
    ).map((m) => m[1]);

    if (zipFiles.length === 0) {
      return res.status(404).json({ error: "Keine Stationsdateien gefunden" });
    }

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : zipFiles.length;
    const filesToProcess = zipFiles.slice(0, limit);

    const results = await Promise.all(
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
          const lines = txtContent.trim().split(/\r?\n/);
          const header = lines[0].split(";").map((h) => h.trim());
          const lastLine = lines[lines.length - 1].split(";").map((v) => v.trim());

          const data = {};
          header.forEach((key, i) => (data[key] = lastLine[i]));

          const meta = stationMeta[stationId] || null;

          return {
            station_id: stationId,
            file: filename,
            lat: meta?.lat ?? null,
            lon: meta?.lon ?? null,
            height: meta?.height ?? null,
            data,
          };
        } catch (err) {
          return { station_id: stationId, file: filename, error: err.message };
        }
      })
    );

    res.status(200).json({ count: results.length, stations: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
