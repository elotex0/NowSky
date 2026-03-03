export default async function handler(req, res) {
    // CORS Headers setzen
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { lat, lon } = req.query;

    if (!lat || !lon) {
        return res.status(400).json({ error: 'lat und lon Parameter sind erforderlich' });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    if (isNaN(latitude) || isNaN(longitude)) {
        return res.status(400).json({ error: 'Ungültige Koordinaten' });
    }

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=wind_gusts_10m,wind_speed_10m,temperature_2m,dew_point_2m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_speed_1000hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
                    `relative_humidity_500hPa,cape,convective_inhibition,lifted_index,` +
                    `dew_point_850hPa,dew_point_700hPa,boundary_layer_height,direct_radiation,` +
                    `freezing_level_height,precipitation&forecast_days=16&past_days=31&models=icon_eu,ecmwf_ifs025,gfs_global&timezone=auto`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            return res.status(500).json({ error: 'API-Fehler: ' + (data.reason || data.error.message || 'Unbekannt') });
        }

        if (!data?.hourly?.time?.length) {
            return res.status(500).json({ error: 'Keine Daten verfügbar' });
        }

        const timezone = data.timezone || 'UTC';

        // Nur Europa zulassen
        const region = getRegion(latitude, longitude);
        if (region !== 'europe') {
            return res.status(400).json({
                error: 'Vorhersage nur für Europa verfügbar',
                region: region,
                onlyEurope: true
            });
        }

        // Stunden-Daten verarbeiten
        const hours = data.hourly.time.map((t, i) => {
            return {
                time: t,
                temperature: getMultiModelValue(data.hourly, 'temperature_2m', i),
                dew: getMultiModelValue(data.hourly, 'dew_point_2m', i),
                cloudLow: getMultiModelValue(data.hourly, 'cloud_cover_low', i),
                cloudMid: getMultiModelValue(data.hourly, 'cloud_cover_mid', i),
                cloudHigh: getMultiModelValue(data.hourly, 'cloud_cover_high', i),
                precip: getMultiModelValue(data.hourly, 'precipitation_probability', i),
                wind: getMultiModelValue(data.hourly, 'wind_speed_10m', i),
                gust: getMultiModelValue(data.hourly, 'wind_gusts_10m', i),
                windDir1000: getMultiModelValue(data.hourly, 'wind_direction_1000hPa', i),
                windDir850: getMultiModelValue(data.hourly, 'wind_direction_850hPa', i),
                windDir700: getMultiModelValue(data.hourly, 'wind_direction_700hPa', i),
                windDir500: getMultiModelValue(data.hourly, 'wind_direction_500hPa', i),
                windDir300: getMultiModelValue(data.hourly, 'wind_direction_300hPa', i),
                wind_speed_1000hPa: getMultiModelValue(data.hourly, 'wind_speed_1000hPa', i),
                wind_speed_850hPa: getMultiModelValue(data.hourly, 'wind_speed_850hPa', i),
                wind_speed_700hPa: getMultiModelValue(data.hourly, 'wind_speed_700hPa', i),
                wind_speed_500hPa: getMultiModelValue(data.hourly, 'wind_speed_500hPa', i),
                wind_speed_300hPa: getMultiModelValue(data.hourly, 'wind_speed_300hPa', i),
                temp500: getMultiModelValue(data.hourly, 'temperature_500hPa', i),
                temp850: getMultiModelValue(data.hourly, 'temperature_850hPa', i),
                temp700: getMultiModelValue(data.hourly, 'temperature_700hPa', i),
                dew850: getMultiModelValue(data.hourly, 'dew_point_850hPa', i),
                dew700: getMultiModelValue(data.hourly, 'dew_point_700hPa', i),
                rh500: getMultiModelValue(data.hourly, 'relative_humidity_500hPa', i),
                cape: getMultiModelValue(data.hourly, 'cape', i),
                cin: Math.abs(getMultiModelValue(data.hourly, 'convective_inhibition', i)),
                liftedIndex: getMultiModelValue(data.hourly, 'lifted_index', i),
                pblHeight: getMultiModelValue(data.hourly, 'boundary_layer_height', i),
                directRadiation: getMultiModelValue(data.hourly, 'direct_radiation', i),
                precipAcc: getMultiModelValue(data.hourly, 'precipitation', i, 'max'),
                freezingLevel: getMultiModelValue(data.hourly, 'freezing_level_height', i),
            };
        });

        // Aktuelle Zeit berechnen
        const now = new Date();
        const currentTimeStr = now.toLocaleString('en-US', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone
        });
        const [datePart, timePart] = currentTimeStr.split(', ');
        const [month, day, year] = datePart.split('/');
        const [currentHour] = timePart.split(':').map(Number);
        const currentDateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

        // Nächste 24 Stunden filtern
        const nextHours = hours
            .filter(h => {
                const [datePart, timePart] = h.time.split('T');
                const [hour] = timePart.split(':').map(Number);
                return datePart > currentDateStr || (datePart === currentDateStr && hour >= currentHour);
            })
            .slice(0, 24)
            .map(hour => {
                const shear = calcShear(hour);
                const srh = calcSRH(hour);
                const dcape = calcDCAPE(hour);
                const wmaxshear = calcWMAXSHEAR(hour.cape, shear);
                const hailProb = calculateHailProbability(hour, wmaxshear, dcape);
                const windProb = calculateWindProbability(hour, wmaxshear, dcape);
                return {
                    timestamp: hour.time,
                    probability: calculateProbability(hour),
                    tornadoProbability: calculateTornadoProbability(hour, shear, srh),
                    temperature: hour.temperature,
                    cape: hour.cape,
                    shear: shear,
                    srh: srh,
                    dcape: dcape,
                    wmaxshear: wmaxshear,
                    hailProbability: hailProb,
                    windProbability: windProb,
                };
            });

        // Zukünftige Tage gruppieren (maximale Gewitter- und Tornado-Werte pro Tag)
        const daysMap = new Map();
        // Vergangene Tage gruppieren
        const pastDaysMap = new Map();
        
        hours.forEach(h => {
            const [datePart] = h.time.split('T');
            const probability = calculateProbability(h);
            const shear = calcShear(h);
            const srh = calcSRH(h);
            const dcape = calcDCAPE(h);
            const wmaxshear = calcWMAXSHEAR(h.cape, shear);
            const tornadoProb = calculateTornadoProbability(h, shear, srh);
            const hailProb = calculateHailProbability(h, wmaxshear, dcape);
            const windProb = calculateWindProbability(h, wmaxshear, dcape);
            
            if (datePart >= currentDateStr) {
                // Zukünftige Tage
                if (!daysMap.has(datePart)) {
                    daysMap.set(datePart, { 
                        date: datePart, 
                        maxProbability: probability,
                        maxTornadoProbability: tornadoProb,
                        maxHailProbability: hailProb,
                        maxWindProbability: windProb
                    });
                } else {
                    const dayData = daysMap.get(datePart);
                    dayData.maxProbability = Math.max(dayData.maxProbability, probability);
                    dayData.maxTornadoProbability = Math.max(dayData.maxTornadoProbability, tornadoProb);
                    dayData.maxHailProbability = Math.max(dayData.maxHailProbability, hailProb);
                    dayData.maxWindProbability = Math.max(dayData.maxWindProbability, windProb);
                }
            } else {
                // Vergangene Tage
                if (!pastDaysMap.has(datePart)) {
                    pastDaysMap.set(datePart, { 
                        date: datePart, 
                        maxProbability: probability,
                        maxTornadoProbability: tornadoProb,
                        maxHailProbability: hailProb,
                        maxWindProbability: windProb
                    });
                } else {
                    const dayData = pastDaysMap.get(datePart);
                    dayData.maxProbability = Math.max(dayData.maxProbability, probability);
                    dayData.maxTornadoProbability = Math.max(dayData.maxTornadoProbability, tornadoProb);
                    dayData.maxHailProbability = Math.max(dayData.maxHailProbability, hailProb);
                    dayData.maxWindProbability = Math.max(dayData.maxWindProbability, windProb);
                }
            }
        });

        const stunden = nextHours.map(h => ({
            timestamp: h.timestamp,
            gewitter: h.probability,
            tornado: h.tornadoProbability,
            hagel: h.hailProbability,
            wind: h.windProbability,
            gewitter_risk: categorizeRisk(h.probability),
            tornado_risk: categorizeRisk(h.tornadoProbability),
            hagel_risk: categorizeRisk(h.hailProbability),
            wind_risk: categorizeRisk(h.windProbability)
        }));

        const tage = Array.from(daysMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(day => ({
                date: day.date,
                gewitter: day.maxProbability,
                tornado: day.maxTornadoProbability,
                hagel: day.maxHailProbability,
                wind: day.maxWindProbability,
                gewitter_risk: categorizeRisk(day.maxProbability),
                tornado_risk: categorizeRisk(day.maxTornadoProbability),
                hagel_risk: categorizeRisk(day.maxHailProbability),
                wind_risk: categorizeRisk(day.maxWindProbability)
            }));

        const vergangene_tage = Array.from(pastDaysMap.values())
            .sort((a, b) => b.date.localeCompare(a.date)) // Absteigend sortiert (neueste zuerst)
            .map(day => ({
                date: day.date,
                gewitter: day.maxProbability,
                tornado: day.maxTornadoProbability,
                hagel: day.maxHailProbability,
                wind: day.maxWindProbability,
                gewitter_risk: categorizeRisk(day.maxProbability),
                tornado_risk: categorizeRisk(day.maxTornadoProbability),
                hagel_risk: categorizeRisk(day.maxHailProbability),
                wind_risk: categorizeRisk(day.maxWindProbability)
            }));

        return res.status(200).json({
            timezone: timezone,
            region: region,
            stunden: stunden,
            tage: tage,
            vergangene_tage: vergangene_tage
        });

    } catch (error) {
        console.error('Fehler:', error);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}

// Hilfsfunktionen
// Multi-Modell-Wert aus icon_eu, ecmwf_ifs025, gfs_global bilden
function getMultiModelValue(hourly, baseName, index, agg = 'mean') {
    const models = ['icon_eu', 'ecmwf_ifs025', 'gfs_global'];
    const values = [];

    for (const model of models) {
        const key = `${baseName}_${model}`;
        const arr = hourly[key];
        if (Array.isArray(arr) && arr[index] !== undefined && arr[index] !== null) {
            values.push(arr[index]);
        }
    }

    if (!values.length) return 0;

    if (agg === 'max') return Math.max(...values);
    if (agg === 'min') return Math.min(...values);

    const sum = values.reduce((s, v) => s + v, 0);
    return sum / values.length;
}

function getRegion(lat, lon) {
    // Europa: ca. 35°N - 70°N, -10°W - 40°E
    if (lat >= 35 && lat <= 70 && lon >= -10 && lon <= 40) {
        return 'europe';
    }
    // Alles andere als "außerhalb Europa" kennzeichnen
    return 'outside_europe';
}

function angleDiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

function windToUV(speed, direction) {
    const rad = direction * Math.PI / 180;
    return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
}

function calcRelHum(temp, dew) {
    const es = 6.112 * Math.exp((17.67 * temp) / (temp + 243.5));
    const e = 6.112 * Math.exp((17.67 * dew) / (dew + 243.5));
    return Math.min(100, Math.max(0, (e / es) * 100));
}

// SRH – getrennt für 0-1 km und 0-3 km berechnen
// 0-1 km ≈ 1000→850 hPa, 0-3 km ≈ 1000→700 hPa
// Quelle: Thompson et al. 2012; Craven & Brooks 2004
function calcSRH(hour, layer = '0-3km') {
    // Schichtauswahl: 0-1 km nur 1000+850, 0-3 km auch 700
    const levels = layer === '0-1km'
        ? [
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_850hPa  ?? 0) / 3.6, wd: hour.windDir850  ?? 0 }
          ]
        : [
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_850hPa  ?? 0) / 3.6, wd: hour.windDir850  ?? 0 },
            { ws: (hour.wind_speed_700hPa  ?? 0) / 3.6, wd: hour.windDir700  ?? 0 }
          ];

    const winds = levels.map(l => windToUV(l.ws, l.wd));

    // Mean Wind & Shear-Vektor für Bunkers-Methode
    const meanU = winds.reduce((s, w) => s + w.u, 0) / winds.length;
    const meanV = winds.reduce((s, w) => s + w.v, 0) / winds.length;

    const shearU = winds[winds.length - 1].u - winds[0].u;
    const shearV = winds[winds.length - 1].v - winds[0].v;
    const shearMag = Math.hypot(shearU, shearV) || 1;

    // Bunkers Right-Mover: 7.5 m/s rechts des Shear-Vektors
    const devMag = 7.5;
    const stormU = meanU + devMag * (shearV / shearMag);
    const stormV = meanV - devMag * (shearU / shearMag);

    let srh = 0;
    for (let i = 0; i < winds.length - 1; i++) {
        const u1 = winds[i].u - stormU, v1 = winds[i].v - stormV;
        const u2 = winds[i+1].u - stormU, v2 = winds[i+1].v - stormV;
        srh += u1 * v2 - u2 * v1;
    }

    return Math.round(Math.abs(srh) * 10) / 10;
}

function calcShear(hour) {
    // 0-6 km Bulk Wind Shear: Standardschicht für Superzell-Parameter
    // Approximation: 1000 hPa ≈ 0 km, 500 hPa ≈ 5.5 km, 300 hPa ≈ 9 km (zu hoch)
    // Besser: 1000→500 hPa als Proxy für 0-6 km Shear (meteorologischer Standard)
    const ws500 = (hour.wind_speed_500hPa ?? 0) / 3.6;
    const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
    const w500 = windToUV(ws500, hour.windDir500 ?? 0);
    const w1000 = windToUV(ws1000, hour.windDir1000 ?? 0);

    const bulkShear = Math.hypot(w500.u - w1000.u, w500.v - w1000.v);

    // Effective Shear: Nur relevant wenn untere Troposphäre ausreichend CAPE hat
    // Penalisiere sehr schwachen Shear unter 850 hPa (0-1 km Shear für Tornados)
    const ws850 = (hour.wind_speed_850hPa ?? 0) / 3.6;
    const w850 = windToUV(ws850, hour.windDir850 ?? 0);
    const lowLevelShear = Math.hypot(w850.u - w1000.u, w850.v - w1000.v);

    // Kombinierter Shear-Index: 0-6 km dominant, 0-1 km als Gewichtungsfaktor
    return Math.round((bulkShear * 0.75 + lowLevelShear * 0.25) * 10) / 10;
}

// Verbesserte meteorologische Indizes
function calcIndices(hour) {
    const temp500 = hour.temp500 ?? 0;
    const temp850 = hour.temp850 ?? 0;
    const temp700 = hour.temp700 ?? 0;
    const dew850 = hour.dew850 ?? 0;
    const dew700 = hour.dew700 ?? 0;
    
    return {
        kIndex: temp850 - temp500 + dew850 - (temp700 - dew700),
        showalter: temp500 - (temp850 - 9.8 * 1.5),
        lapse: (temp850 - temp500) / 3.5,
        liftedIndex: hour.liftedIndex ?? (temp500 - (temp850 - 9.8 * 1.5))
    };
}

// SCP nach Thompson et al. (2004): (MUCAPE/1000) * (ESRH/50) * (EBWD/12)
// Für Europa kalibriert (ESTOFEX/ESSL-orientierte Schwellen)
function calcSCP(cape, shear, srh, cin) {
    // Europa-Schwellen
    const minCAPE = 100;
    const minShear = 6;
    const minSRH = 40;

    if (cape < minCAPE || shear < minShear || srh < minSRH) return 0;
    if (shear < 12.5) return 0; // konsistent mit STP-Cutoff

    // SPC-Standard: CAPE/1000, SRH/50, BWD/12
    const capeTerm  = cape / 1000;
    const srhTerm   = Math.min(srh / 50, 4.0);
    const shearTerm = Math.min(shear / 12, 1.5);
    const cinTerm   = cin < 40 ? 1.0 : Math.max(0.1, 1 - (cin - 40) / 200);

    // Europa-Scaling (Taszarek/ESTOFEX: etwas niedrigere Schwellen als USA)
    const europeScale = 0.85;

    return Math.max(0, capeTerm * srhTerm * shearTerm * cinTerm * europeScale);
}

// DCAPE (Downdraft CAPE) nach Gilmore & Wicker (1998)
// Approximation über 700-500 hPa Schicht
// Hoher DCAPE → starke Downbursts, Hagel, Sturmböen
function calcDCAPE(hour) {
    const temp700 = hour.temp700 ?? 0;
    const dew700 = hour.dew700 ?? 0;
    const temp500 = hour.temp500 ?? 0;
    const cape = hour.cape ?? 0;

    // DCAPE nur sinnvoll wenn überhaupt konvektives Potential vorhanden
    if (cape < 100) return 0;

    const wetBulb700 = temp700 - 0.33 * (temp700 - dew700);
    const tempDiff = wetBulb700 - temp500;
    if (tempDiff <= 0) return 0;

    // Physikalisch: DCAPE nur relevant wenn Feuchteparzel wärmer als Umgebung
    // Trockenheit 700 hPa dämpft DCAPE stark (kein Verdunstungsantrieb)
    const dewDepression700 = temp700 - dew700;
    const moistFactor = dewDepression700 > 20 ? 0.2        // sehr trocken = kaum Evaporation
                      : dewDepression700 > 10 ? 0.5
                      : dewDepression700 > 5  ? 0.8
                      : 1.0;

    const T_env_kelvin = temp700 + 273.15;
    const dz = 2500;
    const dcape = Math.max(0, (tempDiff / T_env_kelvin) * 9.81 * dz * moistFactor);
    return Math.round(dcape);
}

// WMAXSHEAR – bester globaler Prädiktor für schwere Gewitter
// Quelle: Taszarek et al. (2020, J. Climate Part II), Brooks et al. (2003)
// WMAXSHEAR = sqrt(2 * CAPE) * BS06
// Schwellenwerte: > 500 m²/s² = schweres Gewitter, > 800 = sehr schwer
function calcWMAXSHEAR(cape, shear) {
    if (cape <= 0 || shear <= 0) return 0;
    return Math.round(Math.sqrt(2 * cape) * shear);
}

// ESTOFEX-ähnliche Risikoklassifizierung (Europa):
// 0 = none (<15%), 1 = Tstorm (15–39%), 2 = Level 1–2 (40–69%), 3 = Level 3 (≥70%)
function categorizeRisk(prob) {
    const p = Math.max(0, Math.min(100, Math.round(prob ?? 0)));
    let level = 0;
    let label = 'none';

    if (p >= 70) {
        level = 3;
        label = 'high';
    } else if (p >= 40) {
        level = 2;
        label = 'moderate';
    } else if (p >= 15) {
        level = 1;
        label = 'tstorm';
    }

    return { level, label };
}

// Hagelwahrscheinlichkeit (Europa) – orientiert an ESTOFEX/ESSL (CAPE niedrig, Shear/WMAXSHEAR stark gewichtet)
function calculateHailProbability(hour, wmaxshear, dcape) {
    const cape = Math.max(0, hour.cape ?? 0);
    const shear = calcShear(hour);
    const temp500 = hour.temp500 ?? 0;
    const freezingLevel = hour.freezingLevel ?? 4000; // m

    // Basis-Filter: quasi keine Aufwinde → kein Hagel
    if (cape < 50) return 0;

    let score = 0;

    // CAPE – Updraft-Potenzial, aber mit europäischen (niedrigeren) Schwellen
    if (cape >= 1500) score += 24;
    else if (cape >= 1000) score += 18;
    else if (cape >= 700) score += 12;
    else if (cape >= 400) score += 8;
    else if (cape >= 200) score += 4;

    // WMAXSHEAR – Hauptindikator für schweren Hagel (Brooks/Taszarek)
    if (wmaxshear >= 1400) score += 28;
    else if (wmaxshear >= 1000) score += 22;
    else if (wmaxshear >= 800) score += 16;
    else if (wmaxshear >= 500) score += 10;

    // Deep-Layer-Shear – Superzell-/organisierte Zelle
    if (shear >= 22) score += 10;
    else if (shear >= 18) score += 7;
    else if (shear >= 12) score += 4;

    // 500 hPa-Temperatur – je kälter, desto mehr Hagelproduktion
    if (temp500 <= -20) score += 8;
    else if (temp500 <= -16) score += 5;
    else if (temp500 <= -12) score += 2;

    // DCAPE – Downburst-Komponente, eher sekundär für Hagel
    if (dcape >= 800 && cape >= 600) score += 4;
    else if (dcape >= 600 && cape >= 400) score += 2;

    // Freezing Level: tiefer → mehr Hagel am Boden, hoch → Schmelzweg lang
    let flFactor = 1.0;
    if (freezingLevel <= 1800) flFactor = 1.15;
    else if (freezingLevel <= 2500) flFactor = 1.0;
    else if (freezingLevel <= 3200) flFactor = 0.8;
    else if (freezingLevel <= 4000) flFactor = 0.6;
    else flFactor = 0.45;

    score = Math.round(score * flFactor);

    // Mindestanforderungen nach europäischer Climatology (Hagel auch bei geringem CAPE, aber nicht bei quasi 0-Shear)
    if (cape < 300 || shear < 10 || wmaxshear < 400) {
        score = Math.min(score, 25);
    }

    return Math.min(100, Math.max(0, score));
}

// Sturmböen / schwere Winde (Europa) – orientiert an DCAPE/WMAXSHEAR-Studien (z.B. Gatzen, Taszarek)
function calculateWindProbability(hour, wmaxshear, dcape) {
    const cape = Math.max(0, hour.cape ?? 0);
    const wind10m = hour.wind ?? 0;   // km/h
    const gust = hour.gust ?? 0;      // km/h
    const gustDiff = gust - wind10m;

    // Basis-Filter: komplett stabile Lage ohne DCAPE, ohne Böen
    if (dcape < 150 && wmaxshear < 300 && gust < 40) return 0;

    let score = 0;

    // DCAPE – Haupttreiber für Downbursts
    if (dcape >= 1100) score += 32;
    else if (dcape >= 800) score += 24;
    else if (dcape >= 600) score += 16;
    else if (dcape >= 400) score += 10;
    else if (dcape >= 250) score += 5;

    // WMAXSHEAR – organisierte, linienhafte Konvektion / MCS (Derecho-Potenzial)
    if (wmaxshear >= 1300) score += 22;
    else if (wmaxshear >= 900) score += 16;
    else if (wmaxshear >= 600) score += 10;
    else if (wmaxshear >= 400) score += 5;

    // Böenüberschuss gegenüber Mittelwind – Hinweis auf konvektive Böen
    if (gustDiff >= 30) score += 14;
    else if (gustDiff >= 20) score += 9;
    else if (gustDiff >= 10) score += 5;

    // Absolutes Böenniveau
    if (gust >= 110) score += 16;       // > 110 km/h
    else if (gust >= 90) score += 12;   // > 90 km/h
    else if (gust >= 70) score += 8;    // > 70 km/h
    else if (gust >= 55) score += 4;    // > 55 km/h

    // CAPE-Gewicht: Wind-Fälle in Europa oft low-CAPE / high-shear, aber völlig stabile Lagen bremsen
    if (cape < 100 && dcape < 800) score = Math.min(score, 25);

    return Math.min(100, Math.max(0, Math.round(score)));
}

// STP (Significant Tornado Parameter) - nach Thompson et al. (2012) / SPC fixed-layer
// Für Europa kalibriert (ESTOFEX/ESSL-orientierte Schwellen)
// Formel: STP = (sbCAPE/1500) * ((2000-LCL)/1000) * (SRH1/150) * (6BWD/20) * ((200+CIN)/150)
function calcSTP(cape, srh, shear, liftedIndex, cin, temp2m = null, dew2m = null) {
    // Europa-Schwellen (ähnlich SPC, aber CAPE-Minimum reduziert)
    const minCAPE = 100;
    const minSRH = 40;
    const minShear = 6;
    const normCAPE = 1000;

    if (cape < minCAPE || srh < minSRH || shear < minShear) return 0;

    // *** HARTES CUTOFF nach SPC: 6BWD < 12.5 m/s → STP = 0 ***
    if (shear < 12.5) return 0;

    // LCL-Höhe nach Bolton (1980): LCL (m) ≈ 125 * (T - Td)
    let lclTerm;
    if (temp2m !== null && dew2m !== null) {
        const lclHeight = 125 * (temp2m - dew2m);
        if (lclHeight < 1000) lclTerm = 1.0;
        else if (lclHeight >= 2000) lclTerm = 0.0; // *** HARTES CUTOFF nach SPC ***
        else lclTerm = (2000 - lclHeight) / 1000;  // lineare Interpolation wie SPC
    } else {
        lclTerm = liftedIndex <= -4 ? 1.0
                : liftedIndex <= -2 ? 0.8
                : liftedIndex <= 0  ? 0.5
                : 0.2;
    }

    const capeTerm  = Math.min(cape / normCAPE, 3.0);
    // *** SRH jetzt normiert mit 150 (SPC-Standard), nicht 100 ***
    const srhTerm   = Math.min(srh / 150, 3.0);
    // *** 6BWD normiert mit 20 m/s (SPC-Standard), cap bei 1.5 für > 30 m/s ***
    const shearTerm = shear >= 30 ? 1.5 : (shear / 20);

    // *** CIN: hartes Cutoff bei -200, set to 1 wenn > -50 J/kg (SPC-Standard) ***
    let cinTerm;
    if (cin <= 50) cinTerm = 1.0;          // cin ist abs-Wert im Code, also cin < 50 = günstig
    else if (cin >= 200) cinTerm = 0.0;    // hartes Cutoff
    else cinTerm = (200 - cin) / 150;      // lineare Interpolation (200+(-cin))/150

    return Math.max(0, capeTerm * srhTerm * shearTerm * lclTerm * cinTerm);
}

// Hauptfunktion für Wahrscheinlichkeitsberechnung (nur Europa)
function calculateProbability(hour) {
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0;
    const cape = Math.max(0, hour.cape ?? 0);
    const cin = Math.abs(hour.cin ?? 0);
    const precipAcc = hour.precipAcc ?? 0;
    const precipProb = hour.precip ?? 0;
    
    // Europa-Parameter (ESTOFEX/ESSL-orientiert)
    const minTemp = 5;
    const minTempWithCAPE = 10;
    const minCAPE = 200;
    const minCAPEWithPrecip = 100;
    const capeThresholds = [1500, 1200, 800, 500, 400, 300, 200];
    const capeScores =     [25,   20,   14,  8,   6,   4,   2];
    const minTempReduction = 12;
    const tempReductionFactor = 0.5;
    const minTempReduction2 = 15;
    const tempReductionFactor2 = 0.7;

    // Filter für Fehlalarme (Europa)
    if (temp2m < minTemp) return 0; // Zu kalt für Gewitter
    if (temp2m < minTempWithCAPE && cape < (minCAPE * 1.5)) return 0; // Kalt und keine hohe Instabilität
    if (cape < minCAPEWithPrecip && precipAcc < 0.2 && precipProb < 20) return 0; // Keine Instabilität und kein Niederschlag
    
    // Berechne Indizes
    const shear = calcShear(hour);
    const srh1km = calcSRH(hour, '0-1km');
    const srh = calcSRH(hour, '0-3km');
    const { kIndex, showalter, lapse, liftedIndex } = calcIndices(hour);
    const relHum2m = calcRelHum(temp2m, dew);
    const cloudSum = (hour.cloudLow ?? 0) + (hour.cloudMid ?? 0) + (hour.cloudHigh ?? 0);
    
    // Kombinierte Indizes (bewährte meteorologische Parameter, Europa-only)
    const ehi = (cape * srh) / 160000;
    const scp = calcSCP(cape, shear, srh, cin);
    const stp = calcSTP(cape, srh1km, shear, liftedIndex, cin, temp2m, dew);
    const wmaxshear = calcWMAXSHEAR(cape, shear);
    
    // Basis-Score basierend auf kombinierten Indizes
    let score = 0;
    
    // CAPE-Bewertung (Europa)
    for (let i = 0; i < capeThresholds.length; i++) {
        if (cape >= capeThresholds[i]) {
            score += capeScores[i];
            break;
        }
    }
    
    // CIN-Penalty (stärker gewichtet)
    if (cin > 200) score -= 15;
    else if (cin > 100) score -= 8;
    else if (cin > 50) score -= 4;
    
    // Kombinierte Indizes (Europa)
    if (scp > 2) score += 20;
    else if (scp > 1.5) score += 16;
    else if (scp > 1) score += 10;
    else if (scp > 0.5) score += 5;
    
    if (stp > 1.5) score += 15;
    else if (stp > 1) score += 12;
    else if (stp > 0.5) score += 7;
    else if (stp > 0.3) score += 3;
    
    // EHI-Schwellen nach Hart & Korotky (1991), klimatologisch angepasst für Europa
    if (ehi >= 2.0) score += 12;
    else if (ehi >= 1.0) score += 8;
    else if (ehi >= 0.5) score += 4;
    else if (ehi >= 0.3) score += 2;
    
    // WMAXSHEAR-Score (nach SCP/STP/EHI-Block)
    // Taszarek et al. 2020: bester globaler Prädiktor, Schwelle 500 m²/s²
    if (wmaxshear >= 1200) score += 18;
    else if (wmaxshear >= 900) score += 14;
    else if (wmaxshear >= 700) score += 10;
    else if (wmaxshear >= 500) score += 6;
    else if (wmaxshear >= 300) score += 3;
    
    // Shear und SRH (Europa)
    const highCAPEThreshold = 500;
    const lowCAPEThreshold = 200;
    
    if (cape >= highCAPEThreshold) {
        if (shear >= 20) score += 10;
        else if (shear >= 15) score += 7;
        else if (shear >= 10) score += 4;
        else if (shear >= 8) score += 2;
        
        if (srh >= 200) score += 8;
        else if (srh >= 150) score += 6;
        else if (srh >= 120) score += 4;
        else if (srh >= 80) score += 2;
    } else if (cape >= lowCAPEThreshold) {
        if (shear >= 15) score += 3;
        else if (shear >= 10) score += 1;
        
        if (srh >= 150) score += 2;
        else if (srh >= 100) score += 1;
    }
    
    // Lifted Index (Europa, auch bei niedrigem CAPE relevant)
    if (cape >= 400) {
        if (liftedIndex <= -6) score += 10;
        else if (liftedIndex <= -4) score += 6;
        else if (liftedIndex <= -2) score += 3;
    } else if (cape >= 200) {
        if (liftedIndex <= -4) score += 3;
        else if (liftedIndex <= -2) score += 1;
    }
    
    // Lapse Rate (Europa)
    if (lapse >= 7.5) score += 5;
    else if (lapse >= 7.0) score += 3;
    else if (lapse >= 6.5) score += 2;
    else if (lapse >= 6.2) score += 1;
    else if (lapse >= 6.0) score += 1;
    if (lapse < 5.0 && cape < 800) score -= 4;
    
    // K-Index
    if (kIndex >= 35) score += 6;
    else if (kIndex >= 30) score += 4;
    else if (kIndex >= 25) score += 2;
    
    // Feuchtigkeit und Temperatur (Europa, auch bei niedrigem CAPE wichtig)
    if (cape >= 400) {
        if (dew >= 16 && temp2m >= 16) score += 4;
        else if (dew >= 13 && temp2m >= 13) score += 2;
        
        if (relHum2m >= 65 && temp2m >= 18) score += 3;
    } else if (cape >= 200) {
        if (dew >= 15 && temp2m >= 15) score += 3;
        else if (dew >= 13 && temp2m >= 13) score += 2;
        
        if (relHum2m >= 70 && temp2m >= 18) score += 2;
    }
    
    // Niederschlag (Europa)
    if (cape >= 400) {
        if (precipAcc >= 2.5 && cape >= 800) score += 6;
        else if (precipAcc >= 1.2 && cape >= 600) score += 4;
        else if (precipAcc >= 0.5 && cape >= 400) score += 2;
        
        if (precipProb >= 65 && cape >= 600) score += 4;
        else if (precipProb >= 45 && cape >= 400) score += 2;
    } else if (cape >= 200) {
        if (precipAcc >= 1.0) score += 2;
        else if (precipAcc >= 0.5) score += 1;
        else if (precipAcc >= 0.2) score += 1;
        
        if (precipProb >= 50) score += 2;
        else if (precipProb >= 30) score += 1;
    }
    
    // Dauerregen-Filter (Europa)
    if (precipAcc > 2 && cape < 400) score -= 8;
    
    // Relative Feuchte 500hPa (Europa)
    if (hour.rh500 < 35 && cape >= 800) score += 5;
    else if (hour.rh500 < 45 && cape >= 600) score += 3;
    else if (hour.rh500 > 85 && cape < 800) score -= 4;
    
    // Strahlung (tagsüber wichtig, Europa)
    const isNight = hour.directRadiation < 20;
    const isDaytime = hour.directRadiation >= 200;

    if (isDaytime && temp2m >= 12 && cape >= 300) {
        if (hour.directRadiation >= 500) score += 4;
        else if (hour.directRadiation >= 300) score += 2;
        else if (hour.directRadiation >= 200) score += 1;
    } else if (isNight) {
        const llj_active = srh >= 100 && shear >= 10;
        if (!llj_active && shear < 10 && cape < 500) score -= 3;
        if (llj_active && cape >= 600) score += 3;
        else if (cape >= 800 && srh >= 100) score += 2;
    }
    
    // Wind (Europa)
    if (hour.wind >= 5 && hour.wind <= 15 && temp2m >= 12) score += 2;
    else if (hour.wind > 15 && hour.wind <= 20 && temp2m >= 12) score += 4;
    if (hour.wind > 25 && cape < 1500) score -= 4;
    
    // Böen (Europa)
    const gustDiff = hour.gust - hour.wind;
    if (gustDiff > 12 && cape >= 800 && temp2m >= 12) score += 4;
    else if (gustDiff > 8 && cape >= 600) score += 2;

    // DCAPE: Downdraft-Potential (Gilmore & Wicker 1998)
    // Hoher DCAPE verstärkt Böen, Hagel, MCS-Aktivität
    const dcape = calcDCAPE(hour);
    // DCAPE: Downdraft-Potential (Europa-Schwellen)
    if (dcape >= 800 && cape >= 400) score += 5;
    else if (dcape >= 600 && cape >= 300) score += 3;
    else if (dcape >= 400 && cape >= 200) score += 1;
    
    // Temperatur-Reduktion (kälter = weniger wahrscheinlich, Europa)
    if (temp2m < minTempReduction) score = Math.round(score * tempReductionFactor);
    else if (temp2m < minTempReduction2) score = Math.round(score * tempReductionFactor2);
    
    // Mindestanforderungen für Gewitter (Europa)
    if (score > 0 && cape < 200) {
        score = Math.max(0, score - 5);
    }
    if (score > 0 && cin > 150 && cape < 1200) score = Math.max(0, score - 15);
    
    return Math.min(100, Math.max(0, Math.round(score)));
}

// Tornado-Wahrscheinlichkeitsberechnung (nur Europa)
function calculateTornadoProbability(hour, shear, srh) {
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0; // für LCL-Berechnung
    const cape = Math.max(0, hour.cape ?? 0);
    const cin = Math.abs(hour.cin ?? 0);
    const { liftedIndex } = calcIndices(hour);
    
    // Basis-Filter für Europa: Zu kalt oder keine Instabilität = kein Tornado
    const minTemp = 8;
    const minCAPE = 400;
    if (temp2m < minTemp) return 0;
    if (cape < minCAPE) return 0;
    if (cin > 200) return 0;
    
    // SRH für STP: 0-1 km SRH verwenden (SPC-Standard)
    const srh1km = calcSRH(hour, '0-1km');
    
    // STP berechnen (regionsspezifisch)
    // Veer-with-Height Check: Winds müssen mit der Höhe drehen (backing am Boden → veering oben)
    // Das ist physikalisch notwendig für positive SRH und Mesozyklonentwicklung
    const dir1000 = hour.windDir1000 ?? 0;
    const dir850 = hour.windDir850 ?? 0;
    const dir700 = hour.windDir700 ?? 0;

    function veeringAngle(d1, d2) {
        let diff = (d2 - d1 + 360) % 360;
        return diff > 180 ? diff - 360 : diff; // positiv = Veering, negativ = Backing
    }

    const veer850_1000 = veeringAngle(dir1000, dir850);
    const veer700_850 = veeringAngle(dir850, dir700);
    const totalVeering = veer850_1000 + veer700_850;

    let veeringFactor = 1.0;
    if (totalVeering < -20) veeringFactor = 0.3;
    else if (totalVeering < 0) veeringFactor = 0.6;
    else if (totalVeering >= 30) veeringFactor = 1.2;
    else if (totalVeering >= 15) veeringFactor = 1.1;

    const stp = calcSTP(cape, srh1km, shear, liftedIndex, cin, temp2m, dew) * veeringFactor;
    
    // Basis-Score für Tornado-Wahrscheinlichkeit
    let score = 0;
    
    // STP ist der Hauptindikator für Tornado-Potential (Europa)
    if (stp >= 2.0) score = 85;
    else if (stp >= 1.5) score = 70;
    else if (stp >= 1.0) score = 55;
    else if (stp >= 0.7) score = 40;
    else if (stp >= 0.5) score = 25;
    else if (stp >= 0.3) score = 12;
    else if (stp > 0) score = 5;
    
    // Zusätzliche Faktoren (Europa)
    if (cape >= 1000 && shear >= 18) score += 8;
    else if (cape >= 800 && shear >= 15) score += 5;
    else if (cape >= 600 && shear >= 12) score += 3;
    
    if (srh >= 200 && cape >= 800) score += 6;
    else if (srh >= 150 && cape >= 600) score += 4;
    else if (srh >= 120 && cape >= 500) score += 2;
    
    if (liftedIndex <= -5 && cape >= 800) score += 5;
    else if (liftedIndex <= -3 && cape >= 600) score += 3;
    
    const ehi = (cape * srh) / 160000;
    if (ehi >= 2.5) score += 8;
    else if (ehi >= 1.5) score += 5;
    else if (ehi >= 1.0) score += 3;
    
    if (cin > 100) score -= 10;
    if (shear < 10) score -= 15;
    if (srh < 80) score -= 10;
    
    // Temperatur-Reduktion (nur Europa)
    // Quellen:
    // - Taszarek et al. 2019 (J. Climate): Europa Gewittersaison ab März/April,
    //   Nordeuropa Mai-Oktober, Mittelmeer ganzjährig
    // - Sherburn & Parker 2014 (Wea. Forecasting): HSLC-Ereignisse (CAPE ≤ 500, Shear ≥ 18 m/s)
    //   bei DEUTLICH niedrigeren Temperaturen als klassische Warm-Saison-Gewitter möglich
    // - Morgenstern et al. 2023 (WCD): Wind-field-Thunderstorms Europa = niedrige CAPE,
    //   hoher Shear, oft Kalt-Saison → Temperaturschwelle darf nicht zu hoch sein
    // - Taszarek BAMS 2021 (USA/Europa Trends): 95. Perzentil T2M Europa für schwere Gewitter

    const tempThreshold1 = 8;
    const tempFactor1 = 0.5;
    const tempThreshold2 = 13;
    const tempFactor2 = 0.75;

    if (temp2m < tempThreshold1) score = Math.round(score * tempFactor1);
    else if (temp2m < tempThreshold2) score = Math.round(score * tempFactor2);

    // Finale Plausibilitätsprüfung:
    // HSLC-Ausnahme nach Sherburn & Parker 2014:
    // Bei hohem Shear (≥ 18 m/s) und niedrigem CAPE ist STP nahe 0 aber Ereignisse REAL
    if (stp < 0.1 && score > 10) {
        if (shear < 15) {
            score = Math.min(score, 8);   // kein HSLC → hart begrenzen
        } else {
            score = Math.min(score, 20);  // HSLC möglich → sanfter begrenzen
        }
    }

    // Minimalanforderungen (Europa) – nur noch für Grenzfälle die STP-Filter passiert haben
    const minCAPE_EU = 200;
    const minShear_EU = 8;
    const minSRH_EU = 50;

    let failCount = 0;
    if (cape  < minCAPE_EU  && score > 15) failCount++;
    if (shear < minShear_EU && score > 10) failCount++;
    if (srh   < minSRH_EU   && score > 10) failCount++;

    // Eine gestufte Gesamtreduktion statt kumulativer Einzelreduktionen
    if      (failCount === 3) score = Math.round(score * 0.35); // alle drei fehlen: stark reduzieren
    else if (failCount === 2) score = Math.round(score * 0.55); // zwei fehlen: moderat
    else if (failCount === 1) score = Math.round(score * 0.75); // einer fehlt: leicht reduzieren

    return Math.min(100, Math.max(0, Math.round(score)));
}
