import * as cheerio from "cheerio";

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = "https://www.dwd.de/DWD/wetter/wv_allg/deutschland/text/vhdl13_dwoh.html";

    // Fetch als ArrayBuffer, dann korrekt decodieren
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder("iso-8859-1"); // DWD-Seiten sind Latin-1
    const html = decoder.decode(buffer);

    const $ = cheerio.load(html, { decodeEntities: true });

    // -----------------------------
    // Allgemeiner Text nach <strong>Wetter- und Warnlage:</strong>
    // -----------------------------
    let allgemein = "";
    const warnlageStrong = $("strong").filter((i, el) =>
      $(el).text().trim().startsWith("Wetter- und Warnlage:")
    );

    if (warnlageStrong.length > 0) {
      let preElems = [];
      let next = warnlageStrong.next();
      while (next.length && next[0].name !== "strong") {
        if (next[0].name === "pre") preElems.push(next);
        next = next.next();
      }

      allgemein = preElems.map(el => $(el).text().trim()).join("");
      // Wörter mit ":" entfernen
      allgemein = allgemein.replace(/\b[^\s]+:/g, "");
      // Alle \n entfernen
      allgemein = allgemein.replace(/\n/g, "");
      // Nach Punkt sicherstellen, dass ein Leerzeichen folgt
      allgemein = allgemein.replace(/\.(?!\s)/g, ". ");
    }

    // -----------------------------
    // Detaillierter Wetterablauf
    // -----------------------------
    let detaillierter = "";
    const detailliertStrong = $("strong").filter((i, el) =>
      $(el).text().trim().startsWith("Detaillierter Wetterablauf")
    );

    if (detailliertStrong.length > 0) {
      const preElems = detailliertStrong.nextAll("pre");
      detaillierter = preElems.map((i, el) => $(el).text().trim()).get().join("");
      // Alle \n entfernen
      detaillierter = detaillierter.replace(/\n/g, "");
      // Nach Punkt sicherstellen, dass ein Leerzeichen folgt
      detaillierter = detaillierter.replace(/\.(?!\s)/g, ". ");
    }

    // -----------------------------
    // JSON ausgeben
    // -----------------------------
    res.status(200).json({
      source: url,
      allgemein,
      detaillierterWetterablauf: detaillierter
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Abruf oder Parsing" });
  }
}
