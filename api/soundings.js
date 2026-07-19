// api/sounding-sars.js
//
// Beispiel-Aufruf:
//   /api/sounding-sars?lat=48.7419&lon=9.211
//   /api/sounding-sars?lat=48.7419&lon=9.211&time=2026-07-19T21:30:00  (optional, sonst "jetzt")
//
// Ermittelt automatisch den neuesten ICON-D2/GERMANY Run und den passenden
// Forecast-Step für die gewünschte Uhrzeit (Europe/Berlin, auf volle Stunde
// abgerundet) und gibt NUR die SARS-Wahrscheinlichkeiten für Supercell/Hail
// zurück.

const BASE = "https://data2.weatherwise.app";
const MODEL = "ICON-D2";
const REGION = "GERMANY";
const MAX_STEP = 48; // Absicherung, falls Ziel-Zeit außerhalb des Forecast-Horizonts liegt

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { lat, lon, time } = req.query;
    if (!lat || !lon) {
      return res.status(400).json({ error: "lat und lon sind erforderlich" });
    }

    // 1) Neuesten Run ermitteln
    const dirListResp = await fetch(`${BASE}/models/processed/${MODEL}/${REGION}/dir.list`);
    if (!dirListResp.ok) {
      return res.status(502).json({ error: "dir.list konnte nicht geladen werden" });
    }
    const dirListText = await dirListResp.text();
    const runs = dirListText.trim().split("\n").filter(Boolean);
    if (runs.length === 0) {
      return res.status(502).json({ error: "Keine Runs verfügbar" });
    }
    const latestRun = runs[runs.length - 1]; // z.B. "2026_07_19_15_00_00"

    // 2) Zielzeit bestimmen (Europe/Berlin, auf volle Stunde abgerundet)
    const targetInstant = time ? new Date(time) : new Date();
    if (isNaN(targetInstant.getTime())) {
      return res.status(400).json({ error: "Ungültiger time-Parameter" });
    }
    const targetWall = getBerlinWallClockFloored(targetInstant);

    // 3) Run-String in UTC-Date parsen
    const runDate = parseRunString(latestRun);

    // 4) Passenden Step finden: run(UTC) + step[h] muss (in Berlin-Wallclock)
    //    exakt targetWall entsprechen
    let step = null;
    for (let s = 0; s <= MAX_STEP; s++) {
      const validInstant = new Date(runDate.getTime() + s * 3600 * 1000);
      const validWall = getBerlinWallClockFloored(validInstant);
      if (validWall.getTime() === targetWall.getTime()) {
        step = s;
        break;
      }
    }
    if (step === null) {
      return res.status(422).json({
        error: "Zielzeit liegt außerhalb des Forecast-Horizonts dieses Runs",
        run: latestRun,
        maxStep: MAX_STEP,
      });
    }

    // 5) Sounding abrufen
    const soundingUrl =
      `${BASE}/api/models/v1/sounding/?model=${MODEL}&region=${REGION}` +
      `&run=${latestRun}&step=${step}&lat=${lat}&lon=${lon}&format=json`;

    const soundingResp = await fetch(soundingUrl);
    if (!soundingResp.ok) {
      return res.status(502).json({ error: "Sounding-API-Fehler", status: soundingResp.status });
    }
    const data = await soundingResp.json();
    const sars = data?.indices?.sars;

    if (!sars) {
      return res.status(502).json({ error: "Keine SARS-Daten in der Antwort enthalten" });
    }

    return res.status(200).json({
      run: latestRun,
      step,
      valid_local: targetWall.toISOString().replace(".000Z", "Z"),
      lat: Number(lat),
      lon: Number(lon),
      sars: {
        supercell: sars.supercell ?? { matches: [], loose: 0, prob: 0 },
        hail: sars.hail ?? { matches: [], loose: 0, prob: 0 },
      },
    });
  } catch (err) {
    return res.status(500).json({ error: "Interner Fehler", detail: String(err) });
  }
}

// Parst "2026_07_19_15_00_00" als UTC-Zeitpunkt
function parseRunString(runStr) {
  const [y, m, d, h, min, s] = runStr.split("_").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min, s));
}

// Gibt die Berlin-Wallclock (als Date-Objekt, UTC-interpretiert, damit man
// zwei Zeitpunkte einfach per getTime() vergleichen kann) für einen Instant
// zurück, abgerundet auf die volle Stunde. Berücksichtigt automatisch
// Sommer-/Winterzeit.
function getBerlinWallClockFloored(instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(instant);

  const get = (type) => parts.find((p) => p.type === type).value;
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;

  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
}
