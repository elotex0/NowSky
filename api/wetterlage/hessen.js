import * as cheerio from "cheerio";

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = "https://www.dwd.de/DWD/wetter/wv_allg/deutschland/text/vhdl13_dwoh.html";

    // 1️⃣ Fetch HTML als UTF-8
    const html = await fetch(url)
      .then(r => r.text());

    const $ = cheerio.load(html, { decodeEntities: true });

    // -----------------------------
    // 2️⃣ Allgemeiner Text nach <strong>Wetter- und Warnlage:</strong>
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

      allgemein = preElems.map(el => $(el).text().trim()).join(" ");

      // Alle Wörter entfernen, die mit ":" enden
      allgemein = allgemein.replace(/\b[^\s]+:/g, "").trim();

      // Alle \n durch Leerzeichen ersetzen
      allgemein = allgemein.replace(/\n+/g, " ");
    }

    // -----------------------------
    // 3️⃣ Detaillierter Wetterablauf
    // -----------------------------
    let detaillierter = "";
    const detailliertStrong = $("strong").filter((i, el) =>
      $(el).text().trim().startsWith("Detaillierter Wetterablauf")
    );

    if (detailliertStrong.length > 0) {
      const preElems = detailliertStrong.nextAll("pre");
      detaillierter = preElems.map((i, el) => $(el).text().trim()).get().join(" ");
      // Alle \n durch Leerzeichen ersetzen
      detaillierter = detaillierter.replace(/\n+/g, " ");
    }

    // -----------------------------
    // 4️⃣ JSON ausgeben
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
