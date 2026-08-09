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

// DWD JSON laden + Last-Modified per HEAD abfragen
async function getDWDJson() {
  const todayStr = new Date()
    .toISOString()
    .slice(0,10)
    .replace(/-/g,"");

  if (dwdCache && cachedDay === todayStr) {
    return { data: dwdCache, updatedAt: cachedUpdatedAt };
  }

  const url = `https://opendata.dwd.de/climate_environment/health/forecasts/heat/hwtrend_${todayStr}.json`;

  // HEAD-Request für den Last-Modified-Header
  let updatedAt = null;
  try {
    const headRes = await fetch(url, { method: "HEAD" });
    const lastModified = headRes.headers.get("last-modified");
    if (lastModified) {
      updatedAt = new Date(lastModified).toISOString();
    }
  } catch (e) {
    console.error("HEAD request failed:", e.message);
  }

  const res = await fetch(url);
  const data = await res.json();

  dwdCache = data;
  cachedDay = todayStr;
  cachedUpdatedAt = updatedAt;

  return { data, updatedAt };
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