import * as cheerio from "cheerio";

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = "https://www.dwd.de/DWD/wetter/wv_allg/deutschland/text/vhdl13_dwsg.html";

    // Fetch als ArrayBuffer, korrekt decodieren
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder("iso-8859-1");
    const html = decoder.decode(buffer);

    const $ = cheerio.load(html, { decodeEntities: true });

    // -----------------------------
    // 1️⃣ updatedAt
    // -----------------------------
    let updatedAt = null;
    const strongElems = $("#wettertext strong");
    strongElems.each((i, el) => {
      const text = $(el).text().trim();
      if (text.includes("am ")) {
        // alles nach "am " nehmen
        const idx = text.indexOf("am ");
        updatedAt = text.substring(idx + 3).replace(/\s+/g, " ").trim();
        return false; // break
      }
    });

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

      allgemein = preElems.map(el => $(el).text().trim()).join("");
      allgemein = allgemein.replace(/\b[^\s]+:/g, ""); // Wörter mit : entfernen
      allgemein = allgemein.replace(/\n/g, "");         // \n entfernen
      allgemein = allgemein.replace(/\.(?!\s)/g, ". "); // Punkt + Leerzeichen
    }

    // -----------------------------
    // 3️⃣ Detaillierter Wetterablauf
    // -----------------------------
    let detaillierter = [];
    const detailliertStrong = $("strong").filter((i, el) =>
      $(el).text().trim().startsWith("Detaillierter Wetterablauf")
    );

    if (detailliertStrong.length > 0) {
      const preElems = detailliertStrong.nextAll("pre");
      preElems.each((i, el) => {
        let text = $(el).text().trim();
        text = text.replace(/\b[^\s]+:/g, ""); // Wörter mit : entfernen
        text = text.replace(/\n/g, "");         // \n entfernen
        text = text.replace(/\.(?!\s)/g, ". "); // Punkt + Leerzeichen
        if (text.length > 0) detaillierter.push(text);
      });
    }


    // -----------------------------
    // 4️⃣ JSON ausgeben
    // -----------------------------
    res.status(200).json({
      source: url,
      updatedAt,
      allgemein,
      detaillierterWetterablauf: detaillierter
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Abruf oder Parsing" });
  }
}
