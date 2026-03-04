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
                    `freezing_level_height,precipitation&forecast_days=16&models=icon_seamless,ecmwf_ifs,gfs_global&timezone=auto`;

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
                // CIN kommt von der API als negativer Wert (Stabilisierung). Wir speichern ihn mit Vorzeichen.
                cin: getMultiModelValue(data.hourly, 'convective_inhibition', i),
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

        // Tage gruppieren (maximale Gewitter- und Tornado-Werte pro Tag)
        const daysMap = new Map();
        hours.forEach(h => {
            const [datePart] = h.time.split('T');
            if (datePart >= currentDateStr) {
                const probability = calculateProbability(h);
                const shear = calcShear(h);
                const srh = calcSRH(h);
                const dcape = calcDCAPE(h);
                const wmaxshear = calcWMAXSHEAR(h.cape, shear);
                const tornadoProb = calculateTornadoProbability(h, shear, srh);
                const hailProb = calculateHailProbability(h, wmaxshear, dcape);
                const windProb = calculateWindProbability(h, wmaxshear, dcape);
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

        return res.status(200).json({
            timezone: timezone,
            region: region,
            stunden: stunden,
            tage: tage
        });

    } catch (error) {
        console.error('Fehler:', error);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}

// Hilfsfunktionen
// Multi-Modell-Wert aus icon_eu, ecmwf_ifs025, gfs_global bilden
function getMultiModelValue(hourly, baseName, index, agg = 'mean') {
    const models = ['icon_seamless', 'ecmwf_ifs', 'gfs_global'];
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

// Allgemeine Clamp-Funktion für normierte Indizes (0–1)
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
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
    // CIN ist in Europa konventionsgemäß negativ. Wir arbeiten hier mit dem Betrag der Hemmung.
    const magCin    = -Math.min(0, cin); // |CIN| für cin ≤ 0, sonst 0
    const cinTerm   = magCin < 40 ? 1.0 : Math.max(0.1, 1 - (magCin - 40) / 200);

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

// Schwerer Hagel (>2cm) Wahrscheinlichkeit (Europa) – ESTOFEX/ESSL-Methodik
// Quelle: Púčik et al. 2015 (ESSL), Taszarek et al. 2019/2020, ESTOFEX Forecast Guidelines
// Schwerer Hagel benötigt: hohe CAPE, starken Shear, niedriges Freezing Level, kalte 500hPa-Temperaturen
function calculateHailProbability(hour, wmaxshear, dcape) {
    const cape = Math.max(0, hour.cape ?? 0);
    const shear = calcShear(hour); // ~0–6 km BWD in m/s
    const temp500 = hour.temp500 ?? 0;
    const temp700 = hour.temp700 ?? 0;
    const freezingLevel = hour.freezingLevel ?? 4000; // m
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0;
    const lclHeight = calcLCLHeight(temp2m, dew);
    const midLapse = calcMidLevelLapseRate(temp700, temp500);
    const srh = calcSRH(hour, '0-3km');

    // Grobe Basis-Filter nach ESTOFEX/ESSL-Klimatologie:
    // - CAPE: in Europa oft niedriger als USA, aber für >2cm meist ≥ 400–600 J/kg
    // - Shear: organisierte Konvektion meist bei ≥ 12–15 m/s
    // - WMAXSHEAR: Taszarek 2020: schwere Ereignisse typ. ≥ 600–800 m²/s²
    // - Freezing Level: >3.5–3.8 km → schwerer Hagel selten am Boden
    if (cape < 350) return 0;
    if (shear < 10) return 0;
    if (wmaxshear < 500) return 0;
    if (freezingLevel > 3800) return 0;

    // Normierte Teilindizes (0–1), orientiert an europäischen Studien

    // CAPE-Index: 0 bei 400 J/kg, 1 bei 1800 J/kg
    const iCAPE = clamp((cape - 400) / (1800 - 400), 0, 1);

    // Deep-Layer-Shear-Index: 0 bei 12 m/s, 1 bei 22 m/s
    const iShear = clamp((shear - 12) / (22 - 12), 0, 1);

    // WMAXSHEAR-Index: 0 bei 600, 1 bei 1800
    const iWMAX = clamp((wmaxshear - 600) / (1800 - 600), 0, 1);

    // 500 hPa Temperatur: 0 bei -14 °C, 1 bei -24 °C (kälter = besser)
    const iT500 = clamp(( -14 - temp500) / ( -24 - -14), 0, 1);

    // Freezing-Level-Index: 0 bei 3500 m, 1 bei 1500 m
    const iFL = clamp((3500 - freezingLevel) / (3500 - 1500), 0, 1);

    // LCL-Index: 0 bei 1800 m, 1 bei 800 m
    const iLCL = clamp((1800 - lclHeight) / (1800 - 800), 0, 1);

    // Midlevel-Lapse-Rate-Index 700–500 hPa: 0 bei 6.5 K/km, 1 bei 8.5 K/km
    const iLapse = clamp((midLapse - 6.5) / (8.5 - 6.5), 0, 1);

    // SRH-Index (0–3 km): 0 bei 80 m²/s², 1 bei 250 m²/s²
    const iSRH = clamp((srh - 80) / (250 - 80), 0, 1);

    // DCAPE: eher sekundär für Hagel, aber hilfreich für Transport nach unten
    const iDCAPE = clamp((dcape - 400) / (1200 - 400), 0, 1);

    // 500 hPa relative Feuchte: trocken (30–50 %) begünstigt Hagel
    let iRH500 = 0;
    if (hour.rh500 != null) {
        if (hour.rh500 <= 30) iRH500 = 1;
        else if (hour.rh500 <= 50) iRH500 = clamp((50 - hour.rh500) / (50 - 30), 0, 1) * 0.7;
        else if (hour.rh500 >= 80) iRH500 = 0;
    }

    // Gewichtung der Teilindizes nach ESTOFEX/ESSL-Erfahrung:
    // CAPE + WMAXSHEAR + Shear dominieren, Freezing Level und T500 stark gewichtet,
    // LCL/Lapse/SRH als Modulatoren.
    const wCAPE  = 0.18;
    const wShear = 0.14;
    const wWMAX  = 0.18;
    const wT500  = 0.12;
    const wFL    = 0.12;
    const wLCL   = 0.08;
    const wLapse = 0.07;
    const wSRH   = 0.06;
    const wDCAPE = 0.03;
    const wRH500 = 0.02;

    const hailIndex =
        iCAPE  * wCAPE  +
        iShear * wShear +
        iWMAX  * wWMAX  +
        iT500  * wT500  +
        iFL    * wFL    +
        iLCL   * wLCL   +
        iLapse * wLapse +
        iSRH   * wSRH   +
        iDCAPE * wDCAPE +
        iRH500 * wRH500;

    // Logistic-Mapping des zusammengesetzten Index auf 0–100 %:
    // hailIndex ~0.4 → ~10–20 %, ~0.6 → ~30–40 %, >0.75 → >60 %.
    const a = 5.5;   // Steilheit
    const b = 0.6;   // Schwelle für markant erhöhte Wahrscheinlichkeiten
    const prob = 100 / (1 + Math.exp(-a * (hailIndex - b)));

    // Plausibilitätsbegrenzung gemäß ESTOFEX-Level:
    // - Unter Grenzbedingungen (CAPE < 600, WMAXSHEAR < 800) max. ~40 %
    // - Klassische Level-2-Lagen (CAPE > 1000, WMAXSHEAR > 1100, FL < 3 km) erreichen >60 %
    let finalProb = prob;
    const strongEnv =
        cape >= 1000 &&
        shear >= 18 &&
        wmaxshear >= 1100 &&
        freezingLevel <= 3000 &&
        temp500 <= -18;

    if (!strongEnv && (cape < 600 || wmaxshear < 800)) {
        finalProb = Math.min(finalProb, 40);
    }

    if (strongEnv) {
        // leichte Anhebung für sehr gut organisierte Superzellenlagen
        finalProb = Math.min(100, finalProb + 10);
    }

    return Math.round(Math.min(100, Math.max(0, finalProb)));
}

// Schwere Winde (≥25 m/s / ≥90 km/h) Wahrscheinlichkeit (Europa) – ESTOFEX/ESSL-Methodik
// Quelle: Gatzen et al. 2020 (Derechos Deutschland), Taszarek et al. 2019/2020, ESTOFEX Forecast Guidelines
// Schwere Winde benötigen: hohen DCAPE, organisierte Konvektion (MCS/Derecho), hohen WMAXSHEAR
function calculateWindProbability(hour, wmaxshear, dcape) {
    const cape = Math.max(0, hour.cape ?? 0);
    const shear = calcShear(hour);
    const wind10m = hour.wind ?? 0;   // km/h
    const gust = hour.gust ?? 0;      // km/h
    const gustDiff = gust - wind10m;
    const temp700 = hour.temp700 ?? 0;
    const dew700 = hour.dew700 ?? 0;
    const temp500 = hour.temp500 ?? 0;

    // Basis-Filter für schwere Winde (≥ ~90 km/h / ≥25 m/s) nach ESTOFEX/ESSL:
    // - DCAPE oder WMAXSHEAR müssen erhöht sein
    // - Böenprognose mindestens Sturmstärke
    if (dcape < 350 && wmaxshear < 500) return 0;
    if (shear < 8 && cape < 400) return 0;
    if (gust < 70) return 0;

    // Normierte Teilindizes (0–1)

    // DCAPE-Index: 0 bei 400 J/kg, 1 bei 1400 J/kg
    const iDCAPE = clamp((dcape - 400) / (1400 - 400), 0, 1);

    // WMAXSHEAR-Index: 0 bei 600, 1 bei 1700
    const iWMAX = clamp((wmaxshear - 600) / (1700 - 600), 0, 1);

    // Deep-Layer-Shear-Index: 0 bei 10 m/s, 1 bei 22 m/s
    const iShear = clamp((shear - 10) / (22 - 10), 0, 1);

    // CAPE-Index: für Windereignisse reicht oft moderates CAPE
    const iCAPE = clamp((cape - 300) / (1200 - 300), 0, 1);

    // Böenniveau-Index: 0 bei 70 km/h, 1 bei 130 km/h
    const iGust = clamp((gust - 70) / (130 - 70), 0, 1);

    // Böenüberschuss gegenüber Mittelwind – gute Proxy für konvektive Böen
    const iGustDiff = clamp((gustDiff - 10) / (40 - 10), 0, 1);

    // 700 hPa Feuchte (Taupunktspreizung) – trockene Luft = stärkere Downbursts
    const dewDepression700 = temp700 - dew700;
    let iDry700 = 0;
    if (dewDepression700 >= 20) iDry700 = 1;
    else if (dewDepression700 >= 10) iDry700 = (dewDepression700 - 10) / (20 - 10);

    // 500 hPa Temperatur – kalte mittlere Troposphäre begünstigt Downbursts
    let iT500 = 0;
    if (temp500 <= -20) iT500 = 1;
    else if (temp500 <= -12) iT500 = (-12 - temp500) / (-12 + 20);

    // RH500 – trockene mittlere Troposphäre begünstigt starke Fallböen
    let iRH500 = 0;
    if (hour.rh500 != null) {
        if (hour.rh500 <= 35) iRH500 = 1;
        else if (hour.rh500 <= 55) iRH500 = (55 - hour.rh500) / (55 - 35);
    }

    // Gewichtung der Teilindizes nach Gatzen/Taszarek/ESTOFEX:
    // DCAPE + WMAXSHEAR + Böen (Niveau + Überschuss) dominieren,
    // Shear/CAPE und trockene Mittel-/Obertr. modulieren.
    const wDCAPE   = 0.22;
    const wWMAX    = 0.2;
    const wGust    = 0.18;
    const wGustDif = 0.12;
    const wShear   = 0.1;
    const wCAPE    = 0.06;
    const wDry700  = 0.05;
    const wT500    = 0.04;
    const wRH500   = 0.03;

    const windIndex =
        iDCAPE   * wDCAPE   +
        iWMAX    * wWMAX    +
        iGust    * wGust    +
        iGustDiff* wGustDif +
        iShear   * wShear   +
        iCAPE    * wCAPE    +
        iDry700  * wDry700  +
        iT500    * wT500    +
        iRH500   * wRH500;

    // Logistic-Mapping auf 0–100 %:
    // windIndex ~0.35 → ~10–15 %, ~0.5 → ~25–30 %, >0.7 → >60 %.
    const a = 5.0;
    const b = 0.55;
    const prob = 100 / (1 + Math.exp(-a * (windIndex - b)));

    // Plausibilitätsbegrenzung:
    // - Unterhalb klassischer Level‑1‑Bedingungen (Gust < 90, DCAPE < 500, WMAXSHEAR < 700) max. ~35 %
    // - Klassische Derecho/MCS-Fälle können deutlich höher gehen.
    let finalProb = prob;
    const derechoLike =
        dcape >= 1000 &&
        wmaxshear >= 1200 &&
        shear >= 18 &&
        gust >= 110;

    if (!derechoLike && (gust < 90 || dcape < 500 || wmaxshear < 700)) {
        finalProb = Math.min(finalProb, 35);
    }

    if (derechoLike) {
        finalProb = Math.min(100, finalProb + 10);
    }

    return Math.round(Math.min(100, Math.max(0, finalProb)));
}

// Verbesserte LCL-Berechnung nach Bolton (1980) - präziser für Europa
function calcLCLHeight(temp2m, dew2m) {
    if (temp2m <= 0 || dew2m <= 0) return 2000; // Fallback: hohes LCL
    const T = temp2m + 273.15;
    const Td = dew2m + 273.15;
    const LCL = 125 * (temp2m - dew2m); // Vereinfachte Bolton-Formel
    return Math.max(0, LCL);
}

// Mid-Level Lapse Rate (700-500 hPa) - wichtig für Europa
function calcMidLevelLapseRate(temp700, temp500) {
    // Höhendifferenz 700-500 hPa ≈ 2000 m
    const dz = 2000;
    if (dz <= 0) return 0;
    return (temp700 - temp500) / (dz / 1000); // K/km
}

// Moisture Depth (850-700 hPa) - Feuchtigkeitstiefe für Konvektion
function calcMoistureDepth(dew850, dew700, temp850, temp700) {
    const rh850 = calcRelHum(temp850, dew850);
    const rh700 = calcRelHum(temp700, dew700);
    // Durchschnittliche relative Feuchte in der Schicht
    return (rh850 + rh700) / 2;
}

// Effective Layer Instability (ELI) - ESSL-Methodik für Europa
function calcELI(cape, cin, pblHeight) {
    // ELI berücksichtigt CAPE, CIN und Boundary Layer Height
    // Höhere PBL = bessere Durchmischung = höheres ELI
    if (cape < 50) return 0;
    const pblFactor = pblHeight > 1500 ? 1.2 : pblHeight > 1000 ? 1.0 : pblHeight > 500 ? 0.8 : 0.6;
    // CIN negativ: je stärker (größerer Betrag), desto kleiner der Faktor
    const magCin    = -Math.min(0, cin); // |CIN| für cin ≤ 0, sonst 0
    const cinFactor = magCin < 25 ? 1.0
        : magCin < 50 ? 0.9
        : magCin < 100 ? 0.7
        : magCin < 150 ? 0.5
        : 0.3;
    return cape * pblFactor * cinFactor;
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

    // LCL-Höhe nach Bolton (1980) - verwendet verbesserte calcLCLHeight Funktion
    let lclTerm;
    if (temp2m !== null && dew2m !== null) {
        const lclHeight = calcLCLHeight(temp2m, dew2m);
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

    // *** CIN: hartes Cutoff bei -200 J/kg, set to 1 wenn > -50 J/kg (SPC-Standard, CIN negativ) ***
    // CIN ist hier negativ definiert (z.B. -50, -100, -200 J/kg)
    let cinTerm;
    if (cin >= -50) cinTerm = 1.0;            // schwache Hemmung (|CIN| ≤ 50)
    else if (cin <= -200) cinTerm = 0.0;      // stark negative CIN → STP = 0
    else cinTerm = (200 + cin) / 150;         // lineare Interpolation für -200 < CIN < -50

    return Math.max(0, capeTerm * srhTerm * shearTerm * lclTerm * cinTerm);
}

// Hauptfunktion für Wahrscheinlichkeitsberechnung (verbessert nach ESSL/European Forecast Experiment)
function calculateProbability(hour) {
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0;
    const cape = Math.max(0, hour.cape ?? 0);
    // CIN wird negativ geliefert (z.B. -50, -100, -200 J/kg)
    const cin = hour.cin ?? 0;
    const magCin = -Math.min(0, cin); // Betrag der Hemmung |CIN| für cin ≤ 0
    const precipAcc = hour.precipAcc ?? 0;
    const precipProb = hour.precip ?? 0;
    const pblHeight = hour.pblHeight ?? 1000;
    
    // Europa-Parameter (ESSL/European Forecast Experiment-orientiert)
    // Taszarek et al. 2019/2020: Europa hat niedrigere CAPE-Schwellen, stärkere Shear-Gewichtung
    const minTemp = 3; // Kalt-Saison-Gewitter möglich (Morgenstern 2023)
    const minTempWithCAPE = 8;
    const minCAPE = 150; // ESSL: Gewitter ab ~150 J/kg möglich
    const minCAPEWithPrecip = 80;
    
    // Filter für Fehlalarme (Europa) - weniger restriktiv für HSLC-Fälle
    if (temp2m < minTemp && cape < 300) return 0; // Zu kalt, außer bei sehr hohem CAPE
    if (temp2m < minTempWithCAPE && cape < (minCAPE * 1.2)) {
        // HSLC-Check: Bei hohem Shear auch bei niedrigem CAPE möglich
        const shear = calcShear(hour);
        if (shear < 15) return 0; // Kein HSLC-Potential
    }
    if (cape < minCAPEWithPrecip && precipAcc < 0.1 && precipProb < 15) return 0;
    
    // Berechne Indizes
    const shear = calcShear(hour);
    const srh1km = calcSRH(hour, '0-1km');
    const srh = calcSRH(hour, '0-3km');
    const { kIndex, showalter, lapse, liftedIndex } = calcIndices(hour);
    const relHum2m = calcRelHum(temp2m, dew);
    const cloudSum = (hour.cloudLow ?? 0) + (hour.cloudMid ?? 0) + (hour.cloudHigh ?? 0);
    
    // Verbesserte physikalische Parameter
    const lclHeight = calcLCLHeight(temp2m, dew);
    const midLapse = calcMidLevelLapseRate(hour.temp700 ?? 0, hour.temp500 ?? 0);
    const moistureDepth = calcMoistureDepth(hour.dew850 ?? 0, hour.dew700 ?? 0, hour.temp850 ?? 0, hour.temp700 ?? 0);
    const eli = calcELI(cape, cin, pblHeight);
    
    // Kombinierte Indizes (Europa-optimiert)
    const ehi = (cape * srh) / 160000;
    const scp = calcSCP(cape, shear, srh, cin);
    const stp = calcSTP(cape, srh1km, shear, liftedIndex, cin, temp2m, dew);
    const wmaxshear = calcWMAXSHEAR(cape, shear);
    const dcape = calcDCAPE(hour);
    
    // Basis-Score basierend auf kombinierten Indizes
    let score = 0;
    
    // CAPE-Bewertung (Europa) - niedrigere Schwellen als USA
    // Taszarek 2020: Europa CAPE-Median ~500-800 J/kg für schwere Gewitter
    if (cape >= 2000) score += 28;
    else if (cape >= 1500) score += 24;
    else if (cape >= 1200) score += 20;
    else if (cape >= 800) score += 16;
    else if (cape >= 500) score += 12;
    else if (cape >= 300) score += 8;
    else if (cape >= 150) score += 4;
    
    // Effective Layer Instability (ELI) - ESSL-Methodik
    if (eli >= 2000) score += 10;
    else if (eli >= 1200) score += 7;
    else if (eli >= 800) score += 5;
    else if (eli >= 400) score += 3;
    
    // CIN-Bewertung (verbessert) - nicht nur Penalty, sondern auch positive Signale
    // magCin = |CIN|: kleine Beträge → günstig, große Beträge → inhibierend
    if (magCin < 25 && cape >= 300) score += 6; // Sehr günstig für Konvektion
    else if (magCin < 50 && cape >= 200) score += 3;
    else if (magCin > 200) score -= 18; // Stark inhibierend
    else if (magCin > 100) score -= 10;
    else if (magCin > 50) score -= 5;
    
    // Kombinierte Indizes (Europa) - stärkere Gewichtung
    if (scp >= 3.0) score += 24;
    else if (scp >= 2.0) score += 20;
    else if (scp >= 1.5) score += 16;
    else if (scp >= 1.0) score += 12;
    else if (scp >= 0.5) score += 6;
    
    if (stp >= 2.0) score += 18;
    else if (stp >= 1.5) score += 15;
    else if (stp >= 1.0) score += 12;
    else if (stp >= 0.5) score += 8;
    else if (stp >= 0.3) score += 4;
    
    // EHI-Schwellen (Europa-angepasst)
    if (ehi >= 2.5) score += 14;
    else if (ehi >= 2.0) score += 12;
    else if (ehi >= 1.0) score += 9;
    else if (ehi >= 0.5) score += 5;
    else if (ehi >= 0.3) score += 3;
    
    // WMAXSHEAR-Score (Taszarek 2020: bester globaler Prädiktor)
    if (wmaxshear >= 1500) score += 22;
    else if (wmaxshear >= 1200) score += 18;
    else if (wmaxshear >= 900) score += 14;
    else if (wmaxshear >= 700) score += 10;
    else if (wmaxshear >= 500) score += 7;
    else if (wmaxshear >= 300) score += 4;
    
    // Shear-Bewertung (Europa) - stärker gewichtet als CAPE
    // Púčik 2015: Deep-Layer-Shear entscheidend für schwere Gewitter in Europa
    if (shear >= 25) score += 14;
    else if (shear >= 20) score += 11;
    else if (shear >= 15) score += 8;
    else if (shear >= 12) score += 5;
    else if (shear >= 10) score += 3;
    else if (shear >= 8) score += 1;
    
    // SRH-Bewertung (Europa)
    if (srh >= 250) score += 10;
    else if (srh >= 200) score += 8;
    else if (srh >= 150) score += 6;
    else if (srh >= 120) score += 4;
    else if (srh >= 80) score += 2;
    
    // LCL-Höhe (verbessert) - niedriges LCL = bessere Konvektion
    if (lclHeight < 500) score += 8;
    else if (lclHeight < 800) score += 6;
    else if (lclHeight < 1200) score += 4;
    else if (lclHeight < 1500) score += 2;
    else if (lclHeight >= 2500) score -= 6; // Zu hohes LCL = trocken, weniger Konvektion
    
    // Mid-Level Lapse Rate (700-500 hPa) - wichtig für Europa
    if (midLapse >= 8.0) score += 8;
    else if (midLapse >= 7.5) score += 6;
    else if (midLapse >= 7.0) score += 4;
    else if (midLapse >= 6.5) score += 2;
    else if (midLapse < 5.5 && cape < 800) score -= 5;
    
    // Moisture Depth (850-700 hPa) - Feuchtigkeitstiefe
    if (moistureDepth >= 75) score += 6;
    else if (moistureDepth >= 65) score += 4;
    else if (moistureDepth >= 55) score += 2;
    else if (moistureDepth < 40 && cape < 600) score -= 4;
    
    // Lifted Index (Europa)
    if (liftedIndex <= -7) score += 12;
    else if (liftedIndex <= -6) score += 10;
    else if (liftedIndex <= -4) score += 7;
    else if (liftedIndex <= -2) score += 4;
    else if (liftedIndex <= 0) score += 1;
    
    // K-Index (verbessert)
    if (kIndex >= 38) score += 8;
    else if (kIndex >= 35) score += 6;
    else if (kIndex >= 30) score += 4;
    else if (kIndex >= 25) score += 2;
    
    // Feuchtigkeit und Temperatur (Europa)
    // Taszarek 2021: Taupunkt wichtiger als absolute Temperatur
    if (dew >= 18 && temp2m >= 18) score += 6;
    else if (dew >= 16 && temp2m >= 16) score += 4;
    else if (dew >= 13 && temp2m >= 13) score += 2;
    
    if (relHum2m >= 75 && temp2m >= 18) score += 5;
    else if (relHum2m >= 70 && temp2m >= 16) score += 3;
    else if (relHum2m >= 65 && temp2m >= 14) score += 1;
    
    // Niederschlag (Europa) - stärker gewichtet
    if (precipAcc >= 3.0 && cape >= 600) score += 8;
    else if (precipAcc >= 2.0 && cape >= 400) score += 6;
    else if (precipAcc >= 1.0 && cape >= 300) score += 4;
    else if (precipAcc >= 0.5 && cape >= 200) score += 2;
    
    if (precipProb >= 70 && cape >= 500) score += 6;
    else if (precipProb >= 55 && cape >= 400) score += 4;
    else if (precipProb >= 40 && cape >= 300) score += 2;
    
    // Dauerregen-Filter (Europa) - verbessert
    if (precipAcc > 3 && cape < 300 && shear < 10) score -= 10;
    else if (precipAcc > 2 && cape < 200) score -= 6;
    
    // Relative Feuchte 500hPa (Europa) - trockene mittlere Troposphäre begünstigt
    if (hour.rh500 < 30 && cape >= 600) score += 7;
    else if (hour.rh500 < 40 && cape >= 500) score += 5;
    else if (hour.rh500 < 50 && cape >= 400) score += 3;
    else if (hour.rh500 > 90 && cape < 800) score -= 6; // Zu feucht = stabilisierend
    
    // Strahlung (tagsüber wichtig, Europa) - verbessert
    const isNight = hour.directRadiation < 20;
    const isDaytime = hour.directRadiation >= 200;
    const isStrongDaytime = hour.directRadiation >= 600;

    if (isStrongDaytime && temp2m >= 14 && cape >= 300) {
        score += 7; // Starke Sonneneinstrahlung = starke Erwärmung
    } else if (isDaytime && temp2m >= 12 && cape >= 200) {
        score += 4;
    } else if (isNight) {
        // Low-Level-Jet Detection (Europa) - verbessert
        const llj_active = srh >= 120 && shear >= 12 && hour.wind >= 8;
        if (llj_active && cape >= 500) {
            score += 5; // LLJ aktiv = nächtliche Konvektion möglich
        } else if (!llj_active && shear < 10 && cape < 400) {
            score -= 4; // Kein LLJ, schwacher Shear = wenig nächtliche Konvektion
        } else if (cape >= 600 && srh >= 100) {
            score += 2; // Moderate nächtliche Bedingungen
        }
    }
    
    // Wind (Europa) - verbessert
    if (hour.wind >= 6 && hour.wind <= 18 && temp2m >= 12) score += 3;
    else if (hour.wind > 18 && hour.wind <= 25 && temp2m >= 12) score += 5;
    if (hour.wind > 30 && cape < 1200) score -= 6; // Zu starker Wind = stabilisierend
    
    // Böen (Europa) - verbessert
    const gustDiff = hour.gust - hour.wind;
    if (gustDiff > 15 && cape >= 600 && temp2m >= 12) score += 6;
    else if (gustDiff > 12 && cape >= 500) score += 4;
    else if (gustDiff > 8 && cape >= 300) score += 2;

    // DCAPE: Downdraft-Potential (Europa-Schwellen) - verbessert
    if (dcape >= 1000 && cape >= 400) score += 7;
    else if (dcape >= 800 && cape >= 300) score += 5;
    else if (dcape >= 600 && cape >= 200) score += 3;
    else if (dcape >= 400 && cape >= 150) score += 1;
    
    // Boundary Layer Height - Triggering-Faktor
    if (pblHeight >= 2000 && cape >= 300) score += 4; // Sehr hohe PBL = gute Durchmischung
    else if (pblHeight >= 1500 && cape >= 200) score += 2;
    else if (pblHeight < 300 && cape < 500) score -= 3; // Zu niedrige PBL = schlechtes Triggering
    
    // Temperatur-Reduktion (Europa) - verbessert für HSLC-Fälle
    if (temp2m < 8) {
        // Bei sehr niedriger Temperatur: nur bei hohem Shear/CAPE relevant
        if (shear < 15 && cape < 500) {
            score = Math.round(score * 0.4); // Stark reduzieren
        } else {
            score = Math.round(score * 0.6); // Moderate Reduktion für HSLC
        }
    } else if (temp2m < 12) {
        score = Math.round(score * 0.7);
    } else if (temp2m < 15) {
        score = Math.round(score * 0.85);
    }
    
    // Finale Plausibilitätsprüfung (Europa)
    // Mindestanforderungen nach ESSL-Climatology
    if (score > 0 && cape < 100 && shear < 8) {
        score = Math.max(0, score - 10); // Zu wenig CAPE und Shear
    }
    // Starke Hemmung (großer |CIN|) ohne viel CAPE herunterstufen
    if (score > 0 && magCin > 150 && cape < 1000) {
        score = Math.max(0, score - 12); // Zu hohes CIN ohne ausreichendes CAPE
    }
    
    // HSLC-Sonderfall: Bei sehr hohem Shear auch bei niedrigem CAPE möglich
    if (shear >= 20 && cape >= 150 && score < 30) {
        score = Math.min(score + 5, 35); // Leichter Boost für HSLC-Fälle
    }
    
    return Math.min(100, Math.max(0, Math.round(score)));
}

// Tornado-Wahrscheinlichkeitsberechnung (nur Europa)
function calculateTornadoProbability(hour, shear, srh) {
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0; // für LCL-Berechnung
    const cape = Math.max(0, hour.cape ?? 0);
    // CIN negativ (hemmend); wir nutzen für Filter den Betrag
    const cin = hour.cin ?? 0;
    const magCin = -Math.min(0, cin); // |CIN| für cin ≤ 0
    const { liftedIndex } = calcIndices(hour);
    
    // Basis-Filter für Europa: Zu kalt oder keine Instabilität = kein Tornado
    const minTemp = 8;
    const minCAPE = 400;
    if (temp2m < minTemp) return 0;
    if (cape < minCAPE) return 0;
    if (magCin > 200) return 0;
    
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
    
    if (magCin > 100) score -= 10;
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
