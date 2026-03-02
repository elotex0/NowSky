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
                    `precipitation&forecast_days=16&models=best_match&timezone=auto`;

        const ensembleUrl = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=temperature_2m,dew_point_2m,wind_gusts_10m,wind_speed_10m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_speed_1000hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
                    `relative_humidity_500hPa,cape,convective_inhibition,lifted_index,` +
                    `dew_point_850hPa,dew_point_700hPa,boundary_layer_height,direct_radiation,` +
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
                    'temperature_500hPa', 'temperature_700hPa', 'temperature_850hPa',
                    'wind_speed_300hPa', 'wind_speed_500hPa', 'wind_speed_700hPa', 'wind_speed_850hPa', 'wind_speed_1000hPa',
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
                const freezingLevel = calcFreezingLevel(hour);
                const wmaxshear = calcWMAXSHEAR(hour.cape, shear);
                const probabilities = calculateHailProbabilities(hour, region, freezingLevel);
                return {
                    timestamp: hour.time,
                    probability_0_1cm: probabilities.size_0_1cm,
                    probability_0_5cm: probabilities.size_0_5cm,
                    probability_1cm: probabilities.size_1cm,
                    probability_2cm: probabilities.size_2cm,
                    probability_5cm: probabilities.size_5cm,
                    temperature: hour.temperature,
                    cape: hour.cape,
                    shear: shear,
                    srh: srh,
                    freezingLevel: freezingLevel,
                    wmaxshear: wmaxshear,
                    dcape: calcDCAPE(hour),
                };
            });

        // Tage gruppieren
        const daysMap = new Map();
        hours.forEach(h => {
            const [datePart] = h.time.split('T');
            if (datePart >= currentDateStr) {
                const freezingLevel = calcFreezingLevel(h);
                const probabilities = calculateHailProbabilities(h, region, freezingLevel);
                if (!daysMap.has(datePart)) {
                    daysMap.set(datePart, { 
                        date: datePart, 
                        maxProbability_0_1cm: probabilities.size_0_1cm,
                        maxProbability_0_5cm: probabilities.size_0_5cm,
                        maxProbability_1cm: probabilities.size_1cm,
                        maxProbability_2cm: probabilities.size_2cm,
                        maxProbability_5cm: probabilities.size_5cm
                    });
                } else {
                    const dayData = daysMap.get(datePart);
                    dayData.maxProbability_0_1cm = Math.max(dayData.maxProbability_0_1cm, probabilities.size_0_1cm);
                    dayData.maxProbability_0_5cm = Math.max(dayData.maxProbability_0_5cm, probabilities.size_0_5cm);
                    dayData.maxProbability_1cm = Math.max(dayData.maxProbability_1cm, probabilities.size_1cm);
                    dayData.maxProbability_2cm = Math.max(dayData.maxProbability_2cm, probabilities.size_2cm);
                    dayData.maxProbability_5cm = Math.max(dayData.maxProbability_5cm, probabilities.size_5cm);
                }
            }
        });

        const nextDays = Array.from(daysMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(day => ({ 
                date: day.date, 
                probability_0_1cm: day.maxProbability_0_1cm,
                probability_0_5cm: day.maxProbability_0_5cm,
                probability_1cm: day.maxProbability_1cm,
                probability_2cm: day.maxProbability_2cm,
                probability_5cm: day.maxProbability_5cm
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
    // Afrika - Ostafrika: ca. 5°S - 12°N, 30°E - 52°E
    if (lat >= -5 && lat <= 12 && lon >= 30 && lon <= 52) {
        return 'east_africa';
    }
    // Afrika - Zentralafrika: ca. 5°S - 10°N, 10°W - 30°E
    if (lat >= -5 && lat <= 10 && lon >= -10 && lon <= 30) {
        return 'central_africa';
    }
    // Afrika - Westafrika: ca. 5°N - 15°N, -20°W - 15°E
    if (lat >= 5 && lat <= 15 && lon >= -20 && lon <= 15) {
        return 'west_africa';
    }
    // Afrika - Nordafrika: ca. 15°N - 35°N, -20°W - 40°E
    if (lat >= 15 && lat <= 35 && lon >= -20 && lon <= 40) {
        return 'north_africa';
    }
    // Madagaskar: ca. 12°S - 25°S, 43°E - 51°E
    if (lat >= -25 && lat <= -12 && lon >= 43 && lon <= 51) {
        return 'south_africa';
    }
    // Asien - Südasien: ca. 5°N - 35°N, 60°E - 100°E
    if (lat >= 5 && lat <= 35 && lon >= 60 && lon <= 100) {
        return 'south_asia';
    }
    // Asien - Ostasien: ca. 20°N - 50°N, 100°E - 145°E
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
    // Standard: Europa
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

function calcSRH(hour, layer = '0-3km') {
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

    const meanU = winds.reduce((s, w) => s + w.u, 0) / winds.length;
    const meanV = winds.reduce((s, w) => s + w.v, 0) / winds.length;

    const shearU = winds[winds.length - 1].u - winds[0].u;
    const shearV = winds[winds.length - 1].v - winds[0].v;
    const shearMag = Math.hypot(shearU, shearV) || 1;

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
    const ws500 = (hour.wind_speed_500hPa ?? 0) / 3.6;
    const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
    const w500 = windToUV(ws500, hour.windDir500 ?? 0);
    const w1000 = windToUV(ws1000, hour.windDir1000 ?? 0);

    const bulkShear = Math.hypot(w500.u - w1000.u, w500.v - w1000.v);

    const ws850 = (hour.wind_speed_850hPa ?? 0) / 3.6;
    const w850 = windToUV(ws850, hour.windDir850 ?? 0);
    const lowLevelShear = Math.hypot(w850.u - w1000.u, w850.v - w1000.v);

    return Math.round((bulkShear * 0.75 + lowLevelShear * 0.25) * 10) / 10;
}

// Gefrierpunkt-Höhe berechnen (0°C Level)
// Wichtig für Hagelbildung: Niedrige Gefrierpunkt-Höhe begünstigt Hagel
function calcFreezingLevel(hour) {
    const temp2m = hour.temperature ?? 0;
    const temp850 = hour.temp850 ?? 0;
    const temp700 = hour.temp700 ?? 0;
    
    // Standard-Lapse-Rate: ~6.5°C/km
    const lapseRate = 6.5;
    
    // Wenn 2m-Temperatur unter 0°C, Gefrierpunkt ist am Boden
    if (temp2m <= 0) {
        return 0;
    }
    
    // Approximation: Gefrierpunkt-Höhe basierend auf Temperaturgradient
    // Zwischen 850hPa (~1.5km) und 700hPa (~3km)
    const height850 = 1500; // ~1.5km
    const height700 = 3000; // ~3km
    
    // Lineare Interpolation für 0°C
    if (temp850 <= 0 && temp700 > 0) {
        // 0°C zwischen 850 und 700 hPa
        const ratio = (0 - temp850) / (temp700 - temp850);
        return Math.round(height850 + ratio * (height700 - height850));
    } else if (temp850 > 0) {
        // 0°C unter 850 hPa, extrapoliere nach unten
        const gradient = (temp850 - temp2m) / (height850 / 1000);
        if (gradient > 0) {
            const freezingHeight = (temp2m / gradient) * 1000;
            return Math.max(0, Math.round(freezingHeight));
        }
    }
    
    // Fallback: Standard-Berechnung basierend auf 2m-Temperatur
    return Math.max(0, Math.round((temp2m / lapseRate) * 1000));
}

// DCAPE (Downdraft CAPE) - wichtig für Hagel
function calcDCAPE(hour) {
    const temp700 = hour.temp700 ?? 0;
    const dew700 = hour.dew700 ?? 0;
    const temp500 = hour.temp500 ?? 0;
    const cape = hour.cape ?? 0;

    if (cape < 100) return 0;

    const wetBulb700 = temp700 - 0.33 * (temp700 - dew700);
    const tempDiff = wetBulb700 - temp500;
    if (tempDiff <= 0) return 0;

    const dewDepression700 = temp700 - dew700;
    const moistFactor = dewDepression700 > 20 ? 0.2
                      : dewDepression700 > 10 ? 0.5
                      : dewDepression700 > 5  ? 0.8
                      : 1.0;

    const T_env_kelvin = temp700 + 273.15;
    const dz = 2500;
    const dcape = Math.max(0, (tempDiff / T_env_kelvin) * 9.81 * dz * moistFactor);
    return Math.round(dcape);
}

// WMAXSHEAR - bester Prädiktor für schwere Gewitter/Hagel
function calcWMAXSHEAR(cape, shear) {
    if (cape <= 0 || shear <= 0) return 0;
    return Math.round(Math.sqrt(2 * cape) * shear);
}

// Hagel-Wahrscheinlichkeitsberechnung für verschiedene Hagelgrößen
function calculateHailProbabilities(hour, region = 'europe', freezingLevel) {
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0;
    const cape = Math.max(0, hour.cape ?? 0);
    const cin = Math.abs(hour.cin ?? 0);
    const precipAcc = hour.precipAcc ?? 0;
    const precipProb = hour.precip ?? 0;
    
    // Basis-Filter: Zu kalt oder keine Instabilität = kein Hagel
    const hailParams = getHailParams(region);
    if (temp2m < hailParams.minTemp) {
        return { size_0_1cm: 0, size_0_5cm: 0, size_1cm: 0, size_2cm: 0, size_5cm: 0 };
    }
    if (cape < hailParams.minCAPE) {
        return { size_0_1cm: 0, size_0_5cm: 0, size_1cm: 0, size_2cm: 0, size_5cm: 0 };
    }
    if (cin > 200) {
        return { size_0_1cm: 0, size_0_5cm: 0, size_1cm: 0, size_2cm: 0, size_5cm: 0 };
    }
    
    // Berechne Indizes
    const shear = calcShear(hour);
    const srh = calcSRH(hour, '0-3km');
    const wmaxshear = calcWMAXSHEAR(cape, shear);
    const dcape = calcDCAPE(hour);
    const relHum2m = calcRelHum(temp2m, dew);
    const liftedIndex = hour.liftedIndex ?? 0;
    const temp500 = hour.temp500 ?? 0;
    
    // Basis-Score für alle Größen berechnen
    let baseScore = calculateBaseHailScore(hour, region, freezingLevel, cape, cin, shear, srh, wmaxshear, dcape, temp500, precipAcc, precipProb, liftedIndex, temp2m, hailParams);
    
    // Wahrscheinlichkeiten für verschiedene Hagelgrößen berechnen
    // Größere Hagelkörner benötigen strengere Bedingungen
    
    // 0.1cm Hagel (kleinster Hagel, häufigste Größe)
    let score_0_1cm = baseScore;
    // Keine zusätzlichen Anforderungen für 0.1cm
    
    // 0.5cm Hagel
    let score_0_5cm = baseScore;
    if (cape < 400) score_0_5cm *= 0.6;
    if (shear < 10) score_0_5cm *= 0.5;
    if (wmaxshear < 300) score_0_5cm *= 0.4;
    if (freezingLevel > 3000) score_0_5cm *= 0.5;
    
    // 1cm Hagel
    let score_1cm = baseScore;
    if (cape < 600) score_1cm *= 0.5;
    if (shear < 12) score_1cm *= 0.4;
    if (wmaxshear < 500) score_1cm *= 0.3;
    if (freezingLevel > 2800) score_1cm *= 0.4;
    if (srh < 100) score_1cm *= 0.6;
    
    // 2cm Hagel (großer Hagel)
    let score_2cm = baseScore;
    if (cape < 1000) score_2cm *= 0.4;
    if (shear < 15) score_2cm *= 0.3;
    if (wmaxshear < 700) score_2cm *= 0.2;
    if (freezingLevel > 2500) score_2cm *= 0.3;
    if (srh < 150) score_2cm *= 0.5;
    if (temp500 > -10) score_2cm *= 0.6;
    if (hour.rh500 > 60) score_2cm *= 0.5;
    
    // 5cm Hagel (sehr großer Hagel, selten)
    let score_5cm = baseScore;
    if (cape < 1500) score_5cm *= 0.3;
    if (shear < 18) score_5cm *= 0.2;
    if (wmaxshear < 900) score_5cm *= 0.15;
    if (freezingLevel > 2200) score_5cm *= 0.2;
    if (srh < 200) score_5cm *= 0.4;
    if (temp500 > -12) score_5cm *= 0.4;
    if (hour.rh500 > 50) score_5cm *= 0.4;
    if (dcape < 700) score_5cm *= 0.5;
    // Sehr großer Hagel benötigt Superzellen-Bedingungen
    if (srh < 150 || shear < 20) score_5cm *= 0.3;
    
    return {
        size_0_1cm: Math.min(100, Math.max(0, Math.round(score_0_1cm))),
        size_0_5cm: Math.min(100, Math.max(0, Math.round(score_0_5cm))),
        size_1cm: Math.min(100, Math.max(0, Math.round(score_1cm))),
        size_2cm: Math.min(100, Math.max(0, Math.round(score_2cm))),
        size_5cm: Math.min(100, Math.max(0, Math.round(score_5cm)))
    };
}

// Basis-Score für Hagel berechnen (wird für alle Größen verwendet)
function calculateBaseHailScore(hour, region, freezingLevel, cape, cin, shear, srh, wmaxshear, dcape, temp500, precipAcc, precipProb, liftedIndex, temp2m, hailParams) {
    // Gefrierpunkt-Höhe ist kritisch für Hagel
    let freezingLevelScore = 0;
    if (freezingLevel < 1500) freezingLevelScore = 20;
    else if (freezingLevel < 2000) freezingLevelScore = 15;
    else if (freezingLevel < 2500) freezingLevelScore = 10;
    else if (freezingLevel < 3000) freezingLevelScore = 5;
    else if (freezingLevel < 3500) freezingLevelScore = 2;
    else if (freezingLevel >= 4000) freezingLevelScore = -10;
    
    let score = freezingLevelScore;
    
    // CAPE-Bewertung
    for (let i = 0; i < hailParams.capeThresholds.length; i++) {
        if (cape >= hailParams.capeThresholds[i]) {
            score += hailParams.capeScores[i];
            break;
        }
    }
    
    // WMAXSHEAR ist der beste Prädiktor für Hagel
    if (wmaxshear >= 1200) score += 25;
    else if (wmaxshear >= 900) score += 20;
    else if (wmaxshear >= 700) score += 15;
    else if (wmaxshear >= 500) score += 10;
    else if (wmaxshear >= 300) score += 5;
    
    // Shear ist kritisch für Hagel
    if (shear >= 25) score += 15;
    else if (shear >= 20) score += 12;
    else if (shear >= 15) score += 8;
    else if (shear >= 12) score += 5;
    else if (shear >= 10) score += 2;
    else if (shear < 8) score -= 10;
    
    // SRH unterstützt rotierende Aufwinde (Superzellen)
    if (srh >= 200 && cape >= 800) score += 10;
    else if (srh >= 150 && cape >= 600) score += 7;
    else if (srh >= 120 && cape >= 500) score += 4;
    else if (srh >= 80 && cape >= 400) score += 2;
    
    // DCAPE: Starke Downbursts können Hagel begünstigen
    if (dcape >= 1000 && cape >= 500) score += 8;
    else if (dcape >= 700 && cape >= 400) score += 5;
    else if (dcape >= 500 && cape >= 300) score += 3;
    
    // Relative Feuchte 500hPa: Trockene mittlere Troposphäre begünstigt Hagel
    if (hour.rh500 < 30 && cape >= 800) score += 8;
    else if (hour.rh500 < 40 && cape >= 600) score += 5;
    else if (hour.rh500 < 50 && cape >= 500) score += 3;
    else if (hour.rh500 > 85 && cape < 1000) score -= 5;
    
    // Temperatur 500hPa: Kältere mittlere Troposphäre begünstigt Hagel
    if (temp500 < -20 && cape >= 800) score += 6;
    else if (temp500 < -15 && cape >= 600) score += 4;
    else if (temp500 < -10 && cape >= 500) score += 2;
    else if (temp500 > -5 && cape < 1000) score -= 3;
    
    // Niederschlag: Hagel tritt bei konvektiven Niederschlägen auf
    if (precipAcc >= 2.0 && cape >= 800) score += 6;
    else if (precipAcc >= 1.0 && cape >= 600) score += 4;
    else if (precipAcc >= 0.5 && cape >= 400) score += 2;
    
    if (precipProb >= 70 && cape >= 600) score += 5;
    else if (precipProb >= 50 && cape >= 500) score += 3;
    else if (precipProb >= 30 && cape >= 400) score += 1;
    
    // Lifted Index: Starke Instabilität begünstigt Hagel
    if (liftedIndex <= -6 && cape >= 800) score += 8;
    else if (liftedIndex <= -4 && cape >= 600) score += 5;
    else if (liftedIndex <= -2 && cape >= 500) score += 3;
    
    // CIN-Penalty
    if (cin > 200) score -= 15;
    else if (cin > 100) score -= 8;
    else if (cin > 50) score -= 4;
    
    // Temperatur: Zu kalt = weniger Hagel (Winter)
    if (temp2m < hailParams.minTempReduction) score = Math.round(score * hailParams.tempReductionFactor);
    else if (temp2m < hailParams.minTempReduction2) score = Math.round(score * hailParams.tempReductionFactor2);
    
    // Mindestanforderungen für Hagel
    if (score > 0 && cape < hailParams.minCAPE) {
        score = Math.max(0, score - 10);
    }
    if (score > 0 && shear < 10) {
        score = Math.max(0, score - 15);
    }
    if (score > 0 && freezingLevel > 3500) {
        score = Math.max(0, score - 10);
    }
    
    return score;
}

// Regionsspezifische Parameter für Hagel-Wahrscheinlichkeit
function getHailParams(region) {
    const params = {
        'usa': {
            minTemp: 10, minTempWithCAPE: 15, minCAPE: 600, minCAPEWithPrecip: 300,
            capeThresholds: [3000, 2500, 2000, 1500, 1200, 1000, 800, 600],
            capeScores: [35, 30, 25, 20, 15, 12, 8, 5],
            minTempReduction: 15, tempReductionFactor: 0.5,
            minTempReduction2: 18, tempReductionFactor2: 0.7
        },
        'canada': {
            minTemp: 8, minTempWithCAPE: 12, minCAPE: 500, minCAPEWithPrecip: 250,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600, 500],
            capeScores: [30, 25, 20, 16, 12, 9, 6, 4],
            minTempReduction: 12, tempReductionFactor: 0.5,
            minTempReduction2: 15, tempReductionFactor2: 0.7
        },
        'central_america': {
            minTemp: 15, minTempWithCAPE: 20, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [32, 27, 22, 18, 14, 10, 6, 3],
            minTempReduction: 18, tempReductionFactor: 0.6,
            minTempReduction2: 22, tempReductionFactor2: 0.8
        },
        'south_america': {
            minTemp: 12, minTempWithCAPE: 18, minCAPE: 500, minCAPEWithPrecip: 250,
            capeThresholds: [3000, 2500, 2000, 1500, 1200, 1000, 800, 600],
            capeScores: [35, 30, 25, 20, 15, 12, 8, 5],
            minTempReduction: 15, tempReductionFactor: 0.5,
            minTempReduction2: 20, tempReductionFactor2: 0.7
        },
        'south_africa': {
            minTemp: 12, minTempWithCAPE: 18, minCAPE: 600, minCAPEWithPrecip: 300,
            capeThresholds: [3000, 2500, 2000, 1800, 1500, 1200, 1000, 800],
            capeScores: [35, 30, 26, 22, 18, 14, 10, 6],
            minTempReduction: 15, tempReductionFactor: 0.5,
            minTempReduction2: 20, tempReductionFactor2: 0.7
        },
        'east_africa': {
            minTemp: 18, minTempWithCAPE: 23, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [30, 25, 20, 16, 12, 8, 5, 3],
            minTempReduction: 20, tempReductionFactor: 0.6,
            minTempReduction2: 24, tempReductionFactor2: 0.8
        },
        'central_africa': {
            minTemp: 20, minTempWithCAPE: 25, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [30, 25, 20, 16, 12, 8, 5, 3],
            minTempReduction: 22, tempReductionFactor: 0.6,
            minTempReduction2: 25, tempReductionFactor2: 0.8
        },
        'west_africa': {
            minTemp: 22, minTempWithCAPE: 27, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [30, 25, 20, 16, 12, 8, 5, 3],
            minTempReduction: 24, tempReductionFactor: 0.6,
            minTempReduction2: 28, tempReductionFactor2: 0.8
        },
        'north_africa': {
            minTemp: 15, minTempWithCAPE: 20, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [30, 25, 20, 16, 12, 8, 5, 3],
            minTempReduction: 18, tempReductionFactor: 0.5,
            minTempReduction2: 22, tempReductionFactor2: 0.7
        },
        'south_asia': {
            minTemp: 20, minTempWithCAPE: 25, minCAPE: 500, minCAPEWithPrecip: 250,
            capeThresholds: [3000, 2500, 2000, 1800, 1500, 1200, 1000, 800],
            capeScores: [35, 30, 25, 22, 18, 14, 10, 6],
            minTempReduction: 22, tempReductionFactor: 0.5,
            minTempReduction2: 27, tempReductionFactor2: 0.7
        },
        'east_asia': {
            minTemp: 10, minTempWithCAPE: 15, minCAPE: 500, minCAPEWithPrecip: 250,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600, 500],
            capeScores: [30, 25, 20, 16, 12, 9, 6, 4],
            minTempReduction: 12, tempReductionFactor: 0.5,
            minTempReduction2: 18, tempReductionFactor2: 0.7
        },
        'southeast_asia': {
            minTemp: 22, minTempWithCAPE: 27, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [30, 25, 20, 16, 12, 8, 5, 3],
            minTempReduction: 24, tempReductionFactor: 0.6,
            minTempReduction2: 28, tempReductionFactor2: 0.8
        },
        'australia': {
            minTemp: 12, minTempWithCAPE: 18, minCAPE: 500, minCAPEWithPrecip: 250,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600, 500],
            capeScores: [30, 25, 20, 16, 12, 9, 6, 4],
            minTempReduction: 15, tempReductionFactor: 0.5,
            minTempReduction2: 20, tempReductionFactor2: 0.7
        },
        'new_zealand': {
            minTemp: 8, minTempWithCAPE: 12, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 500, 400],
            capeScores: [28, 23, 18, 14, 10, 7, 5, 3],
            minTempReduction: 10, tempReductionFactor: 0.5,
            minTempReduction2: 14, tempReductionFactor2: 0.7
        },
        'russia_central_asia': {
            minTemp: 5, minTempWithCAPE: 10, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2000, 1500, 1200, 1000, 800, 600, 500, 400],
            capeScores: [28, 23, 18, 14, 10, 7, 5, 3],
            minTempReduction: 8, tempReductionFactor: 0.5,
            minTempReduction2: 12, tempReductionFactor2: 0.7
        },
        'middle_east': {
            minTemp: 12, minTempWithCAPE: 18, minCAPE: 400, minCAPEWithPrecip: 200,
            capeThresholds: [2500, 2000, 1500, 1200, 1000, 800, 600, 400],
            capeScores: [30, 25, 20, 16, 12, 8, 5, 3],
            minTempReduction: 15, tempReductionFactor: 0.5,
            minTempReduction2: 20, tempReductionFactor2: 0.7
        },
        'europe': {
            minTemp: 5, minTempWithCAPE: 10, minCAPE: 300, minCAPEWithPrecip: 150,
            capeThresholds: [2000, 1500, 1200, 800, 600, 500, 400, 300],
            capeScores: [28, 23, 18, 12, 9, 6, 4, 2],
            minTempReduction: 12, tempReductionFactor: 0.5,
            minTempReduction2: 15, tempReductionFactor2: 0.7
        }
    };
    return params[region] || params['europe'];
}
