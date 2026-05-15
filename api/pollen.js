import { readFileSync } from 'fs';
import { join } from 'path';
const places = JSON.parse(readFileSync(join(process.cwd(), 'deutschland.geojson'), 'utf-8'));

// Vorab: Nur Features mit is_in UND Bundesland-Info filtern
const KNOWN_STATES = new Set([
  "Schleswig-Holstein","Hamburg","Mecklenburg-Vorpommern","Niedersachsen",
  "Bremen","Nordrhein-Westfalen","Brandenburg","Berlin","Sachsen-Anhalt",
  "Thüringen","Sachsen","Hessen","Rheinland-Pfalz","Saarland",
  "Baden-Württemberg","Bayern"
]);

function extractState(isIn) {
  if (!isIn) return null;
  const parts = isIn.split(',').map(s => s.trim());
  return parts.find(p => KNOWN_STATES.has(p)) ?? null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Kandidaten mit bekanntem Bundesland vorab filtern (einmalig beim Modulstart)
const candidates = places.features.filter(f =>
  f.geometry?.type === 'Point' &&
  extractState(f.properties?.is_in)
);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon sind erforderlich" });
  }

  const userLat = parseFloat(lat);
  const userLon = parseFloat(lon);

  // =====================
  // 1️⃣ Nächsten Ort mit bekanntem Bundesland finden
  // =====================
  let nearest = null;
  let minDist = Infinity;

  for (const f of candidates) {
    const [fLon, fLat] = f.geometry.coordinates;
    const dist = haversineKm(userLat, userLon, fLat, fLon);
    if (dist < minDist) {
      minDist = dist;
      nearest = f;
    }
  }

  if (!nearest) {
    return res.status(404).json({ error: "Kein Ort mit Bundesland-Info gefunden" });
  }

  const state = extractState(nearest.properties.is_in);

  // =====================
  // 2️⃣ Mapping Bundesland → region_id
  // =====================
  const stateToRegion = {
    "Schleswig-Holstein": 10, "Hamburg": 10,
    "Mecklenburg-Vorpommern": 20,
    "Niedersachsen": 30, "Bremen": 30,
    "Nordrhein-Westfalen": 40,
    "Brandenburg": 50, "Berlin": 50,
    "Sachsen-Anhalt": 60,
    "Thüringen": 70,
    "Sachsen": 80,
    "Hessen": 90,
    "Rheinland-Pfalz": 100, "Saarland": 100,
    "Baden-Württemberg": 110,
    "Bayern": 120
  };

  const regionId = stateToRegion[state];
  if (!regionId) {
    return res.status(404).json({ error: `Keine DWD-Region für: ${state}` });
  }

  // =====================
  // 3️⃣ DWD OpenData laden
  // =====================
  try {
    const dwdRes = await fetch(
      "https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json"
    );
    const dwdData = await dwdRes.json();
    const regionData = dwdData.content.find(r => r.region_id === regionId);

    if (!regionData) {
      return res.status(404).json({ error: "Region nicht im DWD-Datensatz" });
    }

    res.status(200).json({
      location: { lat, lon, state },
      nearest_place: {
        name: nearest.properties.name,
        distance_km: Math.round(minDist * 10) / 10
      },
      region: { id: regionData.region_id, name: regionData.region_name },
      last_update: dwdData.last_update,
      pollen: regionData.Pollen
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
