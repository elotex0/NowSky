// /api/wetterlage/hessen.js
import axios from "axios";
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const url = "https://www.dwd.de/DWD/wetter/wv_allg/deutschland/text/vhdl13_dwoh.html";

  try {
    const response = await axios.get(url, { responseType: "text" });
    const $ = cheerio.load(response.data);

    // kompletten <pre>-Block nehmen
    const preText = $("pre").text().trim();

    // Abschnitt ab "Detaillierter Wetterablauf:"
    const startMarker = "Detaillierter Wetterablauf:";
    const startIndex = preText.indexOf(startMarker);

    let wetterAblauf = null;

    if (startIndex !== -1) {
      wetterAblauf = preText
        .substring(startIndex + startMarker.length)
        .trim();
    }

    return res.status(200).json({
      source: url,
      detaillierterWetterablauf: wetterAblauf,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Abruf der Wetterdaten" });
  }
}
