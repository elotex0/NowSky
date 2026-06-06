import fetch from "node-fetch";

async function loadStations() {
  const res = await fetch(
    "https://www.dwd.de/DE/leistungen/met_verfahren_mosmix/mosmix_stationskatalog.cfg?view=nasPublication&nn=16102"
  );
  const text = await res.text();
  const lines = text.split("\n");
  const stations = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith("D") || line.startsWith("-")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const id = parts[0];
    const icao = parts[1] === "----" ? null : parts[1];
    const elev = parseFloat(parts[parts.length - 1]);
    const lon = parseFloat(parts[parts.length - 2]);
    const lat = parseFloat(parts[parts.length - 3]);
    const name = parts.slice(2, parts.length - 3).join(" ");
    if (!isFinite(lat) || !isFinite(lon)) continue;
    stations.push({ id, icao, name, lat, lon, elev });
  }
  return stations;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const WARN_TYPE_NAMES = {
  0: "Gewitter",
  1: "Sturm",
  2: "Regen",
  3: "Schnee",
  4: "Nebel",
  5: "Frost",
  6: "Glätte/Glatteis",
  7: "Tauwetter",
  8: "Hitze",
  9: "UV",
  10: "Hochwasser",
  11: "Lawinen",
  12: "Sturmflut",
  13: "Wasserstand",
  14: "Binnensee",
};

function toDE(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);

    if (!isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ error: "lat und lon als Query-Parameter angeben" });
    }

    const stations = await loadStations();
    const nearby = stations
      .map((s) => ({ ...s, distanzKm: haversine(lat, lon, s.lat, s.lon) }))
      .filter((s) => s.distanzKm <= 5)
      .sort((a, b) => a.distanzKm - b.distanzKm);

    if (nearby.length === 0) {
      return res.status(200).json({
        anfrage: { lat, lon },
        stationen: [],
        message: "Keine Stationen innerhalb von 5 km gefunden",
      });
    }

    const ergebnisse = await Promise.all(
      nearby.map(async (station) => {
        try {
          const dwdRes = await fetch(
            `https://app-prod-ws.warnwetter.de/v54/stationWarnings?stationId=${station.id}`
          );
          if (!dwdRes.ok) return { ...station, fehler: `HTTP ${dwdRes.status}` };
          const data = await dwdRes.json();

          const warnForecast = data.warningForecast ?? null;
          let warntrend = null;

          if (warnForecast && warnForecast.data) {
            const startMs = warnForecast.start;
            const stepMs = warnForecast.timeStep;
            const threshold = data.warningForecastThreshold ?? 7;
            warntrend = {
              start: toDE(startMs),
              startMs,
              schrittMs: stepMs,
              kategorien: Object.entries(warnForecast.data).map(([key, werte]) => {
                const idx = werte.findIndex((v) => v >= threshold);
                return {
                  key: parseInt(key),
                  name: WARN_TYPE_NAMES[parseInt(key)] ?? `Typ ${key}`,
                  werte,
                  ersteWarnungIndex: idx,
                  ersteWarnungZeit: idx >= 0 ? toDE(startMs + idx * stepMs) : null,
                };
              }),
            };
          }

          const warnungen = (data.warnings ?? []).map((w) => ({
            id: w.warnId ?? w.id ?? null,
            typ: WARN_TYPE_NAMES[w.type] ?? w.type,
            level: w.level,
            event: w.event ?? null,
            headline: w.headLine ?? null,
            start: toDE(w.start),
            end: toDE(w.end),
            isVorabinfo: w.isVorabinfo ?? false,
          }));

          const uvi = data.uvi
            ? { start: toDE(data.uvi.start), schrittMs: data.uvi.timeStep, werte: data.uvi.data?.uvi ?? [] }
            : null;

          const tbi = data.tbi
            ? { start: toDE(data.tbi.start), schrittMs: data.tbi.timeStep, werte: data.tbi.data?.tbi ?? [] }
            : null;

          return {
            id: station.id,
            icao: station.icao,
            name: station.name,
            lat: station.lat,
            lon: station.lon,
            elevationM: station.elev,
            distanzKm: Math.round(station.distanzKm * 10) / 10,
            warnungen,
            warntrend,
            uvi,
            tbi,
          };
        } catch (err) {
          return {
            id: station.id,
            name: station.name,
            distanzKm: Math.round(station.distanzKm * 10) / 10,
            fehler: err.message,
          };
        }
      })
    );

    return res.status(200).json({
      zeit: toDE(Date.now()),
      anfrage: { lat, lon, radiusKm: 5 },
      anzahlStationen: ergebnisse.length,
      stationen: ergebnisse,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
