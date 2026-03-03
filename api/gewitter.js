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
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,temperature_925hPa,` +
                    `relative_humidity_500hPa,cape,convective_inhibition,lifted_index,` +
                    `dew_point_850hPa,dew_point_700hPa,dew_point_925hPa,boundary_layer_height,direct_radiation,` +
                    `wind_speed_925hPa,wind_direction_925hPa,` +
                    `precipitation&forecast_days=16&models=best_match&timezone=auto`;

        const ensembleUrl = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=temperature_2m,dew_point_2m,wind_gusts_10m,wind_speed_10m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_speed_1000hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,temperature_925hPa,` +
                    `relative_humidity_500hPa,cape,convective_inhibition,lifted_index,` +
                    `dew_point_850hPa,dew_point_700hPa,dew_point_925hPa,boundary_layer_height,direct_radiation,` +
                    `wind_speed_925hPa,wind_direction_925hPa,` +
                    `precipitation&forecast_days=16&models=best_match&timezone=auto`;

        const [response, ensembleResponse] = await Promise.all([
            fetch(url),
            fetch(ensembleUrl).catch(err => {
                console.warn('Ensemble-API-Fehler:', err);
                return { ok: false, json: () => Promise.resolve({ error: true }) };
            })
        ]);

        const data = await response.json();
        let ensembleData = null;
        if (ensembleResponse.ok) {
            ensembleData = await ensembleResponse.json();
        }

        if (data.error) {
            return res.status(500).json({ error: 'API-Fehler: ' + (data.reason || data.error.message || 'Unbekannt') });
        }

        if (!data?.hourly?.time?.length) {
            return res.status(500).json({ error: 'Keine Daten verfügbar' });
        }

        const timezone = data.timezone || 'UTC';
        const hasEnsemble = ensembleData && !ensembleData.error && ensembleData?.hourly?.time?.length;

        // Region basierend auf Koordinaten bestimmen
        const region = getRegion(latitude, longitude);

        // Stunden-Daten verarbeiten
        const hours = data.hourly.time.map((t, i) => {
            const baseData = {
                time: t,
                temperature: data.hourly.temperature_2m?.[i] ?? 0,
                dew: data.hourly.dew_point_2m?.[i] ?? 0,
                cloudLow: data.hourly.cloud_cover_low?.[i] ?? 0,
                cloudMid: data.hourly.cloud_cover_mid?.[i] ?? 0,
                cloudHigh: data.hourly.cloud_cover_high?.[i] ?? 0,
                precip: data.hourly.precipitation_probability?.[i] ?? 0,
                wind: data.hourly.wind_speed_10m?.[i] ?? 0,
                gust: data.hourly.wind_gusts_10m?.[i] ?? 0,
                windDir1000: data.hourly.wind_direction_1000hPa?.[i] ?? 0,
                windDir850: data.hourly.wind_direction_850hPa?.[i] ?? 0,
                windDir700: data.hourly.wind_direction_700hPa?.[i] ?? 0,
                windDir500: data.hourly.wind_direction_500hPa?.[i] ?? 0,
                windDir300: data.hourly.wind_direction_300hPa?.[i] ?? 0,
                wind_speed_1000hPa: data.hourly.wind_speed_1000hPa?.[i] ?? 0,
                wind_speed_850hPa: data.hourly.wind_speed_850hPa?.[i] ?? 0,
                wind_speed_700hPa: data.hourly.wind_speed_700hPa?.[i] ?? 0,
                wind_speed_500hPa: data.hourly.wind_speed_500hPa?.[i] ?? 0,
                wind_speed_300hPa: data.hourly.wind_speed_300hPa?.[i] ?? 0,
                temp500: data.hourly.temperature_500hPa?.[i] ?? 0,
                temp850: data.hourly.temperature_850hPa?.[i] ?? 0,
                temp700: data.hourly.temperature_700hPa?.[i] ?? 0,
                dew850: data.hourly.dew_point_850hPa?.[i] ?? 0,
                dew700: data.hourly.dew_point_700hPa?.[i] ?? 0,
                rh500: data.hourly.relative_humidity_500hPa?.[i] ?? 0,
                cape: data.hourly.cape?.[i] ?? 0,
                cin: data.hourly.convective_inhibition?.[i] ?? 0,
                liftedIndex: data.hourly.lifted_index?.[i] ?? 0,
                pblHeight: data.hourly.boundary_layer_height?.[i] ?? 0,
                directRadiation: data.hourly.direct_radiation?.[i] ?? 0,
                precipAcc: data.hourly.precipitation?.[i] ?? 0,
                temp925: data.hourly.temperature_925hPa?.[i] ?? null,
                dew925: data.hourly.dew_point_925hPa?.[i] ?? null,
                wind_speed_925hPa: data.hourly.wind_speed_925hPa?.[i] ?? 0,
                windDir925: data.hourly.wind_direction_925hPa?.[i] ?? 0,
            };

            // Ensemble-Daten kompakt hinzufügen
            if (hasEnsemble && ensembleData.hourly.time[i] === t) {
                const getEnsemble = (param, type = 'mean') => {
                    const paramData = ensembleData.hourly[param];
                    if (!paramData || typeof paramData !== 'object' || Array.isArray(paramData)) return null;
                    return paramData[type]?.[i] ?? null;
                };

                const ensembleParams = [
                    'temperature_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_gusts_10m',
                    'precipitation_probability', 'precipitation', 'direct_radiation', 'boundary_layer_height',
                    'temperature_500hPa', 'temperature_700hPa', 'temperature_850hPa', 'temperature_925hPa',
                    'wind_speed_300hPa', 'wind_speed_500hPa', 'wind_speed_700hPa', 'wind_speed_850hPa', 'wind_speed_1000hPa', 'wind_speed_925hPa',
                    'dew_point_850hPa', 'dew_point_700hPa', 'dew_point_925hPa',
                    'relative_humidity_500hPa', 'cape', 'convective_inhibition', 'lifted_index'
                ];

                baseData.ensemble = {};
                ensembleParams.forEach(param => {
                    const baseKey = param.replace('_2m', '').replace('_10m', '');
                    baseData.ensemble[`${param}_mean`] = getEnsemble(param, 'mean') ?? baseData[baseKey] ?? null;
                    baseData.ensemble[`${param}_min`] = getEnsemble(param, 'min');
                    baseData.ensemble[`${param}_max`] = getEnsemble(param, 'max');
                });
            }

            return baseData;
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
                return {
                    timestamp: hour.time,
                    probability: calculateProbability(hour, region),
                    tornadoProbability: calculateTornadoProbability(hour, shear, srh, region),
                    temperature: hour.temperature,
                    cape: hour.cape,
                    mucape: calcMUCAPE(hour),
                    shear: shear,
                    srh: srh,
                    dcape: calcDCAPE(hour),
                    wmaxshear: calcWMAXSHEAR(hour.cape, shear),
                };
            });

        // Tage gruppieren
        const daysMap = new Map();
        hours.forEach(h => {
            const [datePart] = h.time.split('T');
            if (datePart >= currentDateStr) {
                const probability = calculateProbability(h, region);
                const shear = calcShear(h);
                const srh = calcSRH(h);
                const tornadoProb = calculateTornadoProbability(h, shear, srh, region);
                if (!daysMap.has(datePart)) {
                    daysMap.set(datePart, { 
                        date: datePart, 
                        maxProbability: probability,
                        maxTornadoProbability: tornadoProb
                    });
                } else {
                    const dayData = daysMap.get(datePart);
                    dayData.maxProbability = Math.max(dayData.maxProbability, probability);
                    dayData.maxTornadoProbability = Math.max(dayData.maxTornadoProbability, tornadoProb);
                }
            }
        });

        const nextDays = Array.from(daysMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(day => ({ 
                date: day.date, 
                probability: day.maxProbability,
                tornadoProbability: day.maxTornadoProbability
            }));

        return res.status(200).json({
            timezone: timezone,
            region: region,
            hours: nextHours,
            days: nextDays,
            hasEnsemble: hasEnsemble
        });

    } catch (error) {
        console.error('Fehler:', error);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}

// Hilfsfunktionen
function getRegion(lat, lon) {
    // Europa: ca. 35°N - 70°N, -10°W - 40°E
    if (lat >= 35 && lat <= 70 && lon >= -10 && lon <= 40) {
        return 'europe';
    }
    // USA: ca. 25°N - 50°N, -125°W - -65°W
    if (lat >= 25 && lat <= 50 && lon >= -125 && lon <= -65) {
        return 'usa';
    }
    // Kanada: ca. 42°N - 70°N, -140°W - -50°W
    if (lat >= 42 && lat <= 70 && lon >= -140 && lon <= -50) {
        return 'canada';
    }
    // Mittelamerika/Karibik: ca. 10°N - 25°N, -120°W - -60°W
    if (lat >= 10 && lat <= 25 && lon >= -120 && lon <= -60) {
        return 'central_america';
    }
    // Südamerika - Brasilien/Argentinien: ca. 5°N - 35°S, -80°W - -30°W
    if (lat >= -35 && lat <= 5 && lon >= -80 && lon <= -30) {
        return 'south_america';
    }
    // Südamerika - Anden: ca. 5°N - 20°S, -80°W - -65°W
    if (lat >= -20 && lat <= 5 && lon >= -80 && lon <= -65) {
        return 'south_america';
    }
    // Afrika - Südafrika: ca. 22°S - 35°S, 15°E - 35°E
    if (lat >= -35 && lat <= -22 && lon >= 15 && lon <= 35) {
        return 'south_africa';
    }
    // Afrika - Ostafrika (Kenia, Tansania, Äthiopien, Somalia, Uganda): ca. 5°S - 12°N, 30°E - 52°E
    if (lat >= -5 && lat <= 12 && lon >= 30 && lon <= 52) {
        return 'east_africa';
    }
    // Afrika - Zentralafrika (Kongo, Kamerun, etc.): ca. 5°S - 10°N, 10°W - 30°E
    if (lat >= -5 && lat <= 10 && lon >= -10 && lon <= 30) {
        return 'central_africa';
    }
    // Afrika - Westafrika (Nigeria, Ghana, Senegal, etc.): ca. 5°N - 15°N, -20°W - 15°E
    if (lat >= 5 && lat <= 15 && lon >= -20 && lon <= 15) {
        return 'west_africa';
    }
    // Afrika - Nordafrika (Sahara, Maghreb): ca. 15°N - 35°N, -20°W - 40°E
    if (lat >= 15 && lat <= 35 && lon >= -20 && lon <= 40) {
        return 'north_africa';
    }
    // Madagaskar und umliegende Inseln: ca. 12°S - 25°S, 43°E - 51°E
    if (lat >= -25 && lat <= -12 && lon >= 43 && lon <= 51) {
        return 'south_africa'; // Ähnliche Bedingungen wie Südafrika
    }
    // Asien - Südasien (Indien, Pakistan, Bangladesch): ca. 5°N - 35°N, 60°E - 100°E
    if (lat >= 5 && lat <= 35 && lon >= 60 && lon <= 100) {
        return 'south_asia';
    }
    // Asien - Ostasien (China, Japan, Korea): ca. 20°N - 50°N, 100°E - 145°E
    if (lat >= 20 && lat <= 50 && lon >= 100 && lon <= 145) {
        return 'east_asia';
    }
    // Asien - Südostasien: ca. 5°S - 25°N, 90°E - 145°E
    if (lat >= -5 && lat <= 25 && lon >= 90 && lon <= 145) {
        return 'southeast_asia';
    }
    // Australien: ca. 10°S - 45°S, 110°E - 155°E
    if (lat >= -45 && lat <= -10 && lon >= 110 && lon <= 155) {
        return 'australia';
    }
    // Neuseeland: ca. 34°S - 47°S, 165°E - 180°E und -180°W - -175°W
    if (lat >= -47 && lat <= -34 && ((lon >= 165 && lon <= 180) || (lon >= -180 && lon <= -175))) {
        return 'new_zealand';
    }
    // Russland/Zentralasien: ca. 40°N - 70°N, 40°E - 180°E
    if (lat >= 40 && lat <= 70 && lon >= 40 && lon <= 180) {
        return 'russia_central_asia';
    }
    // Naher Osten: ca. 12°N - 40°N, 25°E - 60°E
    if (lat >= 12 && lat <= 40 && lon >= 25 && lon <= 60) {
        return 'middle_east';
    }
    // Standard: Europa (für unbekannte Regionen)
    return 'europe';
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

// Regionsspezifische Parameter für SCP/STP
function getRegionParams(region) {
    const params = {
        'usa': { minCAPE: 100, minShear: 8, minSRH: 50, normCAPE: 1000, normShear: 12, normSRH: 50 },
        'canada': { minCAPE: 100, minShear: 7, minSRH: 45, normCAPE: 900, normShear: 11, normSRH: 45 },
        'central_america': { minCAPE: 150, minShear: 6, minSRH: 40, normCAPE: 1200, normShear: 10, normSRH: 50 },
        'south_america': { minCAPE: 150, minShear: 8, minSRH: 50, normCAPE: 1200, normShear: 12, normSRH: 50 },
        'south_africa': { minCAPE: 200, minShear: 10, minSRH: 60, normCAPE: 1500, normShear: 14, normSRH: 60 },
        'east_africa': { minCAPE: 200, minShear: 6, minSRH: 40, normCAPE: 1400, normShear: 9, normSRH: 50 },
        'central_africa': { minCAPE: 200, minShear: 5, minSRH: 30, normCAPE: 1500, normShear: 8, normSRH: 40 },
        'west_africa': { minCAPE: 200, minShear: 5, minSRH: 35, normCAPE: 1500, normShear: 8, normSRH: 45 },
        'north_africa': { minCAPE: 150, minShear: 6, minSRH: 40, normCAPE: 1000, normShear: 10, normSRH: 40 },
        'south_asia': { minCAPE: 200, minShear: 6, minSRH: 40, normCAPE: 1500, normShear: 10, normSRH: 50 },
        'east_asia': { minCAPE: 150, minShear: 8, minSRH: 50, normCAPE: 1200, normShear: 12, normSRH: 50 },
        'southeast_asia': { minCAPE: 200, minShear: 5, minSRH: 35, normCAPE: 1500, normShear: 8, normSRH: 45 },
        'australia': { minCAPE: 150, minShear: 8, minSRH: 50, normCAPE: 1200, normShear: 12, normSRH: 50 },
        'new_zealand': { minCAPE: 100, minShear: 6, minSRH: 40, normCAPE: 800, normShear: 10, normSRH: 40 },
        'russia_central_asia': { minCAPE: 100, minShear: 6, minSRH: 40, normCAPE: 800, normShear: 10, normSRH: 40 },
        'middle_east': { minCAPE: 150, minShear: 6, minSRH: 40, normCAPE: 1000, normShear: 10, normSRH: 40 },
        'europe': { minCAPE: 100, minShear: 6, minSRH: 40, normCAPE: 800, normShear: 10, normSRH: 40 }
    };
    return params[region] || params['europe'];
}

// SCP nach Thompson et al. (2004): (MUCAPE/1000) * (ESRH/50) * (EBWD/12)
// Normalisierung nach SPC-Standard, regionaler CIN-Korrekturfaktor bleibt
function calcSCP(cape, shear, srh, cin, region = 'europe') {
    const p = getRegionParams(region);
    if (cape < p.minCAPE || shear < p.minShear || srh < p.minSRH) return 0;
    if (shear < 12.5) return 0; // konsistent mit STP-Cutoff

    // SPC-Standard: CAPE/1000, SRH/50, BWD/12
    const capeTerm  = cape / 1000;
    const srhTerm   = Math.min(srh / 50, 4.0);
    const shearTerm = Math.min(shear / 12, 1.5);
    const cinTerm   = cin < 40 ? 1.0 : Math.max(0.1, 1 - (cin - 40) / 200);

    // Regionaler Skalierungsfaktor (Taszarek 2020: Europa braucht niedrigere Schwellen)
    const regionScale = {
        'usa': 1.0, 'canada': 0.95, 'south_america': 0.95, 'south_africa': 0.9,
        'australia': 0.95, 'europe': 0.85, 'east_asia': 0.85,
        'south_asia': 0.8, 'southeast_asia': 0.75, 'middle_east': 0.8,
        'central_america': 0.8, 'east_africa': 0.7, 'central_africa': 0.65,
        'west_africa': 0.65, 'north_africa': 0.75, 'new_zealand': 0.85,
        'russia_central_asia': 0.85
    }[region] ?? 0.85;

    return Math.max(0, capeTerm * srhTerm * shearTerm * cinTerm * regionScale);
}

// ThetaE nach Bolton (1980)
function calcThetaE(temp, dew, pressure = 1000) {
    const Lv = 2500;
    const cp = 1004;
    const T_K = temp + 273.15;
    const e = 6.112 * Math.exp((17.67 * dew) / (dew + 243.5));
    const w = 0.622 * (e / (pressure - e));
    return T_K * Math.exp((Lv * w) / (cp * T_K));
}

// MUCAPE-Approximation: Teste Parcels von Boden, 925, 850 hPa
// Nimm den instabilsten → Most Unstable CAPE
function calcMUCAPE(hour) {
    const sbCAPE = hour.cape ?? 0;
    const temp500 = hour.temp500 ?? -20;

    // Umgebungs-ThetaE auf 500 hPa (als Referenz für Auftrieb)
    const thetaE500 = calcThetaE(temp500, temp500 - 25, 500);

    // Surface Parcel
    const thetaE_sfc = calcThetaE(hour.temperature ?? 0, hour.dew ?? 0, 1000);
    const buoyancy_sfc = thetaE_sfc - thetaE500;
    const elevatedCAPE_sfc = buoyancy_sfc > 0
        ? Math.max(0, buoyancy_sfc * 9.81 * 2500 / (temp500 + 273.15))
        : 0;

    // 925 hPa Parcel (falls verfügbar)
    let elevatedCAPE_925 = 0;
    if (hour.temp925 !== null && hour.dew925 !== null) {
        const dewDepression925 = (hour.temp925 ?? 0) - (hour.dew925 ?? 0);
        if (dewDepression925 < 10) { // nur wenn feucht genug
            const thetaE925 = calcThetaE(hour.temp925, hour.dew925, 925);
            const buoyancy925 = thetaE925 - thetaE500;
            elevatedCAPE_925 = buoyancy925 > 0
                ? Math.max(0, buoyancy925 * 9.81 * 3000 / (temp500 + 273.15))
                : 0;
        }
    }

    // 850 hPa Parcel
    const temp850 = hour.temp850 ?? 0;
    const dew850 = hour.dew850 ?? 0;
    const dewDepression850 = temp850 - dew850;
    let elevatedCAPE_850 = 0;
    if (dewDepression850 < 8) { // nur wenn feuchte 850hPa-Schicht
        const thetaE850 = calcThetaE(temp850, dew850, 850);
        const buoyancy850 = thetaE850 - thetaE500;
        elevatedCAPE_850 = buoyancy850 > 0
            ? Math.max(0, buoyancy850 * 9.81 * 3500 / (temp500 + 273.15))
            : 0;
    }

    const mucape = Math.max(sbCAPE, elevatedCAPE_sfc, elevatedCAPE_925, elevatedCAPE_850);

    // isElevated: wenn elevated Parcel deutlich mehr CAPE hat als Boden
    // und Boden-CAPE niedrig (typisch bei starker nächtlicher Abkühlung/Cap)
    const maxElevated = Math.max(elevatedCAPE_925, elevatedCAPE_850);
    const isElevated = maxElevated > sbCAPE * 1.5 && sbCAPE < 300 && maxElevated > 150;

    // LLJ-Check: 925 hPa Wind > 15 m/s = Low-Level-Jet aktiv
    const ws925_ms = (hour.wind_speed_925hPa ?? 0) / 3.6;
    const hasLLJ = ws925_ms >= 15;

    return { mucape: Math.round(mucape), isElevated, hasLLJ };
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

// STP (Significant Tornado Parameter) - nach Thompson et al. (2012) / SPC fixed-layer
// Quelle: https://www.spc.noaa.gov/exper/mesoanalysis/help/help_stor.html
// Formel: STP = (sbCAPE/1500) * ((2000-LCL)/1000) * (SRH1/150) * (6BWD/20) * ((200+CIN)/150)
function calcSTP(cape, srh, shear, liftedIndex, cin, region = 'europe', temp2m = null, dew2m = null) {
    const stpThresholds = {
        'usa':                { minCAPE: 300, minSRH: 80, minShear: 10, normCAPE: 1500, normSRH: 150, normShear: 20 },
        'canada':             { minCAPE: 200, minSRH: 70, minShear: 9,  normCAPE: 1200, normSRH: 130, normShear: 18 },
        'central_america':    { minCAPE: 200, minSRH: 50, minShear: 8,  normCAPE: 1200, normSRH: 100, normShear: 16 },
        'south_america':      { minCAPE: 250, minSRH: 70, minShear: 10, normCAPE: 1400, normSRH: 130, normShear: 18 },
        'south_africa':       { minCAPE: 300, minSRH: 90, minShear: 12, normCAPE: 1600, normSRH: 160, normShear: 20 },
        'east_africa':        { minCAPE: 200, minSRH: 50, minShear: 7,  normCAPE: 1300, normSRH: 100, normShear: 15 },
        'central_africa':     { minCAPE: 200, minSRH: 40, minShear: 6,  normCAPE: 1200, normSRH:  80, normShear: 14 },
        'west_africa':        { minCAPE: 200, minSRH: 45, minShear: 6,  normCAPE: 1300, normSRH:  90, normShear: 14 },
        'north_africa':       { minCAPE: 200, minSRH: 50, minShear: 8,  normCAPE: 1200, normSRH: 100, normShear: 16 },
        'south_asia':         { minCAPE: 250, minSRH: 60, minShear: 8,  normCAPE: 1400, normSRH: 120, normShear: 16 },
        'east_asia':          { minCAPE: 200, minSRH: 70, minShear: 10, normCAPE: 1300, normSRH: 130, normShear: 18 },
        'southeast_asia':     { minCAPE: 200, minSRH: 50, minShear: 6,  normCAPE: 1300, normSRH: 100, normShear: 14 },
        'australia':          { minCAPE: 250, minSRH: 80, minShear: 10, normCAPE: 1400, normSRH: 140, normShear: 20 },
        'new_zealand':        { minCAPE: 150, minSRH: 50, minShear: 7,  normCAPE: 1000, normSRH: 100, normShear: 16 },
        'russia_central_asia':{ minCAPE: 150, minSRH: 50, minShear: 7,  normCAPE: 1000, normSRH: 100, normShear: 16 },
        'middle_east':        { minCAPE: 200, minSRH: 50, minShear: 8,  normCAPE: 1200, normSRH: 100, normShear: 16 },
        'europe':             { minCAPE: 100, minSRH: 40, minShear: 6,  normCAPE: 1000, normSRH: 100, normShear: 18 }
    };

    const t = stpThresholds[region] || stpThresholds['europe'];

    if (cape < t.minCAPE || srh < t.minSRH || shear < t.minShear) return 0;

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

    const capeTerm  = Math.min(cape / t.normCAPE, 3.0);
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

// Ensemble-Wahrscheinlichkeit (vereinfacht)
function getEnsembleProb(ensemble, param, threshold, direction = 'above') {
    if (!ensemble) return null;
    const mean = ensemble[`${param}_mean`];
    const min = ensemble[`${param}_min`];
    const max = ensemble[`${param}_max`];
    
    if (mean === null || mean === undefined) return null;
    
    if (direction === 'above') {
        if (min !== null && min > threshold) return 1.0;
        if (max !== null && max < threshold) return 0.0;
    } else {
        if (max !== null && max < threshold) return 1.0;
        if (min !== null && min > threshold) return 0.0;
    }
    
    // Vereinfachte Wahrscheinlichkeit basierend auf mean und range
    if (min !== null && max !== null) {
        const range = max - min;
        const distance = direction === 'above' ? (mean - threshold) : (threshold - mean);
        return Math.max(0, Math.min(1, 0.5 + (distance / Math.max(range, 1))));
    }
    
    return mean > threshold ? 0.7 : 0.3;
}

// Regionsspezifische Parameter für Wahrscheinlichkeitsberechnung
function getProbabilityParams(region) {
    const params = {
        'usa': {
            minTemp: 10, minTempWithCAPE: 15, minCAPE: 500, minCAPEWithPrecip: 200,
            capeThresholds: [2500, 2000, 1500, 1000, 800, 600, 500],
            capeScores: [30, 25, 20, 14, 10, 6, 3],
            minTempReduction: 15, tempReductionFactor: 0.5,
            minTempReduction2: 18, tempReductionFactor2: 0.7
        },
        'canada': {
            minTemp: 8, minTempWithCAPE: 12, minCAPE: 400, minCAPEWithPrecip: 150,
            capeThresholds: [2000, 1500, 1200, 800, 600, 500, 400],
            capeScores: [25, 20, 16, 12, 8, 5, 3],
            minTempReduction: 12, tempReductionFactor: 0.5,
            minTempReduction2: 15, tempReductionFactor2: 0.7
        },
        'central_america': {
            minTemp: 15, minTempWithCAPE: 20, minCAPE: 300, minCAPEWithPrecip: 150,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [28, 22, 18, 14, 10, 6, 3],
            minTempReduction: 18, tempReductionFactor: 0.6,
            minTempReduction2: 22, tempReductionFactor2: 0.8
        },
        'south_america': {
            minTemp: 12, minTempWithCAPE: 18, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600],
            capeScores: [30, 25, 20, 16, 12, 8, 5],
            minTempReduction: 15, tempReductionFactor: 0.5,
            minTempReduction2: 20, tempReductionFactor2: 0.7
        },
        'south_africa': {
            minTemp: 12, minTempWithCAPE: 18, minCAPE: 500, minCAPEWithPrecip: 250,
            capeThresholds: [2500, 2000, 1800, 1500, 1200, 1000, 800],
            capeScores: [32, 27, 23, 20, 15, 10, 6],
            minTempReduction: 15, tempReductionFactor: 0.5,
            minTempReduction2: 20, tempReductionFactor2: 0.7
        },
        'east_africa': {
            minTemp: 18, minTempWithCAPE: 23, minCAPE: 300, minCAPEWithPrecip: 150,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [28, 22, 18, 14, 10, 6, 3],
            minTempReduction: 20, tempReductionFactor: 0.6,
            minTempReduction2: 24, tempReductionFactor2: 0.8
        },
        'central_africa': {
            minTemp: 20, minTempWithCAPE: 25, minCAPE: 300, minCAPEWithPrecip: 150,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [28, 22, 18, 14, 10, 6, 3],
            minTempReduction: 22, tempReductionFactor: 0.6,
            minTempReduction2: 25, tempReductionFactor2: 0.8
        },
        'west_africa': {
            minTemp: 22, minTempWithCAPE: 27, minCAPE: 300, minCAPEWithPrecip: 150,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [28, 22, 18, 14, 10, 6, 3],
            minTempReduction: 24, tempReductionFactor: 0.6,
            minTempReduction2: 28, tempReductionFactor2: 0.8
        },
        'north_africa': {
            minTemp: 15, minTempWithCAPE: 20, minCAPE: 300, minCAPEWithPrecip: 150,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [28, 22, 18, 14, 10, 6, 3],
            minTempReduction: 18, tempReductionFactor: 0.5,
            minTempReduction2: 22, tempReductionFactor2: 0.7
        },
        'south_asia': {
            minTemp: 20, minTempWithCAPE: 25, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2500, 2000, 1800, 1500, 1200, 1000, 800],
            capeScores: [30, 25, 22, 18, 14, 10, 6],
            minTempReduction: 22, tempReductionFactor: 0.5,
            minTempReduction2: 27, tempReductionFactor2: 0.7
        },
        'east_asia': {
            minTemp: 10, minTempWithCAPE: 15, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 500],
            capeScores: [28, 22, 18, 14, 10, 6, 4],
            minTempReduction: 12, tempReductionFactor: 0.5,
            minTempReduction2: 18, tempReductionFactor2: 0.7
        },
        'southeast_asia': {
            minTemp: 22, minTempWithCAPE: 27, minCAPE: 300, minCAPEWithPrecip: 150,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [28, 22, 18, 14, 10, 6, 3],
            minTempReduction: 24, tempReductionFactor: 0.6,
            minTempReduction2: 28, tempReductionFactor2: 0.8
        },
        'australia': {
            minTemp: 12, minTempWithCAPE: 18, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 500],
            capeScores: [28, 22, 18, 14, 10, 6, 4],
            minTempReduction: 15, tempReductionFactor: 0.5,
            minTempReduction2: 20, tempReductionFactor2: 0.7
        },
        'new_zealand': {
            minTemp: 8, minTempWithCAPE: 12, minCAPE: 300, minCAPEWithPrecip: 150,
            capeThresholds: [1500, 1200, 1000, 800, 600, 500, 400],
            capeScores: [25, 20, 16, 12, 8, 5, 3],
            minTempReduction: 10, tempReductionFactor: 0.5,
            minTempReduction2: 14, tempReductionFactor2: 0.7
        },
        'russia_central_asia': {
            minTemp: 5, minTempWithCAPE: 10, minCAPE: 300, minCAPEWithPrecip: 150,
            capeThresholds: [1500, 1200, 1000, 800, 600, 500, 400],
            capeScores: [25, 20, 16, 12, 8, 5, 3],
            minTempReduction: 8, tempReductionFactor: 0.5,
            minTempReduction2: 12, tempReductionFactor2: 0.7
        },
        'middle_east': {
            minTemp: 12, minTempWithCAPE: 18, minCAPE: 300, minCAPEWithPrecip: 150,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [28, 22, 18, 14, 10, 6, 3],
            minTempReduction: 15, tempReductionFactor: 0.5,
            minTempReduction2: 20, tempReductionFactor2: 0.7
        },
        'europe': {
            minTemp: 5, minTempWithCAPE: 10, minCAPE: 200, minCAPEWithPrecip: 100,
            capeThresholds: [1500, 1200, 800, 500, 400, 300, 200],
            capeScores: [25, 20, 14, 8, 6, 4, 2],
            minTempReduction: 12, tempReductionFactor: 0.5,
            minTempReduction2: 15, tempReductionFactor2: 0.7
        }
    };
    return params[region] || params['europe'];
}

// Hauptfunktion für Wahrscheinlichkeitsberechnung (optimiert und kompakt)
function calculateProbability(hour, region = 'europe') {
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0;
    const sbCAPE = Math.max(0, hour.cape ?? 0);
    const { mucape, isElevated, hasLLJ } = calcMUCAPE(hour);
    const cape = mucape; // MUCAPE statt surface-based CAPE
    const cin = isElevated ? 0 : Math.abs(hour.cin ?? 0); // kein CIN-Penalty bei elevated
    const precipAcc = hour.precipAcc ?? 0;
    const precipProb = hour.precip ?? 0;
    
    // Regionsspezifische Filter für Fehlalarme
    const p = getProbabilityParams(region);
    if (temp2m < p.minTemp) return 0; // Zu kalt für Gewitter
    if (temp2m < p.minTempWithCAPE && cape < (p.minCAPE * 1.5)) return 0; // Kalt und keine hohe Instabilität
    if (cape < p.minCAPEWithPrecip && precipAcc < 0.2 && precipProb < 20) return 0; // Keine Instabilität und kein Niederschlag
    
    // Berechne Indizes
    const shear = calcShear(hour);
    const srh1km = calcSRH(hour, '0-1km');
    const srh = calcSRH(hour, '0-3km');
    const { kIndex, showalter, lapse, liftedIndex } = calcIndices(hour);
    const relHum2m = calcRelHum(temp2m, dew);
    const cloudSum = (hour.cloudLow ?? 0) + (hour.cloudMid ?? 0) + (hour.cloudHigh ?? 0);
    
    // Kombinierte Indizes (bewährte meteorologische Parameter)
    const ehi = (cape * srh) / 160000;
    const scp = calcSCP(cape, shear, srh, cin, region);
    const stp = calcSTP(sbCAPE, srh1km, shear, liftedIndex, cin, region, temp2m, dew);
    const wmaxshear = calcWMAXSHEAR(cape, shear);
    
    // Basis-Score basierend auf kombinierten Indizes (regionsspezifisch)
    let score = 0;
    
    // CAPE-Bewertung (regionsspezifisch)
    for (let i = 0; i < p.capeThresholds.length; i++) {
        if (cape >= p.capeThresholds[i]) {
            score += p.capeScores[i];
            break;
        }
    }
    
    // CIN-Penalty (stärker gewichtet)
    if (cin > 200) score -= 15;
    else if (cin > 100) score -= 8;
    else if (cin > 50) score -= 4;
    
    // Kombinierte Indizes (regionsspezifisch)
    // Regionen mit hohen Thresholds: usa, south_africa, south_america, australia
    const highThresholdRegions = ['usa', 'south_africa', 'south_america', 'australia'];
    const isHighThreshold = highThresholdRegions.includes(region);
    
    if (isHighThreshold) {
        if (scp > 3) score += 25;
        else if (scp > 2) score += 20;
        else if (scp > 1.5) score += 14;
        else if (scp > 1) score += 8;
        
        if (stp > 2) score += 18;
        else if (stp > 1.5) score += 14;
        else if (stp > 1) score += 10;
        else if (stp > 0.5) score += 5;
        
        if (ehi > 3) score += 15;
        else if (ehi > 2) score += 12;
        else if (ehi > 1.5) score += 8;
        else if (ehi > 1) score += 4;
    } else {
        // Niedrigere Thresholds für andere Regionen
        if (scp > 2) score += 20;
        else if (scp > 1.5) score += 16;
        else if (scp > 1) score += 10;
        else if (scp > 0.5) score += 5;
        
        if (stp > 1.5) score += 15;
        else if (stp > 1) score += 12;
        else if (stp > 0.5) score += 7;
        else if (stp > 0.3) score += 3;
        
        // EHI-Schwellen nach Hart & Korotky (1991), klimatologisch angepasst
        if (ehi >= 2.0) score += 12;
        else if (ehi >= 1.0) score += 8;
        else if (ehi >= 0.5) score += 4;
        else if (ehi >= 0.3) score += 2;
    }
    
    // WMAXSHEAR-Score (nach SCP/STP/EHI-Block)
    // Taszarek et al. 2020: bester globaler Prädiktor, Schwelle 500 m²/s²
    if (wmaxshear >= 1200) score += 18;
    else if (wmaxshear >= 900) score += 14;
    else if (wmaxshear >= 700) score += 10;
    else if (wmaxshear >= 500) score += 6;
    else if (wmaxshear >= 300) score += 3;
    
    // Shear und SRH (regionsspezifisch)
    const highCAPEThreshold = isHighThreshold ? 800 : 500;
    const lowCAPEThreshold = isHighThreshold ? 500 : 200;
    
    if (cape >= highCAPEThreshold) {
        if (isHighThreshold) {
            if (shear >= 25) score += 12;
            else if (shear >= 20) score += 10;
            else if (shear >= 15) score += 7;
            else if (shear >= 12) score += 4;
            
            if (srh >= 250) score += 10;
            else if (srh >= 200) score += 8;
            else if (srh >= 150) score += 6;
            else if (srh >= 120) score += 4;
        } else {
            if (shear >= 20) score += 10;
            else if (shear >= 15) score += 7;
            else if (shear >= 10) score += 4;
            else if (shear >= 8) score += 2;
            
            if (srh >= 200) score += 8;
            else if (srh >= 150) score += 6;
            else if (srh >= 120) score += 4;
            else if (srh >= 80) score += 2;
        }
    } else if (cape >= lowCAPEThreshold) {
        if (isHighThreshold) {
            if (shear >= 20) score += 5;
            else if (shear >= 15) score += 3;
            
            if (srh >= 200) score += 4;
            else if (srh >= 150) score += 2;
        } else {
            if (shear >= 15) score += 3;
            else if (shear >= 10) score += 1;
            
            if (srh >= 150) score += 2;
            else if (srh >= 100) score += 1;
        }
    }
    
    // Lifted Index (regionsspezifisch)
    if (region === 'usa') {
        if (cape >= 600) {
            if (liftedIndex <= -7) score += 12;
            else if (liftedIndex <= -6) score += 10;
            else if (liftedIndex <= -4) score += 6;
            else if (liftedIndex <= -2) score += 3;
        } else if (cape >= 500) {
            if (liftedIndex <= -5) score += 4;
            else if (liftedIndex <= -3) score += 2;
        }
    } else {
        // Europa: Auch bei niedrigem CAPE
        if (cape >= 400) {
            if (liftedIndex <= -6) score += 10;
            else if (liftedIndex <= -4) score += 6;
            else if (liftedIndex <= -2) score += 3;
        } else if (cape >= 200) {
            if (liftedIndex <= -4) score += 3;
            else if (liftedIndex <= -2) score += 1;
        }
    }
    
    // Lapse Rate (regionsspezifisch)
    if (region === 'usa') {
        if (lapse >= 8.0) score += 6;
        else if (lapse >= 7.5) score += 5;
        else if (lapse >= 7.0) score += 3;
        else if (lapse >= 6.5) score += 2;
        if (lapse < 5.5 && cape < 1000) score -= 5;
    } else {
        // Europa: Niedrigere Schwelle
        if (lapse >= 7.5) score += 5;
        else if (lapse >= 7.0) score += 3;
        else if (lapse >= 6.5) score += 2;
        else if (lapse >= 6.2) score += 1;
        else if (lapse >= 6.0) score += 1;
        if (lapse < 5.0 && cape < 800) score -= 4;
    }
    
    // K-Index
    if (kIndex >= 35) score += 6;
    else if (kIndex >= 30) score += 4;
    else if (kIndex >= 25) score += 2;
    
    // Feuchtigkeit und Temperatur (regionsspezifisch)
    if (region === 'usa') {
        if (cape >= 600) {
            if (dew >= 18 && temp2m >= 20) score += 5;
            else if (dew >= 16 && temp2m >= 18) score += 3;
            else if (dew >= 14 && temp2m >= 16) score += 2;
            
            if (relHum2m >= 70 && temp2m >= 20) score += 4;
            else if (relHum2m >= 65 && temp2m >= 18) score += 2;
        } else if (cape >= 500) {
            if (dew >= 16 && temp2m >= 18) score += 2;
            if (relHum2m >= 70 && temp2m >= 18) score += 1;
        }
    } else {
        // Europa: Auch bei niedrigem CAPE
        if (cape >= 400) {
            if (dew >= 16 && temp2m >= 16) score += 4;
            else if (dew >= 13 && temp2m >= 13) score += 2;
            
            if (relHum2m >= 65 && temp2m >= 18) score += 3;
        } else if (cape >= 200) {
            // Europa: Feuchtigkeit auch bei niedrigem CAPE wichtig
            if (dew >= 15 && temp2m >= 15) score += 3;
            else if (dew >= 13 && temp2m >= 13) score += 2;
            
            if (relHum2m >= 70 && temp2m >= 18) score += 2;
        }
    }
    
    // Niederschlag (regionsspezifisch)
    if (region === 'usa') {
        if (cape >= 600) {
            if (precipAcc >= 3.0 && cape >= 1000) score += 7;
            else if (precipAcc >= 2.0 && cape >= 800) score += 5;
            else if (precipAcc >= 1.0 && cape >= 600) score += 3;
            
            if (precipProb >= 70 && cape >= 800) score += 5;
            else if (precipProb >= 55 && cape >= 600) score += 3;
        } else if (cape >= 500) {
            if (precipAcc >= 2.0) score += 2;
            if (precipProb >= 60) score += 2;
        }
    } else {
        // Europa: Auch bei niedrigem CAPE
        if (cape >= 400) {
            if (precipAcc >= 2.5 && cape >= 800) score += 6;
            else if (precipAcc >= 1.2 && cape >= 600) score += 4;
            else if (precipAcc >= 0.5 && cape >= 400) score += 2;
            
            if (precipProb >= 65 && cape >= 600) score += 4;
            else if (precipProb >= 45 && cape >= 400) score += 2;
        } else if (cape >= 200) {
            // Europa: Niederschlag auch bei niedrigem CAPE bewerten
            if (precipAcc >= 1.0) score += 2;
            else if (precipAcc >= 0.5) score += 1;
            else if (precipAcc >= 0.2) score += 1;
            
            if (precipProb >= 50) score += 2;
            else if (precipProb >= 30) score += 1;
        }
    }
    
    // Dauerregen-Filter (regionsspezifisch)
    if (region === 'usa') {
        if (precipAcc > 3 && cape < 600) score -= 10;
    } else {
        if (precipAcc > 2 && cape < 400) score -= 8;
    }
    
    // Relative Feuchte 500hPa (trockene mittlere Troposphäre begünstigt, regionsspezifisch)
    if (region === 'usa') {
        if (hour.rh500 < 30 && cape >= 1000) score += 6;
        else if (hour.rh500 < 40 && cape >= 800) score += 4;
        else if (hour.rh500 > 85 && cape < 1000) score -= 5;
    } else {
        if (hour.rh500 < 35 && cape >= 800) score += 5;
        else if (hour.rh500 < 45 && cape >= 600) score += 3;
        else if (hour.rh500 > 85 && cape < 800) score -= 4;
    }
    
    // Strahlung (tagsüber wichtig, regionsspezifisch)
    const isNight = hour.directRadiation < 20;
    const isDaytime = hour.directRadiation >= 200;

    if (region === 'usa') {
        if (isDaytime && temp2m >= 18 && cape >= 600) {
            if (hour.directRadiation >= 600) score += 5;
            else if (hour.directRadiation >= 400) score += 3;
        } else if (isNight) {
            const llj_active = (srh >= 150 && shear >= 12) || hasLLJ;
            if (!llj_active && !isElevated && shear < 12 && cape < 1000) score -= 5;
            if (llj_active && cape >= 800) score += 4;
            else if (cape >= 1200 && srh >= 150) score += 2;
            if (isElevated && cape >= 200) score += 6; // elevated convection bonus nachts
        }
    } else {
        if (isDaytime && temp2m >= 12 && cape >= 300) {
            if (hour.directRadiation >= 500) score += 4;
            else if (hour.directRadiation >= 300) score += 2;
            else if (hour.directRadiation >= 200) score += 1;
        } else if (isNight) {
            const llj_active = (srh >= 100 && shear >= 10) || hasLLJ;
            if (!llj_active && !isElevated && shear < 10 && cape < 500) score -= 3;
            if (llj_active && cape >= 600) score += 3;
            else if (cape >= 800 && srh >= 100) score += 2;
            if (isElevated && cape >= 200) score += 5; // elevated convection bonus nachts
        }
    }
    
    // Wind (regionsspezifisch)
    if (region === 'usa') {
        if (hour.wind >= 8 && hour.wind <= 18 && temp2m >= 15) score += 3;
        else if (hour.wind > 18 && hour.wind <= 25 && temp2m >= 15) score += 5;
        if (hour.wind > 30 && cape < 2000) score -= 5;
    } else {
        if (hour.wind >= 5 && hour.wind <= 15 && temp2m >= 12) score += 2;
        else if (hour.wind > 15 && hour.wind <= 20 && temp2m >= 12) score += 4;
        if (hour.wind > 25 && cape < 1500) score -= 4;
    }
    
    // Böen (können auf Gewitteraktivität hinweisen, regionsspezifisch)
    const gustDiff = hour.gust - hour.wind;
    if (region === 'usa') {
        if (gustDiff > 15 && cape >= 1000 && temp2m >= 15) score += 5;
        else if (gustDiff > 10 && cape >= 800) score += 3;
    } else {
        if (gustDiff > 12 && cape >= 800 && temp2m >= 12) score += 4;
        else if (gustDiff > 8 && cape >= 600) score += 2;
    }

    // DCAPE: Downdraft-Potential (Gilmore & Wicker 1998)
    // Hoher DCAPE verstärkt Böen, Hagel, MCS-Aktivität
    const dcape = calcDCAPE(hour);
    if (isHighThreshold) {
        if (dcape >= 1000 && cape >= 500) score += 6;
        else if (dcape >= 700 && cape >= 400) score += 4;
        else if (dcape >= 500 && cape >= 300) score += 2;
    } else {
        if (dcape >= 800 && cape >= 400) score += 5;
        else if (dcape >= 600 && cape >= 300) score += 3;
        else if (dcape >= 400 && cape >= 200) score += 1;
    }
    
    // Ensemble-Daten (falls verfügbar, regionsspezifisch)
    // Ensemble-Daten (falls verfügbar, regionsspezifisch)
    if (hour.ensemble) {
        const MIN_PROB = 0.6;
        const capeThreshold = isHighThreshold ? 800 : 600;
        const capeMinCAPE = isHighThreshold ? 600 : 400;

        // CAPE Ensemble
        const capeProb = getEnsembleProb(hour.ensemble, 'cape', capeThreshold, 'above');
        if (capeProb !== null && capeProb >= MIN_PROB) {
            score += Math.round((isHighThreshold ? 10 : 8) * capeProb);
        }

        // Lifted Index Ensemble
        const liProb = getEnsembleProb(hour.ensemble, 'lifted_index', -3, 'below');
        if (liProb !== null && liProb >= MIN_PROB && cape >= capeMinCAPE) {
            score += Math.round((isHighThreshold ? 5 : 4) * liProb);
        }

        // Niederschlag Ensemble
        const precipEnsProb = getEnsembleProb(hour.ensemble, 'precipitation', 1, 'above');
        if (precipEnsProb !== null && precipEnsProb >= MIN_PROB && cape >= capeMinCAPE) {
            score += Math.round((isHighThreshold ? 4 : 3) * precipEnsProb);
        }

        // 850hPa Temperatur Ensemble (Lapse Rate Proxy)
        const t850Prob = getEnsembleProb(hour.ensemble, 'temperature_850hPa', 5, 'above');
        if (t850Prob !== null && t850Prob >= MIN_PROB && cape >= capeMinCAPE) {
            score += Math.round(3 * t850Prob);
        }

        // 925hPa Temperatur Ensemble (elevated parcel Proxy)
        const t925Prob = getEnsembleProb(hour.ensemble, 'temperature_925hPa', 8, 'above');
        if (t925Prob !== null && t925Prob >= MIN_PROB && isElevated) {
            score += Math.round(4 * t925Prob); // elevated bonus nur wenn wirklich elevated
        }

        // Dewpoint 925hPa Ensemble (Feuchte für elevated parcel)
        const dew925Prob = getEnsembleProb(hour.ensemble, 'dew_point_925hPa', 5, 'above');
        if (dew925Prob !== null && dew925Prob >= MIN_PROB && isElevated) {
            score += Math.round(3 * dew925Prob);
        }

        // CIN Ensemble — hohe CIN-Wahrscheinlichkeit reduziert Score
        if (!isElevated) {
            const cinProb = getEnsembleProb(hour.ensemble, 'convective_inhibition', -100, 'below');
            if (cinProb !== null && cinProb >= MIN_PROB) {
                score -= Math.round(6 * cinProb);
            }
        }

        // 925hPa Wind Ensemble (LLJ-Stärke)
        const ws925Prob = getEnsembleProb(hour.ensemble, 'wind_speed_925hPa', 15, 'above');
        if (ws925Prob !== null && ws925Prob >= MIN_PROB) {
            score += Math.round(3 * ws925Prob); // LLJ-Bonus aus Ensemble
        }
    }
    
    // Temperatur-Reduktion (kälter = weniger wahrscheinlich, regionsspezifisch)
    if (temp2m < p.minTempReduction) score = Math.round(score * p.tempReductionFactor);
    else if (temp2m < p.minTempReduction2) score = Math.round(score * p.tempReductionFactor2);
    
    // Mindestanforderungen für Gewitter (regionsspezifisch)
    if (region === 'usa') {
        if (score > 0 && cape < 500) {
            score = Math.max(0, score - 10);
        }
        if (score > 0 && cin > 150 && cape < 1500) score = Math.max(0, score - 15);
    } else {
        // Europa: Nur bei sehr niedrigem CAPE (< 200) leicht reduzieren
        if (score > 0 && cape < 200) {
            score = Math.max(0, score - 5);
        }
        if (score > 0 && cin > 150 && cape < 1200) score = Math.max(0, score - 15);
    }
    
    return Math.min(100, Math.max(0, Math.round(score)));
}

// Tornado-Wahrscheinlichkeitsberechnung (regionsspezifisch)
function calculateTornadoProbability(hour, shear, srh, region = 'europe') {
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0; // für LCL-Berechnung
    const sbCAPE = Math.max(0, hour.cape ?? 0);
    const { mucape, isElevated } = calcMUCAPE(hour);
    const cape = mucape;
    const cin = isElevated ? 0 : Math.abs(hour.cin ?? 0);
    const { liftedIndex } = calcIndices(hour);
    
    // Basis-Filter: Zu kalt oder keine Instabilität = kein Tornado (regionsspezifisch)
    const tornadoThresholds = {
        'usa': { minTemp: 12, minCAPE: 500 },
        'canada': { minTemp: 10, minCAPE: 400 },
        'south_africa': { minTemp: 12, minCAPE: 500 },
        'south_america': { minTemp: 12, minCAPE: 450 },
        'australia': { minTemp: 12, minCAPE: 450 },
        'east_asia': { minTemp: 10, minCAPE: 400 },
        'south_asia': { minTemp: 18, minCAPE: 400 },
        'southeast_asia': { minTemp: 20, minCAPE: 350 },
        'central_america': { minTemp: 18, minCAPE: 350 },
        'north_africa': { minTemp: 15, minCAPE: 350 },
        'east_africa': { minTemp: 18, minCAPE: 350 },
        'central_africa': { minTemp: 20, minCAPE: 300 },
        'west_africa': { minTemp: 22, minCAPE: 300 },
        'middle_east': { minTemp: 12, minCAPE: 350 },
        'new_zealand': { minTemp: 8, minCAPE: 300 },
        'russia_central_asia': { minTemp: 8, minCAPE: 300 },
        'europe': { minTemp: 8, minCAPE: 400 }
    };
    
    const t = tornadoThresholds[region] || tornadoThresholds['europe'];
    if (temp2m < t.minTemp) return 0;
    if (cape < t.minCAPE) return 0;
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

    const stp = calcSTP(sbCAPE, srh1km, shear, liftedIndex, cin, region, temp2m, dew) * veeringFactor;
    
    // Basis-Score für Tornado-Wahrscheinlichkeit
    let score = 0;
    
    // STP ist der Hauptindikator für Tornado-Potential (regionsspezifisch)
    const highThresholdRegions = ['usa', 'south_africa', 'south_america', 'australia'];
    const isHighThreshold = highThresholdRegions.includes(region);
    
    if (isHighThreshold) {
        if (stp >= 3.0) score = 95;
        else if (stp >= 2.0) score = 85;
        else if (stp >= 1.5) score = 70;
        else if (stp >= 1.0) score = 55;
        else if (stp >= 0.7) score = 40;
        else if (stp >= 0.5) score = 25;
        else if (stp >= 0.3) score = 12;
        else if (stp > 0) score = 5;
    } else {
        if (stp >= 2.0) score = 85;
        else if (stp >= 1.5) score = 70;
        else if (stp >= 1.0) score = 55;
        else if (stp >= 0.7) score = 40;
        else if (stp >= 0.5) score = 25;
        else if (stp >= 0.3) score = 12;
        else if (stp > 0) score = 5;
    }
    
    // Zusätzliche Faktoren (regionsspezifisch)
    if (isHighThreshold) {
        // Hohe Thresholds: usa, south_africa, south_america, australia
        if (cape >= 1500 && shear >= 25) score += 10;
        else if (cape >= 1200 && shear >= 20) score += 8;
        else if (cape >= 1000 && shear >= 18) score += 6;
        else if (cape >= 800 && shear >= 15) score += 4;
        
        if (srh >= 250 && cape >= 1200) score += 8;
        else if (srh >= 200 && cape >= 1000) score += 6;
        else if (srh >= 150 && cape >= 800) score += 4;
        else if (srh >= 120 && cape >= 600) score += 2;
        
        if (liftedIndex <= -6 && cape >= 1200) score += 6;
        else if (liftedIndex <= -5 && cape >= 1000) score += 5;
        else if (liftedIndex <= -3 && cape >= 800) score += 3;
        
        const ehi = (cape * srh) / 160000;
        if (ehi >= 3.5) score += 10;
        else if (ehi >= 2.5) score += 8;
        else if (ehi >= 1.5) score += 5;
        else if (ehi >= 1.0) score += 3;
        
        if (cin > 100) score -= 10;
        if (shear < 12) score -= 15;
        if (srh < 100) score -= 10;
    } else {
        // Niedrigere Thresholds für andere Regionen
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
    }
    
    // Temperatur-Reduktion (regionsspezifisch)
    // Quellen:
    // - Taszarek et al. 2019 (J. Climate): Europa Gewittersaison ab März/April,
    //   Nordeuropa Mai-Oktober, Mittelmeer ganzjährig
    // - Sherburn & Parker 2014 (Wea. Forecasting): HSLC-Ereignisse (CAPE ≤ 500, Shear ≥ 18 m/s)
    //   bei DEUTLICH niedrigeren Temperaturen als klassische Warm-Saison-Gewitter möglich
    // - Morgenstern et al. 2023 (WCD): Wind-field-Thunderstorms Europa = niedrige CAPE,
    //   hoher Shear, oft Kalt-Saison → Temperaturschwelle darf nicht zu hoch sein
    // - Taszarek BAMS 2021 (USA/Europa Trends): 95. Perzentil T2M Europa für schwere Gewitter

    const tempReductionParams = {
        // SPC-Klimatologie: USA Warm-Saison dominiert, aber HSLC-Ereignisse
        // im SE-US auch bei T < 15°C signifikant (Sherburn & Parker 2014)
        // threshold1 bleibt 15°C (25. Perzentil warm-season SPC proximity soundings)
        'usa': { threshold1: 13, factor1: 0.55, threshold2: 17, factor2: 0.8 },

        // Hanesiak et al. 2024 (JGR): Kanada Tornados ab ~10°C in Prärie möglich,
        // aber signifikante Ereignisse meist ab 14°C+
        'canada': { threshold1: 10, factor1: 0.55, threshold2: 14, factor2: 0.8 },

        // Taszarek 2019: Südeuropa/Mittelmeer Gewitter ganzjährig, auch bei 10-12°C
        // Nordeuropa ab Mai (≈8-10°C) bis Oktober
        // Morgenstern 2023: Wind-field-Thunderstorms Europa Winter bei T < 10°C
        // → threshold1 auf 8°C (Kalt-Saison Gewitter Nordsee/Atlantik physikalisch möglich)
        'europe': { threshold1: 8, factor1: 0.5, threshold2: 13, factor2: 0.75 },

        // Taszarek 2021 npj: Südafrika (Highveld) Gewittersaison Sep-Apr,
        // Mindesttemperaturen ~14-16°C für bedeutende Konvektion
        'south_africa': { threshold1: 14, factor1: 0.6, threshold2: 19, factor2: 0.8 },

        // Taszarek 2020 Part II: Argentinien/Südamerika ähnlich USA Plains
        // CAPE-reiche Umgebungen meist ab 16°C, aber auch sub-tropische Ausläufer ab 12°C
        'south_america': { threshold1: 13, factor1: 0.6, threshold2: 18, factor2: 0.8 },

        // Taszarek 2021: Australien Gewittersaison Sep-Mar (Southern Hemisphere)
        // Thermodynamisch ähnlich USA Plains, threshold leicht niedriger wegen Küsteneffekten
        'australia': { threshold1: 13, factor1: 0.6, threshold2: 18, factor2: 0.8 },

        // Taszarek 2021: Ostasien (Japan, China, Korea) ähnlich Europa klimatologisch
        // Kalt-Saison Konvektion (Japan Sea effect) bei T < 10°C möglich
        'east_asia': { threshold1: 10, factor1: 0.55, threshold2: 16, factor2: 0.8 },

        // Südasien: Monsun-Konvektion, Temperaturen fast immer > 25°C während
        // aktiver Konvektionsphasen; Pre-Monsoon-Gewitter (Nor'westers) ab ~22°C
        'south_asia': { threshold1: 20, factor1: 0.6, threshold2: 25, factor2: 0.8 },

        // Südostasien: tropisch, ITCZ-dominiert, Konvektion fast täglich,
        // bedeutende Gewitter praktisch nur bei T > 24°C (maritime tropical airmass)
        'southeast_asia': { threshold1: 22, factor1: 0.6, threshold2: 26, factor2: 0.8 },

        // Zentralamerika ähnlich Südostasien, Karibik etwas niedrigere Schwelle
        // durch höhenlagenbedingte Effekte in Bergregionen
        'central_america': { threshold1: 18, factor1: 0.6, threshold2: 23, factor2: 0.8 },

        // Nordafrika (Maghreb): Sahara-Konvektion möglich ab ~18°C,
        // Küsten/Atlas-Gewitter (Marokko, Algerien) ähnlich Mittelmeer ab ~14°C
        'north_africa': { threshold1: 15, factor1: 0.6, threshold2: 20, factor2: 0.8 },

        // Ostafrika: Hochlandgewitter (Äthiopien, Kenia) bei kühleren T möglich (~16-18°C),
        // Küstenregionen eher ab 22°C
        'east_africa': { threshold1: 17, factor1: 0.6, threshold2: 22, factor2: 0.8 },

        // Zentralafrika: tropischer Regenwald, Konvektion fast täglich, T fast immer > 22°C
        'central_africa': { threshold1: 20, factor1: 0.6, threshold2: 24, factor2: 0.8 },

        // Westafrika: Sahel-Gewitter und MCS. Trockenzeit-MCS ab ~28°C,
        // aber Küstennähe (Gambia, Senegal) auch ab ~24°C
        'west_africa': { threshold1: 22, factor1: 0.6, threshold2: 27, factor2: 0.8 },

        // Naher Osten: Frühjahrs-Konvektion Levante/Anatolien ab ~14°C (ähnlich Mittelmeer),
        // Sommer-Konvektion Iran/Pakistan ab ~20°C
        'middle_east': { threshold1: 13, factor1: 0.6, threshold2: 18, factor2: 0.8 },

        // Neuseeland: maritime Klimatologie, HSLC-Ereignisse im Winter möglich
        // (ähnlich Britische Inseln), Taszarek 2019 Analogie
        'new_zealand': { threshold1: 8, factor1: 0.55, threshold2: 13, factor2: 0.8 },

        // Russland/Zentralasien: kontinental, aber Kalt-Saison-Gewitter im Westen
        // (Westsibirien, Kasachstan) ab ~8°C möglich (HSLC-analog zu Europa)
        'russia_central_asia': { threshold1: 8, factor1: 0.55, threshold2: 13, factor2: 0.8 },
    };

    const tr = tempReductionParams[region] || tempReductionParams['europe'];
    if (temp2m < tr.threshold1) score = Math.round(score * tr.factor1);
    else if (temp2m < tr.threshold2) score = Math.round(score * tr.factor2);

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

    // Minimalanforderungen – nur noch für Grenzfälle die STP-Filter passiert haben
    const minReqs = {
        // SPC Thompson 2003/2012: sig. Tornados USA median CAPE ~1000-2000 J/kg,
        // 0-6km Shear median ~20 m/s, 0-1km SRH median ~150-200 m²/s²
        // Minimums aus dem 25. Perzentil der SPC-Proximity-Sounding-Datenbank
        'usa': { minCAPE: 500, minShear: 12, minSRH: 100 },   // Shear 10→12 (SPC: <12.5 = STP-Cutoff)

        // Ähnlich USA aber kältere Umgebung, Bunkers 2014 Alberta-Studie: sig. Tornados ab ~400 J/kg
        'canada': { minCAPE: 350, minShear: 10, minSRH: 70 }, // CAPE 400→350

        // Púčik 2015 (ESSL): sig. Tornados Europa — CAPE ähnlich nonsevere, DLS entscheidend
        // Taszarek 2017 MWR: severe winds Europa ab CAPE ~200 J/kg + hohem Shear
        // Taszarek 2020: Europa CAPE tail 3000-4000 J/kg (viel niedriger als USA)
        'europe': { minCAPE: 200, minShear: 8, minSRH: 50 },  // CAPE 400→200, Shear 8 bleibt, SRH 60→50

        // Gatzen 2020 (derechos Deutschland): warm-season Typ MLCAPE median ~500 J/kg, Shear 15-20 m/s
        // Cold-season Typ: CAPE fast 0, Shear > 20 m/s → deshalb minCAPE nicht zu hoch
        'russia_central_asia': { minCAPE: 300, minShear: 8, minSRH: 50 }, // CAPE 300→300 (bleibt), SRH 50→50

        // Taszarek 2020 Part II: Südamerika (Argentinien) ähnlich USA Plains, CAPE höher
        // Brooks et al. 2003: globale Schwelle für WMAXSHEAR > 500 = schweres Gewitter
        'south_america': { minCAPE: 400, minShear: 10, minSRH: 70 },  // CAPE 450→400

        // Taszarek 2021 npj: Australien ähnlich USA Plains klimatologisch
        'australia': { minCAPE: 400, minShear: 10, minSRH: 80 },       // CAPE 450→400

        // Taszarek 2020: Südafrika (Highveld) ähnlich USA, CAPE hoch, Shear moderat-stark
        'south_africa': { minCAPE: 450, minShear: 12, minSRH: 90 },    // CAPE 500→450

        // Taszarek 2021 npj: Ostasien (China, Japan) ähnlich Europa klimatologisch
        'east_asia': { minCAPE: 350, minShear: 9, minSRH: 60 },        // CAPE 400→350, Shear 10→9

        // Taszarek 2021: Südasien (Indien, Pakistan) monsunbeeinflusst, CAPE hoch aber Shear niedrig
        'south_asia': { minCAPE: 350, minShear: 7, minSRH: 50 },       // CAPE 400→350, SRH 60→50

        // Taszarek 2021: Südostasien, tropisch, sehr hohe CAPE, niedriger Shear typisch
        'southeast_asia': { minCAPE: 300, minShear: 5, minSRH: 40 },   // Shear 6→5

        // Púčik 2015 / Taszarek 2017: Zentralamerika ähnlich SE-Asien, CAPE hoch
        'central_america': { minCAPE: 300, minShear: 7, minSRH: 45 },  // CAPE 350→300

        // Taszarek 2017: Nordafrika (Maghreb) ähnlich Mittelmeer-Europa
        'north_africa': { minCAPE: 300, minShear: 7, minSRH: 45 },     // CAPE 350→300, Shear 8→7

        // Taszarek 2021: Ostafrika hochgelegen (z.B. Äthiopien-Hochland), CAPE moderiert durch Höhe
        'east_africa': { minCAPE: 300, minShear: 6, minSRH: 40 },      // CAPE 350→300, Shear 7→6

        // Zentralafrika: tropische Konvektion, CAPE hoch, Shear niedrig (ITCZ-dominiert)
        'central_africa': { minCAPE: 250, minShear: 5, minSRH: 30 },   // CAPE 300→250

        // Westafrika: ähnlich Zentralafrika, Sahel-Linie kann MCS produzieren
        'west_africa': { minCAPE: 250, minShear: 5, minSRH: 35 },      // CAPE 300→250

        // Mittlerer Osten: Frühjahr-Konvektion, CAPE niedriger als Tropen
        'middle_east': { minCAPE: 300, minShear: 7, minSRH: 45 },      // CAPE 350→300, Shear 8→7

        // Neuseeland: HSLC-Regime möglich (wie Europa Kalt-Saison), aber seltener
        'new_zealand': { minCAPE: 250, minShear: 6, minSRH: 40 },      // CAPE 300→250, Shear 7→6
    };

    const mr = minReqs[region] || minReqs['europe'];

    // Kombinierte Penalty statt dreifach unabhängiger Reduktion:
    // Zähle wie viele Mindestanforderungen verfehlt werden
    let failCount = 0;
    if (cape  < mr.minCAPE  && score > 15) failCount++;
    if (shear < mr.minShear && score > 10) failCount++;
    if (srh   < mr.minSRH   && score > 10) failCount++;

    // Eine gestufte Gesamtreduktion statt kumulativer Einzelreduktionen
    if      (failCount === 3) score = Math.round(score * 0.35); // alle drei fehlen: stark reduzieren
    else if (failCount === 2) score = Math.round(score * 0.55); // zwei fehlen: moderat
    else if (failCount === 1) score = Math.round(score * 0.75); // einer fehlt: leicht reduzieren

    return Math.min(100, Math.max(0, Math.round(score)));
}