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
                    `freezing_level_height,precipitation&forecast_days=16&models=icon_d2,icon_eu,ecmwf_ifs025,gfs_global,arpege_europe,dmi_harmonie_arome_europe&timezone=auto`;

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
                // Nur übernehmen wenn mindestens 2 Modelle einen Wert liefern, sonst 0 (neutral)
                cin: (() => {
                    // AROME liefert CIN als positive Zahl (z.B. 50 statt -50)
                    // Wir korrigieren das VOR der Gewichtung direkt in den Rohdaten
                    const aromeKey = 'convective_inhibition_dmi_harmonie_arome_europe';
                    if (Array.isArray(data.hourly[aromeKey]) && 
                        data.hourly[aromeKey][i] !== null && 
                        data.hourly[aromeKey][i] !== undefined &&
                        data.hourly[aromeKey][i] > 0) {
                        // Vorzeichen umkehren: +50 → -50
                        data.hourly[aromeKey][i] = -data.hourly[aromeKey][i];
                    }
                    return countModels(data.hourly, 'convective_inhibition', i) >= 2
                        ? getMultiModelValue(data.hourly, 'convective_inhibition', i) : 0;
                })(),
                liftedIndex: countModels(data.hourly, 'lifted_index', i) >= 2
                ? getMultiModelValue(data.hourly, 'lifted_index', i) : 0,
                pblHeight: countModels(data.hourly, 'boundary_layer_height', i) >= 2
                ? getMultiModelValue(data.hourly, 'boundary_layer_height', i) : 1000,       
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

        // Debug: Rohwerte aller Modelle für die erste Stunde (Index 0)
        const debugRohwerte = {};
        const debugGewichtet = {};
        const alleFelder = [
            'cape', 'temperature_2m', 'dew_point_2m',
            'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
            'precipitation_probability', 'precipitation',
            'wind_speed_10m', 'wind_gusts_10m',
            'wind_direction_1000hPa', 'wind_direction_850hPa', 'wind_direction_700hPa',
            'wind_direction_500hPa', 'wind_direction_300hPa',
            'wind_speed_1000hPa', 'wind_speed_850hPa', 'wind_speed_700hPa',
            'wind_speed_500hPa', 'wind_speed_300hPa',
            'temperature_500hPa', 'temperature_700hPa', 'temperature_850hPa',
            'dew_point_850hPa', 'dew_point_700hPa',
            'relative_humidity_500hPa',
            'convective_inhibition', 'lifted_index',
            'boundary_layer_height', 'direct_radiation',
            'freezing_level_height'
        ];
        const modellNamen = ['icon_d2', 'icon_eu', 'arpege_europe', 'ecmwf_ifs025', 'gfs_global', 'dmi_harmonie_arome_europe'];

        for (const feld of alleFelder) {
            debugRohwerte[feld] = {};
            for (const modell of modellNamen) {
                const key = `${feld}_${modell}`;
                debugRohwerte[feld][modell] = data.hourly[key]?.[0] ?? null;
            }
            // Zeigt den bereinigten Endwert nach dynamischer Gewichtung
            debugGewichtet[feld] = getMultiModelValue(data.hourly, feld, 0);
        }

        // Debug: Rohwerte für die nächsten 5 Stunden ab JETZT
        const debugStunden = [];
        const jetztStunden = nextHours.slice(0, 5); // nextHours ist bereits ab aktueller Uhrzeit gefiltert
        for (let s = 0; s < jetztStunden.length; s++) {
            const stunde = hours.find(h => h.time === jetztStunden[s].timestamp);
            if (!stunde) break;

            // Index in den originalen hours-Array finden (für Rohwerte)
            const originalIndex = data.hourly.time.indexOf(stunde.time);

            const rohwerte = {};
            for (const feld of alleFelder) {
                rohwerte[feld] = {};
                for (const modell of modellNamen) {
                    const key = `${feld}_${modell}`;
                    rohwerte[feld][modell] = data.hourly[key]?.[originalIndex] ?? null;
                }
            }

            debugStunden.push({
                timestamp: stunde.time,
                rohwerte_pro_modell: rohwerte,
                berechnete_parameter: stunde
            });
        }

    } catch (error) {
        console.error('Fehler:', error);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}

// Gibt zurück wie viele Modelle einen Wert liefern (nicht null)
function countModels(hourly, baseName, index) {
    const models = ['icon_d2', 'icon_eu', 'arpege_europe', 'ecmwf_ifs025', 'gfs_global', 'dmi_harmonie_arome_europe'];
    let count = 0;
    for (const model of models) {
        const key = `${baseName}_${model}`;
        const arr = hourly[key];
        if (Array.isArray(arr) && arr[index] !== null && arr[index] !== undefined) count++;
    }
    return count;
}

// Hilfsfunktionen
// Multi-Modell-Wert aus icon_eu, ecmwf_ifs025, gfs_global bilden
function getMultiModelValue(hourly, baseName, index, agg = 'mean') {
    const models = ['icon_d2', 'icon_eu', 'arpege_europe', 'ecmwf_ifs025', 'gfs_global', 'dmi_harmonie_arome_europe'];
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

    // --- NEU: Dynamische Gewichtung mit Ausreißer-Entfernung ---

    // Weniger als 3 Modelle? Einfacher Mittelwert reicht
    if (values.length < 3) {
        return values.reduce((s, v) => s + v, 0) / values.length;
    }

    // SCHRITT 1: Sortieren
    const sorted = [...values].sort((a, b) => a - b);

    // Median korrekt berechnen
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;

    // SCHRITT 2: Nur filtern wenn mindestens 3 Werte vorhanden
    // Bei 1-2 Werten: direkt zurückgeben, kein Ausreißer-Check möglich
    if (values.length <= 2) {
        return values.reduce((s, v) => s + v, 0) / values.length;
    }

    // SCHRITT 3: Ausreißer entfernen
    // Abweichung relativ zum Betrag des Medians (funktioniert auch bei negativen Werten!)
    const absMedian = Math.abs(median);
    const schwelle = absMedian < 5
        ? 10        // bei kleinen/nahe-null Werten: feste Schwelle 10 Einheiten
        : absMedian * 0.65; // sonst: 65% Abweichung erlaubt

    const filtered = values.filter(v => Math.abs(v - median) <= schwelle);
    const useValues = filtered.length >= 2 ? filtered : values;

    // SCHRITT 4: Gewichte berechnen
    // Näher am Median = mehr Gewicht, funktioniert auch bei negativen Zahlen
    const weights = useValues.map(v => {
        const distance = Math.abs(v - median);
        const normDist = absMedian > 1 ? distance / absMedian : distance;
        return 1 / (1 + normDist);
    });

    // SCHRITT 5: Gewichteten Mittelwert berechnen
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const weightedSum = useValues.reduce((s, v, i) => s + v * weights[i], 0);
    return weightedSum / totalWeight;
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

// Hagel ≥1cm Wahrscheinlichkeit (Europa) – ESTOFEX/ESSL-Methodik (abgemilderte Schwellen)
// Quelle: Púčik et al. 2015 (ESSL), Taszarek et al. 2019/2020, ESTOFEX Forecast Guidelines
// Hagel ≥1cm benötigt: ausreichende CAPE, moderaten bis starken Shear, relativ niedriges Freezing Level, kalte 500hPa-Temperaturen
function calculateHailProbability(hour, wmaxshear, dcape) {
    const cape = Math.max(0, hour.cape ?? 0);
    const shear = calcShear(hour);
    const temp500 = hour.temp500 ?? 0;
    const temp700 = hour.temp700 ?? 0;
    const freezingLevel = hour.freezingLevel ?? 4000; // m
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0;
    const lclHeight = calcLCLHeight(temp2m, dew);
    const midLapse = calcMidLevelLapseRate(temp700, temp500);
    const srh = calcSRH(hour, '0-3km');

    // Basis-Filter für Hagel ≥1cm (abgemildert gegenüber >2cm):
    // Púčik 2015: Schwerer Hagel in Europa meist bei CAPE ≥ 500 J/kg, Shear ≥ 15 m/s
    // Für ≥1cm-Hagel lassen wir bereits etwas geringere Werte zu.
    if (cape < 250) return 0; // Zu wenig CAPE selbst für 1cm-Hagel
    if (shear < 10) return 0; // Zu wenig Shear für organisierte Konvektion
    if (wmaxshear < 450) return 0; // WMAXSHEAR zu niedrig selbst für 1cm-Hagel
    if (freezingLevel > 3800) return 0; // Sehr hohes Freezing Level → Hagel schmilzt oft

    let score = 0;

    // CAPE – kritisch für Hagel, aber für ≥1cm etwas niedrigere Schwellen als für >2cm
    if (cape >= 2000) score += 28;
    else if (cape >= 1500) score += 24;
    else if (cape >= 1200) score += 20;
    else if (cape >= 800) score += 15;
    else if (cape >= 600) score += 9;
    else if (cape >= 350) score += 4;

    // WMAXSHEAR – bester Prädiktor für Hagel (Taszarek 2020),
    // für ≥1cm geringfügig abgemilderte Schwellen
    if (wmaxshear >= 1700) score += 30;
    else if (wmaxshear >= 1350) score += 26;
    else if (wmaxshear >= 1050) score += 21;
    else if (wmaxshear >= 850) score += 15;
    else if (wmaxshear >= 650) score += 9;
    else if (wmaxshear >= 500) score += 4;

    // Deep-Layer-Shear (0-6km) – Superzellen-Organisation (Púčik 2015)
    // Für ≥1cm-Hagel genügt teils auch etwas geringerer Shear
    if (shear >= 24) score += 13;
    else if (shear >= 20) score += 10;
    else if (shear >= 17) score += 7;
    else if (shear >= 14) score += 4;
    else if (shear >= 10) score += 2;

    // SRH – Mesozyklonen-Entwicklung (Púčik 2015, ESTOFEX)
    // Schwerer Hagel oft in Superzellen mit hohem SRH
    if (srh >= 250) score += 10;
    else if (srh >= 200) score += 8;
    else if (srh >= 150) score += 5;
    else if (srh >= 120) score += 3;

    // 500 hPa-Temperatur – kritisch für Hagelwachstum (ESTOFEX)
    // Je kälter, desto höher die Hagelproduktion (Wachstumszone)
    if (temp500 <= -22) score += 11;
    else if (temp500 <= -20) score += 9;
    else if (temp500 <= -18) score += 6;
    else if (temp500 <= -16) score += 4;
    else if (temp500 <= -14) score += 2;
    else if (temp500 > -10) score -= 4; // Zu warm = weniger Hagelwachstum

    // Freezing Level – kritisch für Hagel (ESTOFEX/ESSL)
    // Für ≥1cm kann das FL etwas höher liegen als bei extrem großem Hagel
    if (freezingLevel <= 2200) score += 13; // Sehr günstig
    else if (freezingLevel <= 2700) score += 9;
    else if (freezingLevel <= 3200) score += 5;
    else if (freezingLevel <= 3600) score += 2;
    else if (freezingLevel > 3800) score -= 7; // Sehr hoch = Hagel schmilzt stark

    // LCL-Höhe – niedriges LCL begünstigt Hagel (ESTOFEX)
    // Niedriges LCL = feuchte Umgebung = bessere Hagelproduktion
    if (lclHeight < 600) score += 7;
    else if (lclHeight < 1000) score += 5;
    else if (lclHeight < 1500) score += 3;
    else if (lclHeight >= 2500) score -= 5; // Zu hohes LCL = trocken

    // Mid-Level Lapse Rate (700-500 hPa) – steile Lapse Rate = starke Aufwinde
    // Wichtig für Hagelwachstum in der mittleren Troposphäre
    if (midLapse >= 8.5) score += 7;
    else if (midLapse >= 8.0) score += 5;
    else if (midLapse >= 7.5) score += 4;
    else if (midLapse >= 7.0) score += 2;
    else if (midLapse < 6.0) score -= 3; // Zu flach = schwache Aufwinde

    // DCAPE – Downburst-Komponente (sekundär für Hagel, aber relevant)
    // Hoher DCAPE kann Hagel nach unten transportieren
    if (dcape >= 1000 && cape >= 700) score += 5;
    else if (dcape >= 800 && cape >= 550) score += 3;
    else if (dcape >= 600 && cape >= 400) score += 1;

    // Relative Feuchte 500hPa – trockene mittlere Troposphäre begünstigt Hagel
    // Trockene Luft = stärkere Verdunstungskälte = bessere Hagelproduktion
    if (hour.rh500 < 30 && cape >= 700) score += 6;
    else if (hour.rh500 < 40 && cape >= 550) score += 4;
    else if (hour.rh500 < 50 && cape >= 450) score += 2;
    else if (hour.rh500 > 80 && cape < 900) score -= 5; // Zu feucht = weniger Hagel

    // Kombinierte Faktoren-Multiplikator (ESTOFEX-Methodik)
    // Alle kritischen Faktoren müssen zusammenkommen für Hagel ≥1cm
    let factor = 1.0;
    
    // CAPE + Shear Kombination (Púčik 2015)
    if (cape >= 900 && shear >= 17) factor = 1.15;
    else if (cape >= 700 && shear >= 14) factor = 1.1;
    else if (cape < 500 || shear < 10) factor = 0.7; // Beide niedrig = stark reduzieren

    // Freezing Level + 500hPa Temp Kombination
    if (freezingLevel <= 2700 && temp500 <= -18) factor *= 1.1;
    else if (freezingLevel > 3600 || temp500 > -12) factor *= 0.8;

    score = Math.round(score * factor);

    // Finale Plausibilitätsprüfung (ESTOFEX/ESSL)
    // Mindestanforderungen für Hagel ≥1cm in Europa
    // Púčik 2015: Schwerer Hagel meist bei CAPE ≥ 600, Shear ≥ 15, WMAXSHEAR ≥ 800
    // Für ≥1cm-Hagel etwas abgeschwächt, aber weiter mit Obergrenze
    if (cape < 400 || shear < 12 || wmaxshear < 600) {
        score = Math.min(score, 40); // Hart begrenzen wenn Mindestanforderungen nicht erfüllt
    }

    // ESTOFEX Level 3-ähnliche Bedingungen (sehr schwerer Hagel)
    if (cape >= 1500 && shear >= 20 && wmaxshear >= 1200 && freezingLevel <= 2500 && temp500 <= -18) {
        score = Math.min(100, score + 10); // Bonus für extreme Bedingungen
    }

    return Math.min(100, Math.max(0, score));
}

// Schwere/markante Winde (ab ~20–25 m/s / ≥70–90 km/h) Wahrscheinlichkeit (Europa) – ESTOFEX/ESSL-Methodik
// Quelle: Gatzen et al. 2020 (Derechos Deutschland), Taszarek et al. 2019/2020, ESTOFEX Forecast Guidelines
// Schwere Winde benötigen: erhöhten DCAPE, organisierte Konvektion (MCS/Derecho), erhöhten WMAXSHEAR
function calculateWindProbability(hour, wmaxshear, dcape) {
    const cape = Math.max(0, hour.cape ?? 0);
    const shear = calcShear(hour);
    const wind10m = hour.wind ?? 0;   // km/h
    const gust = hour.gust ?? 0;      // km/h
    const gustDiff = gust - wind10m;
    const temp700 = hour.temp700 ?? 0;
    const dew700 = hour.dew700 ?? 0;
    const temp500 = hour.temp500 ?? 0;

    // Basis-Filter für markante bis schwere Winde (ab ca. 70–90 km/h / 20–25 m/s)
    // Gatzen 2020: Schwere Winde in Europa meist bei DCAPE ≥ 400 J/kg, WMAXSHEAR ≥ 600
    // Taszarek 2020: Organisierte Systeme (MCS/Derecho) benötigen hohen Shear
    if (dcape < 250 && wmaxshear < 450) return 0; // Zu wenig DCAPE/WMAXSHEAR
    if (shear < 9 && cape < 450) return 0; // Zu wenig organisierte Konvektion
    if (gust < 65) return 0; // Prognostizierte Böen zu niedrig für markante/schwere Winde

    let score = 0;

    // DCAPE – kritisch für schwere Downbursts (Gilmore & Wicker 1998, ESTOFEX)
    // Gatzen 2020: Derechos Deutschland median DCAPE ~800-1000 J/kg
    // Für "severe wind" etwas breiter gefasst
    if (dcape >= 1400) score += 34;
    else if (dcape >= 1200) score += 29;
    else if (dcape >= 1000) score += 25;
    else if (dcape >= 800) score += 19;
    else if (dcape >= 600) score += 13;
    else if (dcape >= 400) score += 7;
    else if (dcape >= 300) score += 4;

    // WMAXSHEAR – bester Prädiktor für organisierte Systeme (Taszarek 2020)
    // Für "severe wind" leicht gelockerte Schwellen
    if (wmaxshear >= 1550) score += 31;
    else if (wmaxshear >= 1250) score += 27;
    else if (wmaxshear >= 1050) score += 21;
    else if (wmaxshear >= 850) score += 15;
    else if (wmaxshear >= 650) score += 10;
    else if (wmaxshear >= 550) score += 6;
    else if (wmaxshear >= 450) score += 3;

    // Deep-Layer-Shear (0-6km) – MCS/Derecho-Organisation (Gatzen 2020)
    // Schwere Winde oft in linienhaften Systemen mit hohem Shear
    if (shear >= 24) score += 15;
    else if (shear >= 20) score += 12;
    else if (shear >= 17) score += 9;
    else if (shear >= 14) score += 6;
    else if (shear >= 11) score += 3;
    else if (shear >= 9) score += 1;

    // CAPE – Updraft-Stärke für Downbursts (Gatzen 2020)
    // Schwere Winde können auch bei moderatem CAPE auftreten (warm-season vs cold-season Derechos)
    if (cape >= 1500) score += 11;
    else if (cape >= 1200) score += 9;
    else if (cape >= 800) score += 7;
    else if (cape >= 450) score += 4;
    else if (cape >= 250) score += 2;
    // Low-CAPE/high-shear Fälle bleiben möglich (cold-season Derechos)

    // Böenüberschuss gegenüber Mittelwind – konvektive Böen (ESTOFEX)
    // Großer Unterschied = starke konvektive Downbursts
    if (gustDiff >= 40) score += 15;
    else if (gustDiff >= 30) score += 11;
    else if (gustDiff >= 25) score += 9;
    else if (gustDiff >= 20) score += 6;
    else if (gustDiff >= 15) score += 3;
    else if (gustDiff >= 8) score += 1;

    // Absolutes Böenniveau – kritisch für schwere Winde (ESTOFEX)
    // ESTOFEX Level 1: ≥25 m/s (90 km/h), Level 2: ≥30 m/s (108 km/h), Level 3: ≥35 m/s (126 km/h)
    // Für "severe wind" werten wir 70–80 km/h bereits leicht positiv
    if (gust >= 130) score += 20;      // ≥35 m/s (Level 3)
    else if (gust >= 110) score += 16; // ≥30 m/s (Level 2)
    else if (gust >= 90) score += 12;  // ≥25 m/s (Level 1)
    else if (gust >= 80) score += 7;   // knapp unter Level 1
    else if (gust >= 70) score += 3;   // markante Böen
    else if (gust >= 65) score += 1;   // deutliche Böen, aber noch unter klassischer Schwelle

    // 700 hPa Feuchtigkeit – wichtig für Downburst-Stärke (Gatzen 2020)
    // Trockene 700 hPa = stärkere Verdunstungskälte = stärkere Downbursts
    const dewDepression700 = temp700 - dew700;
    if (dewDepression700 >= 20 && dcape >= 600) score += 8; // Sehr trocken
    else if (dewDepression700 >= 15 && dcape >= 500) score += 5;
    else if (dewDepression700 >= 8 && dcape >= 350) score += 3;
    else if (dewDepression700 < 5 && dcape < 800) score -= 4; // Zu feucht = schwächere Downbursts

    // 500 hPa Temperatur – kalte mittlere Troposphäre begünstigt Downbursts
    if (temp500 <= -20 && dcape >= 600) score += 6;
    else if (temp500 <= -16 && dcape >= 500) score += 4;
    else if (temp500 <= -12 && dcape >= 400) score += 2;

    // Relative Feuchte 500hPa – trockene mittlere Troposphäre (ESTOFEX)
    if (hour.rh500 < 35 && dcape >= 600) score += 5;
    else if (hour.rh500 < 45 && dcape >= 500) score += 3;
    else if (hour.rh500 < 55 && dcape >= 400) score += 1;

    // Kombinierte Faktoren-Multiplikator (ESTOFEX-Methodik)
    // Alle kritischen Faktoren müssen zusammenkommen für markante bis schwere Winde
    let factor = 1.0;
    
    // DCAPE + WMAXSHEAR Kombination (Gatzen 2020, Taszarek 2020)
    if (dcape >= 1000 && wmaxshear >= 1100) factor = 1.2; // Sehr hohes Derecho-Potenzial
    else if (dcape >= 800 && wmaxshear >= 900) factor = 1.15;
    else if (dcape >= 550 && wmaxshear >= 650) factor = 1.1;
    else if (dcape < 350 || wmaxshear < 550) factor = 0.75; // Beide niedrig = reduzieren

    // Shear + CAPE Kombination (MCS-Organisation)
    if (shear >= 17 && cape >= 550) factor *= 1.1;
    else if (shear < 11 && cape < 350) factor *= 0.8;

    // Böen + DCAPE Kombination
    if (gust >= 100 && dcape >= 800) factor *= 1.1;
    else if (gust < 75 && dcape < 450) factor *= 0.85;

    score = Math.round(score * factor);

    // Finale Plausibilitätsprüfung (ESTOFEX/ESSL)
    // Mindestanforderungen für markante/schwere Winde (≥70–90 km/h) in Europa
    // Gatzen 2020: Schwere Winde meist bei DCAPE ≥ 500, WMAXSHEAR ≥ 700, Shear ≥ 12
    if (dcape < 350 || wmaxshear < 550 || gust < 70) {
        score = Math.min(score, 35); // Hart begrenzen wenn Mindestanforderungen nicht erfüllt
    }

    // ESTOFEX Level 3-ähnliche Bedingungen (sehr schwere Winde ≥35 m/s)
    if (dcape >= 1200 && wmaxshear >= 1300 && shear >= 20 && gust >= 110) {
        score = Math.min(100, score + 12); // Bonus für extreme Bedingungen
    }

    // Cold-Season Derecho-Potenzial (low-CAPE, high-shear)
    // Gatzen 2020: Cold-season Derechos bei CAPE < 500, aber Shear ≥ 18, WMAXSHEAR ≥ 800
    if (cape < 500 && shear >= 18 && wmaxshear >= 800 && dcape >= 600) {
        score = Math.min(100, score + 8); // Bonus für cold-season Typ
    }

    return Math.min(100, Math.max(0, score));
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
