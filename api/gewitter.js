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

        // Ensemble-Daten von Open-Meteo abrufen
        const ensembleUrl = `https://api.open-meteo.com/v1/ensemble?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=wind_gusts_10m,wind_speed_10m,temperature_2m,dew_point_2m,` +
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

        // Deutsche Beschriftungen für alle Parameter
        const labels = {
            // Oberflächenvariablen
            temperature_2m: 'Temperatur (°C)',
            dew_point_2m: 'Taupunkt (°C)',
            precipitation_probability: 'Niederschlagswahrscheinlichkeit (%)',
            precipitation: 'Niederschlag gesamt (mm)',
            wind_speed_10m: 'Windgeschwindigkeit in 10 m (m/s oder km/h)',
            wind_gusts_10m: 'Windböen (m/s oder km/h)',
            cloud_cover_low: 'Wolkenbedeckung niedrig (%)',
            cloud_cover_mid: 'Wolkenbedeckung mittel (%)',
            cloud_cover_high: 'Wolkenbedeckung hoch (%)',
            direct_radiation: 'direkte Sonneneinstrahlung (W/m²)',
            boundary_layer_height: 'Höhe der Grenzschicht (m)',
            
            // Höhenlagen (500 hPa – 1000 hPa)
            temperature_500hPa: 'Temperatur in der Höhe 500 hPa (°C)',
            temperature_700hPa: 'Temperatur in der Höhe 700 hPa (°C)',
            temperature_850hPa: 'Temperatur in der Höhe 850 hPa (°C)',
            dew_point_700hPa: 'Taupunkt in der Höhe 700 hPa (°C)',
            dew_point_850hPa: 'Taupunkt in der Höhe 850 hPa (°C)',
            wind_speed_300hPa: 'Windgeschwindigkeit auf 300 hPa (m/s oder km/h)',
            wind_speed_500hPa: 'Windgeschwindigkeit auf 500 hPa (m/s oder km/h)',
            wind_speed_700hPa: 'Windgeschwindigkeit auf 700 hPa (m/s oder km/h)',
            wind_speed_850hPa: 'Windgeschwindigkeit auf 850 hPa (m/s oder km/h)',
            wind_speed_1000hPa: 'Windgeschwindigkeit auf 1000 hPa (m/s oder km/h)',
            wind_direction_300hPa: 'Windrichtung auf 300 hPa (°)',
            wind_direction_500hPa: 'Windrichtung auf 500 hPa (°)',
            wind_direction_700hPa: 'Windrichtung auf 700 hPa (°)',
            wind_direction_850hPa: 'Windrichtung auf 850 hPa (°)',
            wind_direction_1000hPa: 'Windrichtung auf 1000 hPa (°)',
            relative_humidity_500hPa: 'relative Feuchte auf 500 hPa (%)',
            
            // Konvektions-Indizes
            cape: 'Convective Available Potential Energy (J/kg)',
            convective_inhibition: 'CIN (J/kg)',
            lifted_index: 'LI (°C)',
            srh: 'Storm-Relative Helicity',
            showalter: 'Showalter Index',
            kIndex: 'K-Index',
        };

        return res.status(200).json({
            timezone: timezone,
            labels: labels,
            thresholds: THRESHOLDS,
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

// Hilfsfunktion: Prüft ob Ensemble-Werte über/unter Threshold liegen
function checkEnsembleThreshold(ensemble, param, thresholdKey, direction = 'above', thresholdLevel = 'high') {
    if (!ensemble || ensemble[`${param}_mean`] === null || ensemble[`${param}_mean`] === undefined) return null;
    
    const threshold = THRESHOLDS[thresholdKey];
    if (!threshold) return null;
    
    // Threshold-Wert bestimmen (kann high, medium, low, veryHigh, etc. sein)
    const thresholdValue = threshold[thresholdLevel];
    if (thresholdValue === undefined) {
        // Fallback: versuche andere Level
        if (threshold.high !== undefined) thresholdValue = threshold.high;
        else if (threshold.medium !== undefined) thresholdValue = threshold.medium;
        else if (threshold.low !== undefined) thresholdValue = threshold.low;
        else return null;
    }
    
    const mean = ensemble[`${param}_mean`];
    const min = ensemble[`${param}_min`];
    const max = ensemble[`${param}_max`];
    
    if (direction === 'above') {
        // Prüfe wie viele Ensemble-Mitglieder über dem Threshold liegen
        // Wenn Min über Threshold: alle über Threshold
        // Wenn Max unter Threshold: keine über Threshold
        // Sonst: teilweise über Threshold
        if (min !== null && min !== undefined && min > thresholdValue) return 1.0; // Alle über Threshold
        if (max !== null && max !== undefined && max < thresholdValue) return 0.0; // Keine über Threshold
        if (mean > thresholdValue) return 0.7; // Mittelwert über Threshold
        return 0.3; // Teilweise über Threshold
    } else {
        // Prüfe wie viele Ensemble-Mitglieder unter dem Threshold liegen
        if (max !== null && max !== undefined && max < thresholdValue) return 1.0; // Alle unter Threshold
        if (min !== null && min !== undefined && min > thresholdValue) return 0.0; // Keine unter Threshold
        if (mean < thresholdValue) return 0.7; // Mittelwert unter Threshold
        return 0.3; // Teilweise unter Threshold
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
    if (ensemble) {
        let ensembleBonus = 0;
        let ensembleMalus = 0;
        
        // CAPE: Hohe Werte begünstigen Gewitter
        const capeEnsemble = checkEnsembleThreshold(ensemble, 'cape', 'cape', 'above');
        if (capeEnsemble !== null) {
            if (ensemble.cape_mean > THRESHOLDS.cape.veryHigh) {
                ensembleBonus += Math.round(5 * capeEnsemble); // Bis zu +5 Punkte
            } else if (ensemble.cape_mean > THRESHOLDS.cape.high) {
                ensembleBonus += Math.round(3 * capeEnsemble); // Bis zu +3 Punkte
            } else if (ensemble.cape_mean < THRESHOLDS.cape.medium) {
                ensembleMalus += Math.round(3 * (1 - capeEnsemble)); // Bis zu -3 Punkte
            }
        }
        
        // Temperatur: Optimale Werte begünstigen Gewitter
        if (ensemble.temperature_mean !== null) {
            if (ensemble.temperature_mean > THRESHOLDS.temperature_2m.optimal && 
                ensemble.temperature_mean < THRESHOLDS.temperature_2m.high) {
                ensembleBonus += 2; // Optimale Temperatur
            } else if (ensemble.temperature_mean < THRESHOLDS.temperature_2m.min) {
                ensembleMalus += 5; // Zu kalt
            }
        }
        
        // Niederschlag: Hohe Werte mit CAPE begünstigen Gewitter
        const precipEnsemble = checkEnsembleThreshold(ensemble, 'precipitation', 'precipitation', 'above');
        if (precipEnsemble !== null && ensemble.cape_mean > THRESHOLDS.cape.medium) {
            if (ensemble.precipitation_mean > THRESHOLDS.precipitation.high) {
                ensembleBonus += Math.round(4 * precipEnsemble); // Bis zu +4 Punkte
            } else if (ensemble.precipitation_mean > THRESHOLDS.precipitation.medium) {
                ensembleBonus += Math.round(2 * precipEnsemble); // Bis zu +2 Punkte
            }
        }
        
        // Niederschlagswahrscheinlichkeit: Hohe Werte begünstigen Gewitter
        if (ensemble.precipitation_probability_mean !== null) {
            if (ensemble.precipitation_probability_mean > THRESHOLDS.precipitation_probability.high) {
                ensembleBonus += 3;
            } else if (ensemble.precipitation_probability_mean > THRESHOLDS.precipitation_probability.medium) {
                ensembleBonus += 1;
            }
        }
        
        // Lifted Index: Niedrige Werte begünstigen Gewitter
        if (ensemble.lifted_index_mean !== null) {
            if (ensemble.lifted_index_mean < THRESHOLDS.lifted_index.veryLow) {
                ensembleBonus += 4;
            } else if (ensemble.lifted_index_mean < THRESHOLDS.lifted_index.low) {
                ensembleBonus += 2;
            } else if (ensemble.lifted_index_mean > THRESHOLDS.lifted_index.high) {
                ensembleMalus += 3;
            }
        }
        
        // CIN: Niedrige Werte begünstigen Gewitter
        if (ensemble.convective_inhibition_mean !== null) {
            if (ensemble.convective_inhibition_mean > THRESHOLDS.convective_inhibition.high) {
                ensembleMalus += 5;
            } else if (ensemble.convective_inhibition_mean > THRESHOLDS.convective_inhibition.medium) {
                ensembleMalus += 2;
            }
        }
        
        // Direkte Strahlung: Hohe Werte begünstigen Konvektion
        if (ensemble.direct_radiation_mean !== null) {
            if (ensemble.direct_radiation_mean > THRESHOLDS.direct_radiation.veryHigh) {
                ensembleBonus += 3;
            } else if (ensemble.direct_radiation_mean > THRESHOLDS.direct_radiation.high) {
                ensembleBonus += 1;
            } else if (ensemble.direct_radiation_mean < THRESHOLDS.direct_radiation.low && 
                       ensemble.cape_mean < THRESHOLDS.cape.medium) {
                ensembleMalus += 3; // Niedrige Strahlung bei niedrigem CAPE
            }
        }
        
        // Relative Feuchte 500hPa: Niedrige Werte begünstigen stärkere Gewitter
        if (ensemble.relative_humidity_500hPa_mean !== null) {
            if (ensemble.relative_humidity_500hPa_mean < THRESHOLDS.relative_humidity_500hPa.low && 
                ensemble.cape_mean > THRESHOLDS.cape.high) {
                ensembleBonus += 3;
            } else if (ensemble.relative_humidity_500hPa_mean > THRESHOLDS.relative_humidity_500hPa.high && 
                       ensemble.cape_mean < THRESHOLDS.cape.high) {
                ensembleMalus += 2;
            }
        }
        
        // Ensemble-Unsicherheit: Große Spannweite (max - min) reduziert Vertrauen
        let uncertaintyFactor = 1.0;
        if (ensemble.cape_min !== null && ensemble.cape_max !== null) {
            const capeRange = ensemble.cape_max - ensemble.cape_min;
            if (capeRange > 2000) {
                uncertaintyFactor = 0.8; // Große Unsicherheit
            } else if (capeRange > 1000) {
                uncertaintyFactor = 0.9; // Mittlere Unsicherheit
            }
        }
        
        // Ensemble-Bonus/Malus anwenden
        score += ensembleBonus;
        score -= ensembleMalus;
        score = Math.round(score * uncertaintyFactor);
    }

    return Math.min(100, Math.max(0, Math.round(score)));
}
