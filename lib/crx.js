const UPSTREAM_BASE = "https://wetterblick-api.com";
const INTERVAL_MINUTES = 10;
const SLOTS_PER_DAY = (48 * 60) / INTERVAL_MINUTES; // 288 (48h)

const PARAMETERS = [
  { id: "temperatur", label: "Temperatur", unit: "°C" },
  { id: "taupunkt", label: "Taupunkt", unit: "°C" },
  { id: "luftfeuchtigkeit", label: "Luftfeuchtigkeit", unit: "%" },
  { id: "niederschlag1h", label: "Niederschlag 1Std.", unit: "mm" },
  { id: "windboe", label: "Windböen", unit: "km/h" },
  { id: "windgeschwindigkeit", label: "Windgeschwindigkeit", unit: "km/h" },
  { id: "sonnenscheindauer", label: "Sonnenscheindauer", unit: "min" },
  { id: "sichtweite", label: "Sichtweite", unit: "m" },
  { id: "schneehohe", label: "Schneehöhe", unit: "cm" },
  { id: "bodentemperatur-5cm", label: "Bodentemperatur 5cm", unit: "°C" },
  { id: "temperatur-min-d", label: "Min. Tagestemperatur", unit: "°C" },
  { id: "temperatur-max-d", label: "Max. Tagestemperatur", unit: "°C" },
  { id: "temperatur-min-m", label: "Min. Monatstemperatur", unit: "°C" },
  { id: "temperatur-max-m", label: "Max. Monatstemperatur", unit: "°C" },
  { id: "temperatur-min-y", label: "Min. Jahrestemperatur", unit: "°C" },
  { id: "temperatur-max-y", label: "Max. Jahrestemperatur", unit: "°C" },
  { id: "windboe-max-d", label: "Max. Windböen (Tag)", unit: "km/h" },
  { id: "windboe-max-m", label: "Max. Windböen (Monat)", unit: "km/h" },
  { id: "windboe-max-y", label: "Max. Windböen (Jahr)", unit: "km/h" },
];

const ALLOWED_PARAMETERS = new Set(PARAMETERS.map((p) => p.id));

/** Zerlegt ein Date-Objekt in Europe/Berlin-Datumsteile. */
function berlinParts(date) {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
}

/**
 * Rundet den aktuellen Zeitpunkt (Europe/Berlin) auf das letzte
 * vollständige 10-Minuten-Intervall ab.
 * Rückgabe: { datum: "YYYYMMDD", zeit: "HHMM", isoDate, isoTime }
 */
function getLatestSlot(date = new Date()) {
  const parts = berlinParts(date);
  const totalMinutes =
    parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  const rounded = totalMinutes - (totalMinutes % INTERVAL_MINUTES);
  const hh = String(Math.floor(rounded / 60)).padStart(2, "0");
  const mm = String(rounded % 60).padStart(2, "0");

  return {
    datum: `${parts.year}${parts.month}${parts.day}`,
    zeit: `${hh}${mm}`,
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    isoTime: `${hh}:${mm}`,
  };
}

function generateDaySlots(datum, zeit, count = SLOTS_PER_DAY) {
  const year = parseInt(datum.slice(0, 4), 10);
  const month = parseInt(datum.slice(4, 6), 10) - 1;
  const day = parseInt(datum.slice(6, 8), 10);
  const hour = parseInt(zeit.slice(0, 2), 10);
  const minute = parseInt(zeit.slice(2, 4), 10);

  // UTC als neutrale Rechenbasis für reine Kalender-Arithmetik
  // (nur Vor-/Zurückzählen von 10-Minuten-Schritten, keine Zonenumrechnung nötig).
  const start = Date.UTC(year, month, day, hour, minute);

  const slots = [];
  for (let i = 0; i < count; i++) {
    const t = new Date(start - i * INTERVAL_MINUTES * 60000);
    const yyyy = t.getUTCFullYear();
    const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(t.getUTCDate()).padStart(2, "0");
    const hh = String(t.getUTCHours()).padStart(2, "0");
    const min = String(t.getUTCMinutes()).padStart(2, "0");
    const slotDatum = `${yyyy}${mm}${dd}`;
    const slotZeit = `${hh}${min}`;
    slots.push({
      datum: slotDatum,
      zeit: slotZeit,
      isoTime: `${hh}:${min}`,
      datumzeit: `${slotDatum}${slotZeit}`,
    });
  }
  return slots;
}

function isValidDatum(v) {
  return typeof v === "string" && /^\d{8}$/.test(v);
}

function isValidZeit(v) {
  return typeof v === "string" && /^\d{4}$/.test(v);
}

/** Prüft und zerlegt das kombinierte Format YYYYMMDDHHMM. */
function parseDatumzeit(v) {
  if (typeof v !== "string" || !/^\d{12}$/.test(v)) return null;
  const datum = v.slice(0, 8);
  const zeit = v.slice(8, 12);
  if (!isValidDatum(datum) || !isValidZeit(zeit)) return null;
  return { datum, zeit };
}

/** Ruft die Upstream-API ab: /measurements/{parameter}/{datum}/{zeit} */
async function fetchMeasurements(parameter, datum, zeit) {
  const upstreamUrl = `${UPSTREAM_BASE}/measurements/${parameter}/${datum}/${zeit}`;

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
    });

    if (!upstreamRes.ok) {
      return { ok: false, status: upstreamRes.status, upstreamUrl };
    }

    const data = await upstreamRes.json();
    return { ok: true, status: 200, upstreamUrl, data };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      upstreamUrl,
      error: err.message,
    };
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

module.exports = {
  UPSTREAM_BASE,
  INTERVAL_MINUTES,
  SLOTS_PER_DAY,
  PARAMETERS,
  ALLOWED_PARAMETERS,
  getLatestSlot,
  generateDaySlots,
  isValidDatum,
  isValidZeit,
  parseDatumzeit,
  fetchMeasurements,
  setCors,
};
