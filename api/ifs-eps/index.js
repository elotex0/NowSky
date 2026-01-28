export default async function handler(req, res) {
  try {
    // CORS Header setzen
    res.setHeader("Access-Control-Allow-Origin", "*"); // "" = alle Domains erlauben
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    
    const r2Url = "https://pub-710166592004403e95dbb12e0dffaf24.r2.dev/ifs-eps/metadata.json";

    const headers = {};
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secretKey = process.env.R2_SECRET_ACCESS_KEY;
    if (accessKey && secretKey) {
      headers["Authorization"] = `Basic ${Buffer.from(`${accessKey}:${secretKey}`).toString("base64")}`;
    }

    const r2Res = await fetch(r2Url, { headers });
    if (!r2Res.ok) {
      return res.status(404).json({ error: "metadata.json not found", status: r2Res.status });
    }

    const json = await r2Res.json();

    // Aktuelle Zeit in Deutschland (Sommer-/Winterzeit automatisch)
    const now = new Date();
    const berlinTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));

    const filteredVarTypes = {};

    for (const key of json.prob_types) {
      const timesteps = json.timesteps[key];
      if (!timesteps || timesteps.length === 0) continue;

      // Zeitschritte in Date-Objekte parsen
      const timestepsDates = timesteps.map(t => {
        const [dateStr, hourStr] = t.split("_");
        const year = parseInt(dateStr.slice(0, 4));
        const month = parseInt(dateStr.slice(4, 6)) - 1; // JS Monate 0-11
        const day = parseInt(dateStr.slice(6, 8));
        const hour = parseInt(hourStr.slice(0, 2));
        return new Date(year, month, day, hour);
      });

      // Index des ersten Zeitschritts >= aktuelle Zeit
      const berlinHourTime = new Date(berlinTime);
      const startIndex = timestepsDates.findIndex(d => d >= berlinHourTime);

      const filteredTimesteps = startIndex >= 0 
        ? timesteps.slice(startIndex)
        : timesteps; // fallback falls alles in der Vergangenheit

      // === REGION bestimmen ===
      const region = key.includes("_eu") ? "Europa" : "Deutschland";

      filteredVarTypes[key] = {
        region,
        num_steps: filteredTimesteps.length,
        timesteps: filteredTimesteps
      };
    }

    // === SORTIEREN ===
    const sortOrder = [
      // normale Parameter zuerst
      "tp1", "tp10", "tp20", "wind10",
      // dann die _eu-Varianten
      "tp1_eu", "tp10_eu", "tp20_eu", "wind10_eu",
    ];

    const sortedKeys = Object.keys(filteredVarTypes).sort((a, b) => {
    const aBase = a.replace("_eu", "");
    const bBase = b.replace("_eu", "");
  
    const aIndex = sortOrder.findIndex(k => k === aBase);
    const bIndex = sortOrder.findIndex(k => k === bBase);
  
    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
  
    // gleiche Basis: normale zuerst, dann _eu
    if (aBase === bBase) {
      if (a.endsWith("_eu") && !b.endsWith("_eu")) return 1;
      if (!a.endsWith("_eu") && b.endsWith("_eu")) return -1;
      return 0;
    }
  
    return aIndex - bIndex;
  });


    const sortedVarTypes = {};
    for (const k of sortedKeys) {
      sortedVarTypes[k] = filteredVarTypes[k];
    }

    // === generated_at in deutscher Zeit ===
    let generatedAtDE = null;
    if (json.generated_at) {
      const utcDate = new Date(json.generated_at);
      generatedAtDE = new Date(utcDate.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    }

    const filteredJson = {
      run: json.run,
      date: json.date,
      generated_at: generatedAtDE
        ? generatedAtDE.toISOString().replace("T", " ").replace("Z", "")
        : null,
      prob_types: sortedVarTypes
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.status(200).json(filteredJson);

  } catch (err) {
    console.error("Error fetching metadata.json:", err);
    return res.status(500).json({ error: err.message });
  }
}
