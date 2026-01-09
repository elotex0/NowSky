// /api/wetterlage/hessen.js
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = "https://www.dwd.de/DWD/wetter/wv_allg/deutschland/text/vhdl13_dwoh.html";
    const html = await fetch(url).then(r => r.text());

    const $ = cheerio.load(html);

    // kompletten <pre>-Block holen
    const preText = $("pre").text().trim();

    // nur ab "Detaillierter Wetterablauf:" nehmen
    const marker = "Detaillierter Wetterablauf:";
    const idx = preText.indexOf(marker);

    const detaillierter =
      idx !== -1
        ? preText.substring(idx + marker.length).trim()
        : null;

    res.status(200).json({
      source: url,
      detaillierterWetterablauf: detaillierter
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Abruf oder Parsing" });
  }
}
