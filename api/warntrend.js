import fetch from "node-fetch";

// DD.MM -> Dezimalgrad  (z.B. 49.38 -> 49.6333, -8.40 -> -8.6667)
function ddmmToDecimal(value) {
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutes = (abs - degrees) * 100;
  return sign * (degrees + minutes / 60);
}

async function loadStations() {
  const res = await fetch(
    "https://www.dwd.de/DE/leistungen/met_verfahren_mosmix/mosmix_stationskatalog.cfg?view=nasPublication&nn=16102"
  );
  const text = await res.text();
  const stations = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[-\s]+$/.test(trimmed)) continue;
    if (!/^\d{5}/.test(trimmed) && !/^[A-Z]\d{3,4}/.test(trimmed)) continue;

    const match = line.match(
      /^(\S+)\s+([A-Z]{4}|----)\s+(.+?)\s{2,}(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+)/
    );
    if (!match) continue;

    const [, id, icao, name, latStr, lonStr, elevStr] = match;

    stations.push({
      id,
      icao: icao === "----" ? null : icao,
      name: name.trim(),
      lat: ddmmToDecimal(parseFloat(latStr)),  // ← konvertiert
      lon: ddmmToDecimal(parseFloat(lonStr)),  // ← konvertiert
      elev: parseFloat(elevStr),
    });
  }

  return stations;
}

// ... Rest bleibt exakt gleich
