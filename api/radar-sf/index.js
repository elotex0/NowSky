export default async function handler(req, res) {
  try {
    // === CORS Header setzen ===
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    const r2Url = "https://pub-22f1eda4cebd44cfb086561379ac356c.r2.dev/radar-sf/metadata.json";

    const headers = {};
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secretKey = process.env.R2_SECRET_ACCESS_KEY;
    if (accessKey && secretKey) {
      headers["Authorization"] = `Basic ${Buffer.from(`${accessKey}:${secretKey}`).toString("base64")}`;
    }

    // === metadata.json von R2 abrufen ===
    const r2Res = await fetch(r2Url, { headers });
    if (!r2Res.ok) {
      return res.status(404).json({ error: "metadata.json not found", status: r2Res.status });
    }

    const json = await r2Res.json();

    // === generated_at in deutsche Zeit konvertieren ===
    let generatedAtDE = null;
    if (json.generated_at) {
      const utcDate = new Date(json.generated_at);
      const berlinTimeStr = utcDate.toLocaleString("en-US", { timeZone: "Europe/Berlin" });
      generatedAtDE = new Date(berlinTimeStr);
    }

    // === Gefiltertes JSON erstellen ===
    const filteredJson = {
      date: json.date || null,
      file: json.file || null,
      generated_at: generatedAtDE
        ? generatedAtDE.toISOString().replace("T", " ").replace("Z", "")
        : null
    };

    // === Response Header ===
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
