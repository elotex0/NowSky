// api/meta.js
//
// GET /api/meta
//
// Liefert Metadaten zum Datenraster der Wetterblick-API:
// - den aktuell "neuesten" Zeitschritt (auf 10-Minuten-Raster abgerundet, Europe/Berlin)
// - alle 144 Zeitschritte des heutigen Tages (10-Minuten-Raster), inkl.
//   fertigem "datumzeit"-String für /api/{parameter}/{datumzeit}
// - die Liste der bekannten Parameter
// - das Intervall (10 Minuten)

const {
  INTERVAL_MINUTES,
  SLOTS_PER_DAY,
  PARAMETERS,
  getLatestSlot,
  generateDaySlots,
  setCors,
} = require("../lib/crx");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.status(204).end();
    return;
  }

  setCors(res);
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

  const latest = getLatestSlot();
  const slots = generateDaySlots(latest.datum, latest.zeit);

  res.status(200).json({
    intervalMinutes: INTERVAL_MINUTES,
    slotsPerDay: SLOTS_PER_DAY,
    timezone: "Europe/Berlin",
    latest,
    // 144 Zeitschritte rückwärts ab "latest" (Index 0 = aktuellster Slot,
    // Index 143 = 24h zuvor). Kann über Mitternacht in den Vortag reichen,
    // daher trägt jeder Slot sein eigenes "datum".
    last24h: {
      slots,
    },
    parameters: PARAMETERS,
    source: "Deutscher Wetterdienst",
  });
};
