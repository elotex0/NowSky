export default async function handler(req, res) {
  try {
    // CORS Header setzen
    res.setHeader("Access-Control-Allow-Origin", "*"); // "" = alle Domains erlauben
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    
    const r2Url = "https://pub-9863c1e2db83469a9497b53320eb13da.r2.dev/icon-ruc-eps/metadata.json";

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
    const berlinTime = new Date(
      now.toLocaleString("en-US", { timeZone: "Europe/Berlin" })
    );

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

      filteredVarTypes[key] = {
        num_steps: filteredTimesteps.length,
        timesteps: filteredTimesteps
      };
    }

    // === NEU: generated_at in deutscher Zeit ===
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
      prob_types: filteredVarTypes
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
