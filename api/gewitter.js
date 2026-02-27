export default async function handler(req, res) {
    // CORS Headers setzen - origin * erlauben
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // OPTIONS Request für CORS Preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Nur GET erlauben
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Query-Parameter extrahieren
    const { lat, lon } = req.query;

    // Validierung
    if (!lat || !lon) {
        return res.status(400).json({ error: 'lat und lon Parameter sind erforderlich' });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    if (isNaN(latitude) || isNaN(longitude)) {
        return res.status(400).json({ error: 'Ungültige Koordinaten' });
    }

    try {
        // Wetterdaten von Open-Meteo abrufen (normaler Forecast)
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=wind_gusts_10m,wind_speed_10m,temperature_2m,dew_point_2m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_speed_1000hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
                    `relative_humidity_500hPa,cape,convective_inhibition,lifted_index,` +
                    `dew_point_850hPa,dew_point_700hPa,boundary_layer_height,direct_radiation,` +
                    `precipitation&forecast_days=14&models=best_match&timezone=auto`;

        // Ensemble-Daten von Open-Meteo abrufen (mit Percentilen für Wahrscheinlichkeitsberechnung)
        const ensembleUrl = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=temperature_2m,dew_point_2m,wind_gusts_10m,wind_speed_10m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_speed_1000hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
                    `relative_humidity_500hPa,cape,convective_inhibition,lifted_index,` +
                    `dew_point_850hPa,dew_point_700hPa,boundary_layer_height,direct_radiation,` +
                    `precipitation&forecast_days=14&models=best_match&timezone=auto`;

        // Beide API-Calls parallel ausführen
        const [response, ensembleResponse] = await Promise.all([
            fetch(url),
            fetch(ensembleUrl).catch(err => {
                // Ensemble-Daten sind optional, Fehler werden ignoriert
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

        // Zeitzone extrahieren
        const timezone = data.timezone || 'UTC';

        // Ensemble-Daten verarbeiten (falls verfügbar)
        const hasEnsemble = ensembleData && !ensembleData.error && ensembleData?.hourly?.time?.length;

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

            // Ensemble-Daten hinzufügen (falls verfügbar)
            if (hasEnsemble && ensembleData.hourly.time[i] === t) {
                // Ensemble-Mittelwerte und Unsicherheiten hinzufügen
                // Open-Meteo Ensemble-API gibt Daten als Objekte mit mean, min, max, etc. zurück
                const getEnsembleValue = (param, type = 'mean') => {
                    const paramData = ensembleData.hourly[param];
                    if (!paramData) return null;
                    // Prüfe ob es ein Objekt mit mean/min/max ist oder ein Array
                    if (typeof paramData === 'object' && !Array.isArray(paramData)) {
                        return paramData[type]?.[i] ?? null;
                    }
                    return null;
                };

                baseData.ensemble = {
                    // Oberflächenvariablen
                    temperature_mean: getEnsembleValue('temperature_2m', 'mean') ?? baseData.temperature,
                    temperature_min: getEnsembleValue('temperature_2m', 'min'),
                    temperature_max: getEnsembleValue('temperature_2m', 'max'),
                    dew_point_mean: getEnsembleValue('dew_point_2m', 'mean') ?? baseData.dew,
                    dew_point_min: getEnsembleValue('dew_point_2m', 'min'),
                    dew_point_max: getEnsembleValue('dew_point_2m', 'max'),
                    wind_speed_mean: getEnsembleValue('wind_speed_10m', 'mean') ?? baseData.wind,
                    wind_speed_min: getEnsembleValue('wind_speed_10m', 'min'),
                    wind_speed_max: getEnsembleValue('wind_speed_10m', 'max'),
                    wind_gusts_mean: getEnsembleValue('wind_gusts_10m', 'mean') ?? baseData.gust,
                    wind_gusts_min: getEnsembleValue('wind_gusts_10m', 'min'),
                    wind_gusts_max: getEnsembleValue('wind_gusts_10m', 'max'),
                    precipitation_probability_mean: getEnsembleValue('precipitation_probability', 'mean') ?? baseData.precip,
                    precipitation_probability_min: getEnsembleValue('precipitation_probability', 'min'),
                    precipitation_probability_max: getEnsembleValue('precipitation_probability', 'max'),
                    precipitation_mean: getEnsembleValue('precipitation', 'mean') ?? baseData.precipAcc,
                    precipitation_min: getEnsembleValue('precipitation', 'min'),
                    precipitation_max: getEnsembleValue('precipitation', 'max'),
                    direct_radiation_mean: getEnsembleValue('direct_radiation', 'mean') ?? baseData.directRadiation,
                    direct_radiation_min: getEnsembleValue('direct_radiation', 'min'),
                    direct_radiation_max: getEnsembleValue('direct_radiation', 'max'),
                    boundary_layer_height_mean: getEnsembleValue('boundary_layer_height', 'mean') ?? baseData.pblHeight,
                    boundary_layer_height_min: getEnsembleValue('boundary_layer_height', 'min'),
                    boundary_layer_height_max: getEnsembleValue('boundary_layer_height', 'max'),
                    // Höhenlagen
                    temperature_500hPa_mean: getEnsembleValue('temperature_500hPa', 'mean') ?? baseData.temp500,
                    temperature_500hPa_min: getEnsembleValue('temperature_500hPa', 'min'),
                    temperature_500hPa_max: getEnsembleValue('temperature_500hPa', 'max'),
                    temperature_700hPa_mean: getEnsembleValue('temperature_700hPa', 'mean') ?? baseData.temp700,
                    temperature_700hPa_min: getEnsembleValue('temperature_700hPa', 'min'),
                    temperature_700hPa_max: getEnsembleValue('temperature_700hPa', 'max'),
                    temperature_850hPa_mean: getEnsembleValue('temperature_850hPa', 'mean') ?? baseData.temp850,
                    temperature_850hPa_min: getEnsembleValue('temperature_850hPa', 'min'),
                    temperature_850hPa_max: getEnsembleValue('temperature_850hPa', 'max'),
                    wind_speed_300hPa_mean: getEnsembleValue('wind_speed_300hPa', 'mean') ?? baseData.wind_speed_300hPa,
                    wind_speed_300hPa_min: getEnsembleValue('wind_speed_300hPa', 'min'),
                    wind_speed_300hPa_max: getEnsembleValue('wind_speed_300hPa', 'max'),
                    wind_speed_500hPa_mean: getEnsembleValue('wind_speed_500hPa', 'mean') ?? baseData.wind_speed_500hPa,
                    wind_speed_500hPa_min: getEnsembleValue('wind_speed_500hPa', 'min'),
                    wind_speed_500hPa_max: getEnsembleValue('wind_speed_500hPa', 'max'),
                    wind_speed_700hPa_mean: getEnsembleValue('wind_speed_700hPa', 'mean') ?? baseData.wind_speed_700hPa,
                    wind_speed_700hPa_min: getEnsembleValue('wind_speed_700hPa', 'min'),
                    wind_speed_700hPa_max: getEnsembleValue('wind_speed_700hPa', 'max'),
                    wind_speed_850hPa_mean: getEnsembleValue('wind_speed_850hPa', 'mean') ?? baseData.wind_speed_850hPa,
                    wind_speed_850hPa_min: getEnsembleValue('wind_speed_850hPa', 'min'),
                    wind_speed_850hPa_max: getEnsembleValue('wind_speed_850hPa', 'max'),
                    wind_speed_1000hPa_mean: getEnsembleValue('wind_speed_1000hPa', 'mean') ?? baseData.wind_speed_1000hPa,
                    wind_speed_1000hPa_min: getEnsembleValue('wind_speed_1000hPa', 'min'),
                    wind_speed_1000hPa_max: getEnsembleValue('wind_speed_1000hPa', 'max'),
                    relative_humidity_500hPa_mean: getEnsembleValue('relative_humidity_500hPa', 'mean') ?? baseData.rh500,
                    relative_humidity_500hPa_min: getEnsembleValue('relative_humidity_500hPa', 'min'),
                    relative_humidity_500hPa_max: getEnsembleValue('relative_humidity_500hPa', 'max'),
                    // Konvektions-Indizes
                    cape_mean: getEnsembleValue('cape', 'mean') ?? baseData.cape,
                    cape_min: getEnsembleValue('cape', 'min'),
                    cape_max: getEnsembleValue('cape', 'max'),
                    convective_inhibition_mean: getEnsembleValue('convective_inhibition', 'mean') ?? baseData.cin,
                    convective_inhibition_min: getEnsembleValue('convective_inhibition', 'min'),
                    convective_inhibition_max: getEnsembleValue('convective_inhibition', 'max'),
                    lifted_index_mean: getEnsembleValue('lifted_index', 'mean') ?? baseData.liftedIndex,
                    lifted_index_min: getEnsembleValue('lifted_index', 'min'),
                    lifted_index_max: getEnsembleValue('lifted_index', 'max'),
                };
            }

            return baseData;
        });

        // Aktuelle Zeit in der Zeitzone des Ortes berechnen
        const now = new Date();
        const currentTimeStr = now.toLocaleString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: timezone
        });
        const [datePart, timePart] = currentTimeStr.split(', ');
        const [month, day, year] = datePart.split('/');
        const [currentHour] = timePart.split(':').map(Number);
        const currentDateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

        // Nächste 6 Stunden filtern
        const next6Hours = hours
            .filter(h => {
                const [datePart, timePart] = h.time.split('T');
                const [hour] = timePart.split(':').map(Number);
                if (datePart === currentDateStr) {
                    return hour >= currentHour;
                }
                return datePart > currentDateStr;
            })
            .slice(0, 24)
            .map(hour => {
                const probability = calculateProbability(hour);
                return {
                    timestamp: hour.time,
                    probability: probability,
                    temperature: hour.temperature,
                    cape: hour.cape,
                    shear: calcShear(hour),
                    srh: calcSRH(hour)
                };
            });

        // Tage gruppieren und maximale Wahrscheinlichkeit pro Tag berechnen
        const daysMap = new Map();
        
        hours.forEach(h => {
            const [datePart] = h.time.split('T');
            const [year, month, day] = datePart.split('-').map(Number);
            
            // Heutige + 13 Tage
            if (datePart >= currentDateStr) {
                const probability = calculateProbability(h);
                
                if (!daysMap.has(datePart)) {
                    daysMap.set(datePart, {
                        date: datePart,
                        maxProbability: probability,
                        probabilities: [probability]
                    });
                } else {
                    const dayData = daysMap.get(datePart);
                    dayData.maxProbability = Math.max(dayData.maxProbability, probability);
                    dayData.probabilities.push(probability);
                }
            }
        });

        // Tage sortieren und formatieren
        const nextDays = Array.from(daysMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(day => ({
                date: day.date,
                probability: day.maxProbability
            }));

        return res.status(200).json({
            timezone: timezone,
            hours: next6Hours,
            days: nextDays,
            hasEnsemble: hasEnsemble
        });

    } catch (error) {
        console.error('Fehler:', error);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}

// Hilfsfunktionen aus der HTML-Datei

function angleDiff(a, b) {
    let d = Math.abs(a - b) % 360;
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
    const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
    const ws850 = (hour.wind_speed_850hPa ?? 0) / 3.6;
    const ws700 = (hour.wind_speed_700hPa ?? 0) / 3.6;

    const wd1000 = hour.windDir1000 ?? 0;
    const wd850 = hour.windDir850 ?? 0;
    const wd700 = hour.windDir700 ?? 0;

    const w1000 = windToUV(ws1000, wd1000);
    const w850 = windToUV(ws850, wd850);
    const w700 = windToUV(ws700, wd700);

    let sr = (w1000.u * (w850.v - w1000.v) - w1000.v * (w850.u - w1000.u)) * 1.5;
    sr += (w850.u * (w700.v - w850.v) - w850.v * (w700.u - w850.u)) * 1.5;

    const raw = Math.abs(sr);
    return Math.round(raw * 10) / 10;
}

function calcShear(hour) {
    const ws300 = (hour.wind_speed_300hPa ?? 0) / 3.6;
    const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
    return Math.hypot(ws300 - ws1000, 0);
}




// Thresholds für alle Parameter
const THRESHOLDS = {
    // Oberflächenvariablen
    temperature_2m: { min: 5, optimal: 15, high: 25 },
    dew_point_2m: { min: 10, optimal: 15, high: 20 },
    precipitation_probability: { low: 20, medium: 40, high: 60 },
    precipitation: { low: 0.5, medium: 1, high: 2, veryHigh: 5 },
    wind_speed_10m: { low: 2, optimal: 10, high: 20 },
    wind_gusts_10m: { low: 5, medium: 10, high: 20 },
    direct_radiation: { low: 50, medium: 200, high: 400, veryHigh: 600 },
    boundary_layer_height: { low: 500, medium: 1000, high: 1500 },
    
    // Höhenlagen
    temperature_500hPa: { low: -20, medium: -15, high: -10 },
    temperature_700hPa: { low: -5, medium: 0, high: 5 },
    temperature_850hPa: { low: 0, medium: 5, high: 10 },
    wind_speed_300hPa: { low: 20, medium: 30, high: 40 },
    wind_speed_500hPa: { low: 15, medium: 25, high: 35 },
    wind_speed_700hPa: { low: 10, medium: 20, high: 30 },
    wind_speed_850hPa: { low: 5, medium: 15, high: 25 },
    wind_speed_1000hPa: { low: 2, medium: 10, high: 20 },
    relative_humidity_500hPa: { low: 30, medium: 50, high: 80 },
    
    // Konvektions-Indizes
    cape: { low: 400, medium: 800, high: 1300, veryHigh: 1800 },
    convective_inhibition: { low: 0, medium: 75, high: 150 },
    lifted_index: { veryLow: -6, low: -4, medium: -2, high: 0 },
    shear: { low: 10, medium: 14, high: 22 },
    srh: { low: 100, medium: 150, high: 250 },
    kIndex: { low: 25, medium: 30, high: 35 },
    showalter: { veryLow: -4, low: -2, medium: 0 },
    lapse: { low: 5.0, medium: 6.5, high: 7.0, veryHigh: 7.5 },
};

function calcIndices(hour) {
    const temp500 = hour.temp500 ?? 0;
    const temp850 = hour.temp850 ?? 0;
    const temp700 = hour.temp700 ?? 0;
    const dew850 = hour.dew850 ?? 0;
    const dew700 = hour.dew700 ?? 0;
    const kIndex = temp850 - temp500 + dew850 - (temp700 - dew700);
    const showalter = temp500 - (temp850 - 9.8 * 1.5);
    const lapse = (temp850 - temp500) / 5.5;
    const liftedIndex = hour.liftedIndex ?? showalter;
    return { kIndex, showalter, lapse, liftedIndex };
}

// Berechnet die Wahrscheinlichkeit, dass ein Threshold erreicht wird, basierend auf Ensemble-Daten
// Gibt einen Wert zwischen 0 und 1 zurück (0 = kein Ensemble-Mitglied erreicht Threshold, 1 = alle erreichen Threshold)
function calculateEnsembleThresholdProbability(ensemble, param, thresholdValue, direction = 'above', minProbability = 0.5) {
    if (!ensemble) return null;
    
    const mean = ensemble[`${param}_mean`];
    const min = ensemble[`${param}_min`];
    const max = ensemble[`${param}_max`];
    
    // Wenn keine Daten verfügbar sind
    if (mean === null || mean === undefined) return null;
    
    if (direction === 'above') {
        // Prüfe wie viele Ensemble-Mitglieder über dem Threshold liegen
        if (min !== null && min !== undefined && min > thresholdValue) {
            // Alle Ensemble-Mitglieder sind über dem Threshold
            return 1.0;
        }
        if (max !== null && max !== undefined && max < thresholdValue) {
            // Kein Ensemble-Mitglied ist über dem Threshold
            return 0.0;
        }
        
        // Threshold liegt zwischen min und max
        // Schätze die Wahrscheinlichkeit basierend auf der Position des Thresholds
        // Annahme: Normalverteilung, Mean ist Median (50. Perzentil)
        if (min !== null && min !== undefined && max !== null && max !== undefined) {
            const range = max - min;
            if (range === 0) {
                // Keine Variation, alle Werte sind gleich
                return mean > thresholdValue ? 1.0 : 0.0;
            }
            
            // Lineare Interpolation: Wenn Threshold näher an min, weniger Mitglieder erreichen ihn
            // Wenn Threshold näher an max, mehr Mitglieder erreichen ihn
            // Wenn Threshold bei mean (50%), dann ~50% der Mitglieder erreichen ihn
            const position = (thresholdValue - min) / range;
            
            // Korrigiere basierend auf mean (wenn mean > threshold, dann mehr als 50%)
            if (mean > thresholdValue) {
                // Mean ist über Threshold, also mehr als 50% erreichen ihn
                const meanPosition = (mean - min) / range;
                // Schätze: Wenn mean bei 70% der Range ist und threshold bei 50%, dann ~70% erreichen ihn
                return Math.min(1.0, 0.5 + (meanPosition - position) * 1.5);
            } else {
                // Mean ist unter Threshold, also weniger als 50% erreichen ihn
                const meanPosition = (mean - min) / range;
                return Math.max(0.0, 0.5 - (position - meanPosition) * 1.5);
            }
        }
        
        // Fallback: Nur mean verfügbar
        return mean > thresholdValue ? 0.7 : 0.3;
    } else {
        // Prüfe wie viele Ensemble-Mitglieder unter dem Threshold liegen
        if (max !== null && max !== undefined && max < thresholdValue) {
            return 1.0; // Alle unter Threshold
        }
        if (min !== null && min !== undefined && min > thresholdValue) {
            return 0.0; // Keine unter Threshold
        }
        
        // Threshold liegt zwischen min und max
        if (min !== null && min !== undefined && max !== null && max !== undefined) {
            const range = max - min;
            if (range === 0) {
                return mean < thresholdValue ? 1.0 : 0.0;
            }
            
            const position = (thresholdValue - min) / range;
            
            if (mean < thresholdValue) {
                const meanPosition = (mean - min) / range;
                return Math.min(1.0, 0.5 + (position - meanPosition) * 1.5);
            } else {
                const meanPosition = (mean - min) / range;
                return Math.max(0.0, 0.5 - (meanPosition - position) * 1.5);
            }
        }
        
        return mean < thresholdValue ? 0.7 : 0.3;
    }
}

function calculateProbability(hour) {
    const shear = calcShear(hour);
    const srh = calcSRH(hour);
    const { kIndex, showalter, lapse, liftedIndex } = calcIndices(hour);
    const dew = hour.dew ?? 0;
    const cape = hour.cape ?? 0;
    const cin = Math.abs(hour.cin ?? 0);
    const precipProb = hour.precip ?? 0;
    const dirChange = angleDiff(hour.windDir1000 ?? 0, hour.windDir500 ?? 0) +
        angleDiff(hour.windDir500 ?? 0, hour.windDir300 ?? 0);
    const rh500 = hour.rh500 ?? 0;
    const directRadiation = hour.directRadiation ?? 0;
    const cloudSum = (hour.cloudLow ?? 0) + (hour.cloudMid ?? 0) + (hour.cloudHigh ?? 0);
    const windSpeed10m = hour.wind ?? 0;
    const windGust10m = hour.gust ?? 0;
    const pblHeight = hour.pblHeight ?? 0;
    const temp2m = hour.temperature ?? 0;
    const relHum2m = calcRelHum(temp2m, dew);
    const precipAcc = hour.precipAcc ?? 0;
    
    // Ensemble-Daten (falls verfügbar)
    const ensemble = hour.ensemble;

    // Winterfilter: Bei sehr niedrigen Temperaturen ist Gewitter praktisch unmöglich
    if (temp2m < 0) return 0;
    if (temp2m < 5) return Math.min(5, Math.round(cape / 200));
    if (temp2m < 10) {
        if (cape < 1500) return 0;
    }

    // Filter für harmlose Labilität ohne Niederschlag: Wenn KEIN Niederschlagssignal vorhanden ist
    // UND keine hohe Instabilität, dann ist Gewitter sehr unwahrscheinlich
    const hasNoPrecipitation = precipAcc <= 0.1 && precipProb < 20;
    const hasLowInstability = cape < 800 && liftedIndex > -2;
    
    if (hasNoPrecipitation && hasLowInstability) {
        // Harmlose Labilität ohne Niederschlag = sehr unwahrscheinlich für Gewitter
        return 0;
    }

    let score = 0;

    // Höhere Schwellenwerte für relevante Gewitterindikatoren
    if (cape > 1800) score += 28; else if (cape > 1300) score += 20; else if (cape > 800) score += 12; else if (cape > 400) score += 5;
    if (cin > 150) score -= 12; else if (cin > 75) score -= 6;
    if (kIndex > 35) score += 8; else if (kIndex > 30) score += 5; else if (kIndex > 25) score += 3;
    if (liftedIndex < -6) score += 15; else if (liftedIndex < -4) score += 10; else if (liftedIndex < -2) score += 5;
    
    // Showalter Index: Negativ = instabil, sehr negativ = stark instabil
    if (showalter < -4) score += 8; else if (showalter < -2) score += 5; else if (showalter < 0) score += 2;
    
    // Lapse Rate (Temperaturabnahme mit Höhe): Steilere Lapse Rates = stärkere Instabilität
    // > 7 °C/km = sehr instabil, > 6.5 °C/km = instabil (trocken-adiabatisch)
    if (lapse > 7.5) score += 6; else if (lapse > 7.0) score += 4; else if (lapse > 6.5) score += 2;
    if (lapse < 5.0 && cape < 1000) score -= 3; // Sehr flache Lapse Rate bei niedrigem CAPE = stabil
    
    if (shear > 22) score += 12; else if (shear > 14) score += 6;
    if (srh > 250) score += 10; else if (srh > 150) score += 5;
    
    // EHI (Energy Helicity Index): Kombiniert CAPE und SRH für bessere Vorhersage schwerer Gewitter
    // EHI = (CAPE × SRH) / 160000
    const ehi = (cape * srh) / 160000;
    if (ehi > 2) score += 8; // Sehr hoher EHI = hohes Risiko für schwere Gewitter
    else if (ehi > 1) score += 5; // Hoher EHI = erhöhtes Risiko für schwere Gewitter
    
    if (dew > 15 && temp2m > 15) score += 5;
    if (relHum2m > 60 && temp2m > 20) score += 5;
    if (precipProb > 60 && temp2m > 12) score += 5;
    if (precipAcc > 1 && cloudSum > 70 && cape > 700) score += 4;
    if (precipAcc > 0.5 && cape > 500) score += 3;
    if (precipAcc > 2 && cape > 800) score += 5;
    if (precipAcc > 5 && cape > 1200) score += 8;
    // Viel Regen aber kaum CAPE = eher Dauerregen → Gewitter unwahrscheinlicher
    if (precipAcc > 3 && cape < 400) score -= 5;
    if (dirChange > 90) score += 3;
    if (pblHeight > 1500 && temp2m > 15) score += 2;
    if (cloudSum > 90 && cape < 1000) score -= 4;

    // rh500 (relative Luftfeuchtigkeit auf 500 hPa): Niedrige Werte begünstigen stärkere Gewitter
    // Trockene Luft in der mittleren Troposphäre verstärkt Verdunstungskühlung
    if (rh500 < 30 && cape > 1000) score += 6; // Sehr trockene mittlere Troposphäre bei hohem CAPE
    else if (rh500 < 40 && cape > 800) score += 4; // Trockene mittlere Troposphäre
    else if (rh500 < 50 && cape > 600) score += 2; // Mäßig trockene mittlere Troposphäre
    if (rh500 > 80 && cape < 1000) score -= 3; // Sehr feuchte mittlere Troposphäre bei niedrigem CAPE = weniger günstig

    // directRadiation (direkte Sonnenstrahlung in W/m²): Erwärmt Oberfläche und erhöht Instabilität
    // Hohe Strahlung tagsüber begünstigt Konvektion
    if (directRadiation > 600 && temp2m > 15 && cape > 500) score += 5; // Sehr hohe Strahlung bei günstigen Bedingungen
    else if (directRadiation > 400 && temp2m > 12 && cape > 300) score += 3; // Hohe Strahlung
    else if (directRadiation > 200 && temp2m > 10) score += 1; // Moderate Strahlung
    if (directRadiation < 50 && cape < 800) score -= 6; // Sehr niedrige Strahlung (Nacht) reduziert Gewitterwahrscheinlichkeit

    // windSpeed10m (Windgeschwindigkeit in 10m Höhe): Moderate Winde sind günstig
    // Zu starke Winde können Konvektion behindern, zu schwache deuten auf Stagnation
    if (windSpeed10m >= 5 && windSpeed10m <= 15 && temp2m > 12) score += 2; // Optimale Windgeschwindigkeit für Feuchtigkeitstransport
    if (windSpeed10m > 20 && cape < 2000) score -= 3; // Sehr starke Winde können Konvektion behindern
    if (windSpeed10m < 2 && temp2m > 15 && cape < 1500) score -= 2; // Sehr schwache Winde können auf Stagnation hinweisen

    // windGust10m (Windböen in 10m Höhe): Große Böen können auf Gewitteraktivität oder starke Konvektion hinweisen
    const gustDifference = windGust10m - windSpeed10m;
    if (gustDifference > 10 && cape > 800 && temp2m > 12) score += 4; // Große Böen bei günstigen Bedingungen = starke Turbulenzen/Konvektion
    else if (gustDifference > 7 && cape > 500) score += 2; // Moderate Böen
    if (windGust10m > 20 && cape > 1000 && temp2m > 15) score += 3; // Sehr starke Böen bei hohem CAPE = mögliche Gewitteraktivität

    // Zusätzliche Reduktion bei niedrigen Temperaturen (10-15°C)
    if (temp2m < 15) score = Math.round(score * 0.6);
    if (temp2m < 12) score = Math.round(score * 0.4);

    // Ensemble-Daten in die Wahrscheinlichkeit einfließen lassen
    // Für jeden Parameter wird berechnet, wie wahrscheinlich es ist, dass der Threshold erreicht wird
    // Nur wenn diese Wahrscheinlichkeit über einem bestimmten Wert liegt (z.B. 0.5 = 50%), fließt es ein
    if (ensemble) {
        const MIN_ENSEMBLE_PROBABILITY = 0.5; // Mindestwahrscheinlichkeit, dass Threshold erreicht wird (50%)
        
        // CAPE: Hohe Werte begünstigen Gewitter
        // Threshold: 400 J/kg (niedrig), 800 J/kg (mittel), 1300 J/kg (hoch), 1800 J/kg (sehr hoch)
        const capeProb400 = calculateEnsembleThresholdProbability(ensemble, 'cape', THRESHOLDS.cape.low, 'above', MIN_ENSEMBLE_PROBABILITY);
        const capeProb800 = calculateEnsembleThresholdProbability(ensemble, 'cape', THRESHOLDS.cape.medium, 'above', MIN_ENSEMBLE_PROBABILITY);
        const capeProb1300 = calculateEnsembleThresholdProbability(ensemble, 'cape', THRESHOLDS.cape.high, 'above', MIN_ENSEMBLE_PROBABILITY);
        const capeProb1800 = calculateEnsembleThresholdProbability(ensemble, 'cape', THRESHOLDS.cape.veryHigh, 'above', MIN_ENSEMBLE_PROBABILITY);
        
        if (capeProb1800 !== null && capeProb1800 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(8 * capeProb1800); // Sehr hohes CAPE
        } else if (capeProb1300 !== null && capeProb1300 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(6 * capeProb1300); // Hohes CAPE
        } else if (capeProb800 !== null && capeProb800 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(4 * capeProb800); // Mittleres CAPE
        } else if (capeProb400 !== null && capeProb400 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(2 * capeProb400); // Niedriges CAPE
        }
        
        // Niederschlag: Hohe Werte mit CAPE begünstigen Gewitter
        // Threshold: 0.5 mm (niedrig), 1 mm (mittel), 2 mm (hoch), 5 mm (sehr hoch)
        const precipProb05 = calculateEnsembleThresholdProbability(ensemble, 'precipitation', THRESHOLDS.precipitation.low, 'above', MIN_ENSEMBLE_PROBABILITY);
        const precipProb1 = calculateEnsembleThresholdProbability(ensemble, 'precipitation', THRESHOLDS.precipitation.medium, 'above', MIN_ENSEMBLE_PROBABILITY);
        const precipProb2 = calculateEnsembleThresholdProbability(ensemble, 'precipitation', THRESHOLDS.precipitation.high, 'above', MIN_ENSEMBLE_PROBABILITY);
        const precipProb5 = calculateEnsembleThresholdProbability(ensemble, 'precipitation', THRESHOLDS.precipitation.veryHigh, 'above', MIN_ENSEMBLE_PROBABILITY);
        
        // Nur wenn CAPE auch vorhanden ist
        if (capeProb400 !== null && capeProb400 >= MIN_ENSEMBLE_PROBABILITY) {
            if (precipProb5 !== null && precipProb5 >= MIN_ENSEMBLE_PROBABILITY) {
                score += Math.round(6 * precipProb5);
            } else if (precipProb2 !== null && precipProb2 >= MIN_ENSEMBLE_PROBABILITY) {
                score += Math.round(4 * precipProb2);
            } else if (precipProb1 !== null && precipProb1 >= MIN_ENSEMBLE_PROBABILITY) {
                score += Math.round(2 * precipProb1);
            } else if (precipProb05 !== null && precipProb05 >= MIN_ENSEMBLE_PROBABILITY) {
                score += Math.round(1 * precipProb05);
            }
        }
        
        // Niederschlagswahrscheinlichkeit: Hohe Werte begünstigen Gewitter
        // Threshold: 20% (niedrig), 40% (mittel), 60% (hoch)
        const precipProbProb20 = calculateEnsembleThresholdProbability(ensemble, 'precipitation_probability', THRESHOLDS.precipitation_probability.low, 'above', MIN_ENSEMBLE_PROBABILITY);
        const precipProbProb40 = calculateEnsembleThresholdProbability(ensemble, 'precipitation_probability', THRESHOLDS.precipitation_probability.medium, 'above', MIN_ENSEMBLE_PROBABILITY);
        const precipProbProb60 = calculateEnsembleThresholdProbability(ensemble, 'precipitation_probability', THRESHOLDS.precipitation_probability.high, 'above', MIN_ENSEMBLE_PROBABILITY);
        
        if (precipProbProb60 !== null && precipProbProb60 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(4 * precipProbProb60);
        } else if (precipProbProb40 !== null && precipProbProb40 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(2 * precipProbProb40);
        } else if (precipProbProb20 !== null && precipProbProb20 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(1 * precipProbProb20);
        }
        
        // Lifted Index: Niedrige Werte begünstigen Gewitter (unter Threshold)
        // Threshold: -6°C (sehr niedrig), -4°C (niedrig), -2°C (mittel)
        const liProbMinus6 = calculateEnsembleThresholdProbability(ensemble, 'lifted_index', THRESHOLDS.lifted_index.veryLow, 'below', MIN_ENSEMBLE_PROBABILITY);
        const liProbMinus4 = calculateEnsembleThresholdProbability(ensemble, 'lifted_index', THRESHOLDS.lifted_index.low, 'below', MIN_ENSEMBLE_PROBABILITY);
        const liProbMinus2 = calculateEnsembleThresholdProbability(ensemble, 'lifted_index', THRESHOLDS.lifted_index.medium, 'below', MIN_ENSEMBLE_PROBABILITY);
        
        if (liProbMinus6 !== null && liProbMinus6 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(5 * liProbMinus6);
        } else if (liProbMinus4 !== null && liProbMinus4 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(3 * liProbMinus4);
        } else if (liProbMinus2 !== null && liProbMinus2 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(2 * liProbMinus2);
        }
        
        // CIN: Niedrige Werte begünstigen Gewitter (unter Threshold)
        // Threshold: 0 J/kg (niedrig), 75 J/kg (mittel), 150 J/kg (hoch)
        const cinProb0 = calculateEnsembleThresholdProbability(ensemble, 'convective_inhibition', THRESHOLDS.convective_inhibition.low, 'below', MIN_ENSEMBLE_PROBABILITY);
        const cinProb75 = calculateEnsembleThresholdProbability(ensemble, 'convective_inhibition', THRESHOLDS.convective_inhibition.medium, 'below', MIN_ENSEMBLE_PROBABILITY);
        const cinProb150 = calculateEnsembleThresholdProbability(ensemble, 'convective_inhibition', THRESHOLDS.convective_inhibition.high, 'below', MIN_ENSEMBLE_PROBABILITY);
        
        if (cinProb150 !== null && cinProb150 < MIN_ENSEMBLE_PROBABILITY) {
            // Hohe CIN-Werte reduzieren Wahrscheinlichkeit
            score -= Math.round(5 * (1 - cinProb150));
        } else if (cinProb75 !== null && cinProb75 < MIN_ENSEMBLE_PROBABILITY) {
            score -= Math.round(2 * (1 - cinProb75));
        }
        
        // Direkte Strahlung: Hohe Werte begünstigen Konvektion
        // Threshold: 50 W/m² (niedrig), 200 W/m² (mittel), 400 W/m² (hoch), 600 W/m² (sehr hoch)
        const radProb600 = calculateEnsembleThresholdProbability(ensemble, 'direct_radiation', THRESHOLDS.direct_radiation.veryHigh, 'above', MIN_ENSEMBLE_PROBABILITY);
        const radProb400 = calculateEnsembleThresholdProbability(ensemble, 'direct_radiation', THRESHOLDS.direct_radiation.high, 'above', MIN_ENSEMBLE_PROBABILITY);
        const radProb200 = calculateEnsembleThresholdProbability(ensemble, 'direct_radiation', THRESHOLDS.direct_radiation.medium, 'above', MIN_ENSEMBLE_PROBABILITY);
        
        if (radProb600 !== null && radProb600 >= MIN_ENSEMBLE_PROBABILITY && capeProb400 !== null && capeProb400 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(4 * radProb600);
        } else if (radProb400 !== null && radProb400 >= MIN_ENSEMBLE_PROBABILITY && capeProb400 !== null && capeProb400 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(2 * radProb400);
        } else if (radProb200 !== null && radProb200 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(1 * radProb200);
        }
        
        // Relative Feuchte 500hPa: Niedrige Werte begünstigen stärkere Gewitter (unter Threshold)
        // Threshold: 30% (niedrig), 50% (mittel), 80% (hoch)
        const rh500Prob30 = calculateEnsembleThresholdProbability(ensemble, 'relative_humidity_500hPa', THRESHOLDS.relative_humidity_500hPa.low, 'below', MIN_ENSEMBLE_PROBABILITY);
        const rh500Prob50 = calculateEnsembleThresholdProbability(ensemble, 'relative_humidity_500hPa', THRESHOLDS.relative_humidity_500hPa.medium, 'below', MIN_ENSEMBLE_PROBABILITY);
        
        if (rh500Prob30 !== null && rh500Prob30 >= MIN_ENSEMBLE_PROBABILITY && capeProb800 !== null && capeProb800 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(4 * rh500Prob30);
        } else if (rh500Prob50 !== null && rh500Prob50 >= MIN_ENSEMBLE_PROBABILITY && capeProb400 !== null && capeProb400 >= MIN_ENSEMBLE_PROBABILITY) {
            score += Math.round(2 * rh500Prob50);
        }
        
        // Temperatur: Optimale Werte begünstigen Gewitter
        // Threshold: 5°C (min), 15°C (optimal), 25°C (hoch)
        const tempProb5 = calculateEnsembleThresholdProbability(ensemble, 'temperature', THRESHOLDS.temperature_2m.min, 'above', MIN_ENSEMBLE_PROBABILITY);
        const tempProb15 = calculateEnsembleThresholdProbability(ensemble, 'temperature', THRESHOLDS.temperature_2m.optimal, 'above', MIN_ENSEMBLE_PROBABILITY);
        const tempProb25 = calculateEnsembleThresholdProbability(ensemble, 'temperature', THRESHOLDS.temperature_2m.high, 'above', MIN_ENSEMBLE_PROBABILITY);
        
        // Zu kalt reduziert Wahrscheinlichkeit
        if (tempProb5 !== null && tempProb5 < MIN_ENSEMBLE_PROBABILITY) {
            score -= Math.round(5 * (1 - tempProb5));
        } else if (tempProb15 !== null && tempProb15 >= MIN_ENSEMBLE_PROBABILITY && tempProb25 !== null && tempProb25 < 0.8) {
            // Optimale Temperatur (zwischen 15 und 25°C)
            score += Math.round(3 * tempProb15);
        }
    }

    return Math.min(100, Math.max(0, Math.round(score)));
}
