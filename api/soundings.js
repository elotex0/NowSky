// api/sounding-sars.js
//
// Beispiel-Aufruf:
//   /api/sounding-sars?lat=48.7419&lon=9.211
//   /api/sounding-sars?lat=48.7419&lon=9.211&time=2026-07-19T21:30:00  (optional, sonst "jetzt")
//
// Ermittelt automatisch den neuesten ICON-D2/GERMANY Run und liefert die
// SARS-Wahrscheinlichkeiten für Supercell/Hail für ALLE Forecast-Steps ab der
// gewünschten Uhrzeit (Europe/Berlin, auf volle Stunde abgerundet) bis zum
// Ende des Forecast-Horizonts (MAX_STEP). Also z.B. bei Run 21:00 UTC und
// Zielzeit = jetzt (kurz nach 21 Uhr lokal): Step 1 (=22 Uhr lokal) ist der
// erste Eintrag, danach folgen die restlichen 47 Steps.
//
// Plus ein paar zusätzliche Kontext-Felder pro Step (hazard, SHIP,
// Craven-Index, Microburst-Flag).

const BASE = "https://data2.weatherwise.app";
const MODEL = "ICON-EU";
const REGION = "EUROPE";
const MAX_STEP = 120; // Absicherung, falls Ziel-Zeit außerhalb des Forecast-Horizonts liegt

// Mindestanzahl an "loose"-Vergleichsfällen, ab der eine Wahrscheinlichkeit
// überhaupt als aussagekräftig gilt. Bei z.B. loose=1 und prob=1 (=100%)
// beruht das nur auf EINEM einzigen historischen Fall -> statistisch nicht
// belastbar, wird daher unterdrückt (ausreichend_daten: false, prob_pct: null).
const MIN_LOOSE_MATCHES = 10; // ggf. anpassen

// Wie viele Soundings gleichzeitig (parallel) abgerufen werden, um die
// Upstream-API nicht mit 48 gleichzeitigen Requests zu fluten.
const CONCURRENCY = 8;

// Übersetzung der SPC-Hazard-Codes ins Deutsche.
// Aufbau der Original-Codes: [LEVEL] + [TYP], z.B. "MRGL SVR", "SIG TOR".
// Level: MRGL (marginal/gering), SLGT (gering), ENH (erhöht), MDT (mäßig),
//        HIGH (hoch), SIG (signifikant) - fehlt der Level, ist "SVR"/"TOR"
//        allein die Basis-Kategorie ohne weitere Abstufung.
// Typ:   SVR (Unwetter allgemein: Wind/Hagel), TOR (Tornado)
const HAZARD_DE = {
  NONE: "Kein Unwetterpotenzial",
  SVR: "Unwetterrisiko",
  TOR: "Tornadorisiko",
  "MRGL SVR": "Marginales Unwetterrisiko",
  "MRGL TOR": "Marginales Tornadorisiko",
  "SLGT SVR": "Geringes Unwetterrisiko",
  "SLGT TOR": "Geringes Tornadorisiko",
  "ENH SVR": "Erhöhtes Unwetterrisiko",
  "ENH TOR": "Erhöhtes Tornadorisiko",
  "MDT SVR": "Mäßiges Unwetterrisiko",
  "MDT TOR": "Mäßiges Tornadorisiko",
  "HIGH SVR": "Hohes Unwetterrisiko",
  "HIGH TOR": "Hohes Tornadorisiko",
  "SIG SVR": "Signifikantes Unwetterrisiko",
  "SIG TOR": "Signifikantes Tornadorisiko",
};

function translateHazard(code) {
  if (!code) return null;
  const normalized = code.trim().toUpperCase().replace(/\s+/g, " ");
  return HAZARD_DE[normalized] ?? code; // unbekannter Code -> Original als Fallback
}

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

    // 2) Zielzeit bestimmen (Europe/Berlin, auf volle Stunde abgerundet) -
    //    das ist die UNTERGRENZE: alle Steps ab (inkl.) dieser Zeit werden
    //    zurückgegeben.
    const targetInstant = time ? new Date(time) : new Date();
    if (isNaN(targetInstant.getTime())) {
      return res.status(400).json({ error: "Ungültiger time-Parameter" });
    }
    const targetWall = getBerlinWallClockFloored(targetInstant);

    // 3) Run-String in UTC-Date parsen
    const runDate = parseRunString(latestRun);

    // 4) Alle Steps ermitteln, deren Gültigkeitszeit (Berlin-Wallclock)
    //    >= targetWall ist - d.h. "jetzt" (bzw. der übergebenen Zeit) und
    //    alle folgenden Steps bis MAX_STEP.
    const stepsToFetch = [];
    for (let s = 0; s <= MAX_STEP; s++) {
      const validInstant = new Date(runDate.getTime() + s * 3600 * 1000);
      const validWall = getBerlinWallClockFloored(validInstant);
      if (validWall.getTime() >= targetWall.getTime()) {
        stepsToFetch.push({ step: s, validWall });
      }
    }

    if (stepsToFetch.length === 0) {
      return res.status(422).json({
        error: "Zielzeit liegt außerhalb des Forecast-Horizonts dieses Runs",
        run: latestRun,
        maxStep: MAX_STEP,
      });
    }

    // 5) Soundings für alle passenden Steps abrufen (mit begrenzter
    //    Parallelität, um die Upstream-API nicht zu überlasten)
    const forecasts = await fetchSoundingsInBatches(stepsToFetch, latestRun, lat, lon);

    return res.status(200).json({
      run: latestRun,
      lat: Number(lat),
      lon: Number(lon),
      count: forecasts.length,
      forecasts,
    });
  } catch (err) {
    return res.status(500).json({ error: "Interner Fehler", detail: String(err) });
  }
}

// Ruft die Soundings für eine Liste von { step, validWall } ab, mit
// begrenzter Parallelität (CONCURRENCY gleichzeitige Requests). Steps, bei
// denen der Abruf fehlschlägt, werden mit einem "error"-Feld statt Daten
// zurückgegeben, damit ein einzelner Fehler nicht die ganze Antwort killt.
async function fetchSoundingsInBatches(stepsToFetch, latestRun, lat, lon) {
  const results = new Array(stepsToFetch.length);

  let cursor = 0;
  async function worker() {
    while (cursor < stepsToFetch.length) {
      const idx = cursor++;
      const { step, validWall } = stepsToFetch[idx];
      results[idx] = await fetchOneStep(step, validWall, latestRun, lat, lon);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, stepsToFetch.length) }, worker);
  await Promise.all(workers);

  return results;
}

// Ruft ein einzelnes Sounding ab und formt es ins gleiche Ausgabeformat wie
// zuvor (sars + context), ergänzt um step und valid_local. Fehler beim
// Abruf werden abgefangen und als error-Feld zurückgegeben, statt die
// gesamte Anfrage scheitern zu lassen.
async function fetchOneStep(step, validWall, latestRun, lat, lon) {
  const valid_local = validWall.toISOString().replace(".000Z", "Z");

  try {
    const soundingUrl =
      `${BASE}/api/models/v1/sounding/?model=${MODEL}&region=${REGION}` +
      `&run=${latestRun}&step=${step}&lat=${lat}&lon=${lon}&format=json`;

    const soundingResp = await fetch(soundingUrl);
    if (!soundingResp.ok) {
      return { step, valid_local, error: `Sounding-API-Fehler (Status ${soundingResp.status})` };
    }

    const data = await soundingResp.json();
    const indices = data?.indices;
    const sars = indices?.sars;

    if (!sars) {
      return { step, valid_local, error: "Keine SARS-Daten in der Antwort enthalten" };
    }

    const comp = indices?.comp ?? {};
    const thermo = indices?.thermo ?? {};

    return {
      step,
      valid_local,
      sars: {
        supercell: formatSarsCategory(sars.supercell),
        hail: formatSarsCategory(sars.hail, { convertToCm: true }),
      },
      context: {
        hazard: translateHazard(comp.hazard),
        hazard_code: comp.hazard ?? null,
        ship: roundOrNull(comp.ship, 2),
        scp: roundOrNull(comp.scp, 2),
        stp_cin: roundOrNull(comp.stp_cin, 2),
        craven_sigsvr: roundOrNull(thermo.sigsvr, 0),
        microburst_risk: thermo.mburst === 1,
      },
    };
  } catch (err) {
    return { step, valid_local, error: String(err) };
  }
}

// Formatiert eine SARS-Kategorie (supercell oder hail):
// - rundet prob auf ganze Prozent (prob_pct)
// - unterdrückt prob/prob_pct, wenn zu wenige "loose"-Vergleichsfälle vorliegen
// - wandelt bei Hagel die Zoll-Werte in den Matches zusätzlich in cm um
function formatSarsCategory(cat, opts = {}) {
  const { convertToCm = false } = opts;

  if (!cat) {
    return { matches: [], loose: 0, prob: null, prob_pct: null, reliable: false };
  }

  const loose = cat.loose ?? 0;
  const rawProb = cat.prob ?? 0;
  const reliable = loose >= MIN_LOOSE_MATCHES;

  let matches = cat.matches ?? [];
  if (convertToCm) {
    matches = matches.map((m) => {
      // Format je nach Kategorie: [id, inches] bei Hagel, [id, "WEAKTOR"] o.ä. bei Supercell
      if (Array.isArray(m) && typeof m[1] === "number") {
        return { id: m[0], inches: m[1], cm: Math.round(m[1] * 2.54 * 100) / 100 };
      }
      return m;
    });
  }

  return {
    matches,
    loose,
    prob_pct: reliable ? Math.round(rawProb * 100) : null, // nur noch Prozent, keine rohe Dezimalzahl
    ausreichend_daten: reliable, // true = genug Vergleichsfälle (>= MIN_LOOSE_MATCHES) für aussagekräftige %-Angabe
  };
}

function roundOrNull(val, decimals) {
  if (val === null || val === undefined) return null;
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
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
