import AdmZip from "adm-zip";

const BASE_URL =
  "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/air_temperature/now/";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const listResp = await fetch(BASE_URL);
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

          return { station_id: stationId, file: filename, data };
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
