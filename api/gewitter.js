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
                    `precipitation&forecast_days=14&models=best_match&timezone=auto`;

        const ensembleUrl = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=temperature_2m,dew_point_2m,wind_gusts_10m,wind_speed_10m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_speed_1000hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
                    `relative_humidity_500hPa,cape,convective_inhibition,lifted_index,` +
                    `dew_point_850hPa,dew_point_700hPa,boundary_layer_height,direct_radiation,` +
                    `precipitation&forecast_days=14&models=best_match&timezone=auto`;

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
                return {
                    timestamp: hour.time,
                    probability: calculateProbability(hour, region),
                    tornadoProbability: calculateTornadoProbability(hour, shear, srh, region),
                    temperature: hour.temperature,
                    cape: hour.cape,
                    shear: shear,
                    srh: srh
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
    // USA: ca. 25°N - 50°N, -125°W - -65°W
    if (lat >= 35 && lat <= 70 && lon >= -10 && lon <= 40) {
        return 'europe';
    } else if (lat >= 25 && lat <= 50 && lon >= -125 && lon <= -65) {
        return 'usa';
    }
    // Standard: Europa (für andere Regionen)
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

function calcSRH(hour) {
    const ws = [hour.wind_speed_1000hPa ?? 0, hour.wind_speed_850hPa ?? 0, hour.wind_speed_700hPa ?? 0].map(v => v / 3.6);
    const wd = [hour.windDir1000 ?? 0, hour.windDir850 ?? 0, hour.windDir700 ?? 0];
    const winds = ws.map((s, i) => windToUV(s, wd[i]));

    let sr = (winds[0].u * (winds[1].v - winds[0].v) - winds[0].v * (winds[1].u - winds[0].u)) * 1.5;
    sr += (winds[1].u * (winds[2].v - winds[1].v) - winds[1].v * (winds[2].u - winds[1].u)) * 1.5;
    return Math.round(Math.abs(sr) * 10) / 10;
}

function calcShear(hour) {
    const ws300 = (hour.wind_speed_300hPa ?? 0) / 3.6;
    const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
    const w300 = windToUV(ws300, hour.windDir300 ?? 0);
    const w1000 = windToUV(ws1000, hour.windDir1000 ?? 0);
    return Math.hypot(w300.u - w1000.u, w300.v - w1000.v);
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
        lapse: (temp850 - temp500) / 5.5,
        liftedIndex: hour.liftedIndex ?? (temp500 - (temp850 - 9.8 * 1.5))
    };
}

// SCP (Supercell Composite Parameter) - regionsspezifisch
function calcSCP(cape, shear, srh, cin, region = 'europe') {
    if (region === 'usa') {
        // USA: Höhere Thresholds
        if (cape < 500 || shear < 10 || srh < 100 || cin > 200) return 0;
        return (cape / 1000) * (shear / 15) * (srh / 150) * (1 - Math.min(cin / 200, 1));
    } else {
        // Europa: Niedrigere Thresholds - auch bei niedrigem CAPE möglich
        if (cape < 200 || shear < 6 || srh < 60 || cin > 250) return 0;
        return (cape / 600) * (shear / 12) * (srh / 100) * (1 - Math.min(cin / 250, 1));
    }
}

// STP (Significant Tornado Parameter) - regionsspezifisch
function calcSTP(cape, srh, shear, liftedIndex, cin, region = 'europe') {
    if (region === 'usa') {
        // USA: Höhere Thresholds
        if (cape < 300 || srh < 80 || shear < 10) return 0;
        const effectiveShear = Math.min(shear / 15, 1.5);
        const effectiveSRH = Math.min(srh / 150, 1.5);
        const effectiveCAPE = Math.min(cape / 1500, 1.5);
        const liFactor = liftedIndex < -2 ? 1.2 : liftedIndex < 0 ? 1.0 : 0.8;
        const cinFactor = cin < 50 ? 1.0 : cin < 100 ? 0.8 : 0.6;
        return effectiveCAPE * effectiveSRH * effectiveShear * liFactor * cinFactor;
    } else {
        // Europa: Niedrigere Thresholds - auch bei niedrigem CAPE möglich
        if (cape < 100 || srh < 40 || shear < 6) return 0;
        const effectiveShear = Math.min(shear / 12, 1.5);
        const effectiveSRH = Math.min(srh / 100, 1.5);
        const effectiveCAPE = Math.min(cape / 1200, 1.5);
        const liFactor = liftedIndex < -2 ? 1.2 : liftedIndex < 0 ? 1.0 : 0.8;
        const cinFactor = cin < 50 ? 1.0 : cin < 100 ? 0.8 : 0.6;
        return effectiveCAPE * effectiveSRH * effectiveShear * liFactor * cinFactor;
    }
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

// Hauptfunktion für Wahrscheinlichkeitsberechnung (optimiert und kompakt)
function calculateProbability(hour, region = 'europe') {
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0;
    const cape = Math.max(0, hour.cape ?? 0);
    const cin = Math.abs(hour.cin ?? 0);
    const precipAcc = hour.precipAcc ?? 0;
    const precipProb = hour.precip ?? 0;
    
    // Regionsspezifische Filter für Fehlalarme
    if (region === 'usa') {
        // USA: Höhere Thresholds
        if (temp2m < 10) return 0; // Zu kalt für Gewitter
        if (temp2m < 15 && cape < 1500) return 0; // Kalt und keine hohe Instabilität
        if (cape < 500 && precipAcc < 0.2 && precipProb < 20) return 0; // Keine Instabilität und kein Niederschlag
    } else {
        // Europa: Niedrigere Thresholds
        if (temp2m < 5) return 0; // Zu kalt für Gewitter
        if (temp2m < 10 && cape < 1000) return 0; // Kalt und keine hohe Instabilität
        if (cape < 200 && precipAcc < 0.2 && precipProb < 20) return 0; // Keine Instabilität und kein Niederschlag
    }
    
    // Berechne Indizes
    const shear = calcShear(hour);
    const srh = calcSRH(hour);
    const { kIndex, showalter, lapse, liftedIndex } = calcIndices(hour);
    const relHum2m = calcRelHum(temp2m, dew);
    const cloudSum = (hour.cloudLow ?? 0) + (hour.cloudMid ?? 0) + (hour.cloudHigh ?? 0);
    
    // Kombinierte Indizes (bewährte meteorologische Parameter)
    const ehi = (cape * srh) / 160000;
    const scp = calcSCP(cape, shear, srh, cin, region);
    const stp = calcSTP(cape, srh, shear, liftedIndex, cin, region);
    
    // Basis-Score basierend auf kombinierten Indizes (regionsspezifisch)
    let score = 0;
    
    // CAPE-Bewertung (regionsspezifisch)
    if (region === 'usa') {
        if (cape >= 2500) score += 30;
        else if (cape >= 2000) score += 25;
        else if (cape >= 1500) score += 20;
        else if (cape >= 1000) score += 14;
        else if (cape >= 800) score += 10;
        else if (cape >= 600) score += 6;
        else if (cape >= 500) score += 3;
    } else {
        // Europa: Niedrigere Thresholds
        if (cape >= 1500) score += 25;
        else if (cape >= 1200) score += 20;
        else if (cape >= 800) score += 14;
        else if (cape >= 500) score += 8;
        else if (cape >= 400) score += 6;
        else if (cape >= 300) score += 4;
        else if (cape >= 200) score += 2;
    }
    
    // CIN-Penalty (stärker gewichtet)
    if (cin > 200) score -= 15;
    else if (cin > 100) score -= 8;
    else if (cin > 50) score -= 4;
    
    // Kombinierte Indizes (regionsspezifisch)
    if (region === 'usa') {
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
        // Europa: Niedrigere Thresholds
        if (scp > 2) score += 20;
        else if (scp > 1.5) score += 16;
        else if (scp > 1) score += 10;
        else if (scp > 0.5) score += 5;
        
        if (stp > 1.5) score += 15;
        else if (stp > 1) score += 12;
        else if (stp > 0.5) score += 7;
        else if (stp > 0.3) score += 3;
        
        if (ehi > 2) score += 12;
        else if (ehi > 1.5) score += 9;
        else if (ehi > 1) score += 6;
        else if (ehi > 0.5) score += 3;
    }
    
    // Shear und SRH (regionsspezifisch)
    if (region === 'usa') {
        if (cape >= 800) {
            if (shear >= 25) score += 12;
            else if (shear >= 20) score += 10;
            else if (shear >= 15) score += 7;
            else if (shear >= 12) score += 4;
            
            if (srh >= 250) score += 10;
            else if (srh >= 200) score += 8;
            else if (srh >= 150) score += 6;
            else if (srh >= 120) score += 4;
        } else if (cape >= 500) {
            if (shear >= 20) score += 5;
            else if (shear >= 15) score += 3;
            
            if (srh >= 200) score += 4;
            else if (srh >= 150) score += 2;
        }
    } else {
        // Europa: Niedrigere Thresholds
        if (cape >= 500) {
            if (shear >= 20) score += 10;
            else if (shear >= 15) score += 7;
            else if (shear >= 10) score += 4;
            else if (shear >= 8) score += 2;
            
            if (srh >= 200) score += 8;
            else if (srh >= 150) score += 6;
            else if (srh >= 120) score += 4;
            else if (srh >= 80) score += 2;
        } else if (cape >= 200) {
            // Europa: Auch bei niedrigem CAPE können Shear/SRH relevant sein
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
    if (region === 'usa') {
        if (hour.directRadiation >= 600 && temp2m >= 18 && cape >= 600) score += 5;
        else if (hour.directRadiation >= 400 && temp2m >= 15 && cape >= 500) score += 3;
        else if (hour.directRadiation < 50 && cape < 1000) score -= 7;
    } else {
        if (hour.directRadiation >= 500 && temp2m >= 15 && cape >= 500) score += 4;
        else if (hour.directRadiation >= 300 && temp2m >= 12 && cape >= 300) score += 2;
        else if (hour.directRadiation < 50 && cape < 800) score -= 6;
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
    
    // Ensemble-Daten (falls verfügbar, regionsspezifisch)
    if (hour.ensemble) {
        const MIN_PROB = 0.6;
        
        if (region === 'usa') {
            const capeProb = getEnsembleProb(hour.ensemble, 'cape', 800, 'above');
            if (capeProb !== null && capeProb >= MIN_PROB) {
                score += Math.round(10 * capeProb);
            }
            
            const liProb = getEnsembleProb(hour.ensemble, 'lifted_index', -3, 'below');
            if (liProb !== null && liProb >= MIN_PROB && cape >= 600) {
                score += Math.round(5 * liProb);
            }
            
            const precipProb = getEnsembleProb(hour.ensemble, 'precipitation', 1, 'above');
            if (precipProb !== null && precipProb >= MIN_PROB && cape >= 600) {
                score += Math.round(4 * precipProb);
            }
        } else {
            // Europa: Niedrigere Thresholds
            const capeProb = getEnsembleProb(hour.ensemble, 'cape', 600, 'above');
            if (capeProb !== null && capeProb >= MIN_PROB) {
                score += Math.round(8 * capeProb);
            }
            
            const liProb = getEnsembleProb(hour.ensemble, 'lifted_index', -3, 'below');
            if (liProb !== null && liProb >= MIN_PROB && cape >= 400) {
                score += Math.round(4 * liProb);
            }
            
            const precipProb = getEnsembleProb(hour.ensemble, 'precipitation', 1, 'above');
            if (precipProb !== null && precipProb >= MIN_PROB && cape >= 400) {
                score += Math.round(3 * precipProb);
            }
        }
    }
    
    // Temperatur-Reduktion (kälter = weniger wahrscheinlich, regionsspezifisch)
    if (region === 'usa') {
        if (temp2m < 15) score = Math.round(score * 0.5);
        else if (temp2m < 18) score = Math.round(score * 0.7);
    } else {
        if (temp2m < 12) score = Math.round(score * 0.5);
        else if (temp2m < 15) score = Math.round(score * 0.7);
    }
    
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
    const cape = Math.max(0, hour.cape ?? 0);
    const cin = Math.abs(hour.cin ?? 0);
    const { liftedIndex } = calcIndices(hour);
    
    // Basis-Filter: Zu kalt oder keine Instabilität = kein Tornado (regionsspezifisch)
    if (region === 'usa') {
        if (temp2m < 12) return 0; // Zu kalt
        if (cape < 500) return 0; // USA: Höhere Schwelle
        if (cin > 200) return 0; // Zu viel CIN
    } else {
        if (temp2m < 8) return 0; // Zu kalt
        if (cape < 400) return 0; // Europa: Niedrigere Schwelle
        if (cin > 200) return 0; // Zu viel CIN
    }
    
    // STP berechnen (regionsspezifisch)
    const stp = calcSTP(cape, srh, shear, liftedIndex, cin, region);
    
    // Basis-Score für Tornado-Wahrscheinlichkeit
    let score = 0;
    
    // STP ist der Hauptindikator für Tornado-Potential (regionsspezifisch)
    if (region === 'usa') {
        if (stp >= 3.0) score = 95; // Sehr hohes Risiko
        else if (stp >= 2.0) score = 85;
        else if (stp >= 1.5) score = 70;
        else if (stp >= 1.0) score = 55;
        else if (stp >= 0.7) score = 40;
        else if (stp >= 0.5) score = 25;
        else if (stp >= 0.3) score = 12;
        else if (stp > 0) score = 5;
    } else {
        if (stp >= 2.0) score = 85; // Sehr hohes Risiko (Europa: selten)
        else if (stp >= 1.5) score = 70;
        else if (stp >= 1.0) score = 55;
        else if (stp >= 0.7) score = 40;
        else if (stp >= 0.5) score = 25;
        else if (stp >= 0.3) score = 12;
        else if (stp > 0) score = 5;
    }
    
    // Zusätzliche Faktoren (regionsspezifisch)
    if (region === 'usa') {
        // CAPE + Shear Kombination (USA: höhere Werte)
        if (cape >= 1500 && shear >= 25) score += 10;
        else if (cape >= 1200 && shear >= 20) score += 8;
        else if (cape >= 1000 && shear >= 18) score += 6;
        else if (cape >= 800 && shear >= 15) score += 4;
        
        // SRH ist wichtig für Tornado-Entwicklung
        if (srh >= 250 && cape >= 1200) score += 8;
        else if (srh >= 200 && cape >= 1000) score += 6;
        else if (srh >= 150 && cape >= 800) score += 4;
        else if (srh >= 120 && cape >= 600) score += 2;
        
        // Lifted Index
        if (liftedIndex <= -6 && cape >= 1200) score += 6;
        else if (liftedIndex <= -5 && cape >= 1000) score += 5;
        else if (liftedIndex <= -3 && cape >= 800) score += 3;
        
        // EHI (Energy Helicity Index)
        const ehi = (cape * srh) / 160000;
        if (ehi >= 3.5) score += 10;
        else if (ehi >= 2.5) score += 8;
        else if (ehi >= 1.5) score += 5;
        else if (ehi >= 1.0) score += 3;
        
        // Reduktionen
        if (cin > 100) score -= 10;
        if (shear < 12) score -= 15; // USA: höhere Schwelle
        if (srh < 100) score -= 10; // USA: höhere Schwelle
    } else {
        // Europa: Niedrigere Werte
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
        
        // Reduktionen
        if (cin > 100) score -= 10;
        if (shear < 10) score -= 15;
        if (srh < 80) score -= 10;
    }
    
    // Temperatur-Reduktion (regionsspezifisch)
    if (region === 'usa') {
        if (temp2m < 15) score = Math.round(score * 0.6);
        else if (temp2m < 18) score = Math.round(score * 0.8);
    } else {
        if (temp2m < 12) score = Math.round(score * 0.6);
        else if (temp2m < 15) score = Math.round(score * 0.8);
    }
    
    // Mindestanforderungen (regionsspezifisch, reduziert Fehlalarme)
    if (region === 'usa') {
        if (score > 0 && cape < 500) score = Math.max(0, score - 20);
        if (score > 0 && shear < 10) score = Math.max(0, score - 25);
        if (score > 0 && srh < 80) score = Math.max(0, score - 20);
    } else {
        if (score > 0 && cape < 400) score = Math.max(0, score - 20);
        if (score > 0 && shear < 8) score = Math.max(0, score - 25);
        if (score > 0 && srh < 60) score = Math.max(0, score - 20);
    }
    
    return Math.min(100, Math.max(0, Math.round(score)));
}
