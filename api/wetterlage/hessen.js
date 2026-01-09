import * as cheerio from "cheerio";

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = "https://www.dwd.de/DWD/wetter/wv_allg/deutschland/text/vhdl13_dwoh.html";
    const html = await fetch(url).then(r => r.text());
    const $ = cheerio.load(html);

    // 1️⃣ Den <strong> mit "Detaillierter Wetterablauf:" finden
    const strongElem = $("strong").filter((i, el) =>
      $(el).text().trim().startsWith("Detaillierter Wetterablauf")
    );

    let detaillierter = null;

    if (strongElem.length > 0) {
      // 2️⃣ Nächstes <pre> nach diesem <strong> nehmen
      const preElem = strongElem.nextAll("pre").first();
      detaillierter = preElem.text().trim();
    }

    res.status(200).json({
      source: url,
      detaillierterWetterablauf: detaillierter
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Abruf oder Parsing" });
  }
}
