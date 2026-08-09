import fetch from "node-fetch";

// Trend-Beschreibungen nach DWD
const trendDescriptions = {
  0: "Keine Wärmebelastung",
  1: "starke Wärmebelastung",
  2: "extreme Wärmebelastung",
  3: "nicht mehr verwendet",
  4: "starke Wärmebelastung möglich",
  5: "starke Wärmebelastung wahrscheinlich",
  6: "extreme Wärmebelastung möglich",
  7: "extreme Wärmebelastung wahrscheinlich"
};

// Cache
let dwdCache = null;
let cachedDay = null;
let cachedUpdatedAt = null;

// Umlaute normalisieren
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/ä/g,"ae")
    .replace(/ö/g,"oe")
    .replace(/ü/g,"ue")
    .replace(/ß/g,"ss");
}

// Zeitstempel aus dem Verzeichnis-Index parsen, z.B. "09-Aug-2026 01:05:03"
// -> ISO-String, unter Annahme Europe/Berlin (CET = UTC+1, CEST = UTC+2)
function parseIndexTimestamp(dateStr) {
  const months = {
    Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
    Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11
  };
  const m = dateStr.match(/(\d{2})-(\w{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, day, monStr, year, hour, min, sec] = m;
  const month = months[monStr];

  // Grobe DST-Bestimmung für Deutschland (letzter Sonntag im März bis letzter Sonntag im Oktober)
  const naiveDate = new Date(Date.UTC(+year, month, +day, +hour, +min, +sec));
  const isDST = month > 2 && month < 9; // Apr–Sep sicher DST; Randfälle März/Okt werden hier grob approximiert
  const offsetHours = isDST ? 2 : 1;

  // Berliner Zeit -> UTC durch Abzug des Offsets
  const utcMs = naiveDate.getTime() - offsetHours * 60 * 60 * 1000;
  return new Date(utcMs).toISOString();
}

// Verzeichnis-Index abrufen und Timestamp für die heutige Datei extrahieren
async function getUpdatedAt(todayStr) {
  const indexUrl = "https://opendata.dwd.de/climate_environment/health/forecasts/heat/";
  const res = await fetch(indexUrl);
  const html = await res.text();

  const filename = `hwtrend_${todayStr}.json`;
  const escaped = filename.replace(/[.]/g, "\\.");
  const re = new RegExp(
    `${escaped}\\s+(\\d{2}-\\w{3}-\\d{4}\\s+\\d{2}:\\d{2}:\\d{2})`
  );
  const match = html.match(re);
  if (!match) return null;

  return parseIndexTimestamp(match[1]);
}

// DWD JSON laden
async function getDWDJson() {
  const todayStr = new Date()
    .toISOString()
    .slice(0,10)
    .replace(/-/g,"");

  if (dwdCache && cachedDay === todayStr) {
    return { data: dwdCache, updatedAt: cachedUpdatedAt };
  }

  const url = `https://opendata.dwd.de/climate_environment/health/forecasts/heat/hwtrend_${todayStr}.json`;
  const res = await fetch(url);
  const data = await res.json();

  dwdCache = data;
  cachedDay = todayStr;
  cachedUpdatedAt = await getUpdatedAt(todayStr).catch(() => null);

  return { data, updatedAt: cachedUpdatedAt };
}

// Region aus Nominatim bestimmen
function extractRegion(address){
  return (
    address.county ||
    address.city ||
    address.municipality ||
    address.town ||
    address.village ||
    address.state_district ||
    null
  );
}

// Region gegen DWD matchen
function findDWDRegion(region, dwdData){
  const regionNorm = normalize(region);
  for (const code in dwdData){
    const nameRaw = dwdData[code].Name;
    const name = normalize(nameRaw);
    if(
      name.includes(regionNorm) ||
      name.includes(`stadt ${regionNorm}`) ||
      name.includes(`landkreis ${regionNorm}`) ||
      regionNorm.includes(name)
    ){
      return {
        code,
        name: nameRaw,
        trend: dwdData[code].Trend
      };
    }
  }
  return null;
}

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");

  if(req.method === "OPTIONS"){
    return res.status(200).end();
  }

  const { lat, lon } = req.query;
  if(!lat || !lon){
    return res.status(400).json({ error: "lat & lon required" });
  }

  try{
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);

    const nomUrl =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latNum}&lon=${lonNum}&addressdetails=1&zoom=10`;
    const geoRes = await fetch(nomUrl,{
      headers:{ "User-Agent":"Vercel-Hitzetrend-App/1.0" }
    });
    const geoData = await geoRes.json();
    const region = extractRegion(geoData.address);

    if(!region){
      return res.status(404).json({
        error:"Keine Region gefunden",
        address: geoData.address
      });
    }

    const { data: dwdData, updatedAt } = await getDWDJson();

    const match = findDWDRegion(region, dwdData);
    if(!match){
      return res.status(404).json({
        error:"Kein Hitzetrend für Region gefunden",
        region
      });
    }

    const today = new Date();
    const trends = match.trend.map((value, idx)=>{
      const d = new Date(today);
      d.setDate(d.getDate() + idx);
      return {
        date: d.toISOString().slice(0,10),
        trend: value
      };
    });

    res.status(200).json({
      code: match.code,
      region: match.name,
      state: geoData.address.state || "",
      trends,
      descriptions: trendDescriptions,
      updatedAt
    });

  }catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}