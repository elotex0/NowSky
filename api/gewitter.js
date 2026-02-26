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
        // Wetterdaten von Open-Meteo abrufen
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=wind_gusts_10m,wind_speed_10m,temperature_2m,dew_point_2m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_speed_1000hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
                    `relative_humidity_500hPa,cape,convective_inhibition,lifted_index,` +
                    `dew_point_850hPa,dew_point_700hPa,boundary_layer_height,direct_radiation,` +
                    `precipitation,visibility&forecast_days=14&models=best_match&timezone=auto`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            return res.status(500).json({ error: 'API-Fehler: ' + (data.reason || data.error.message || 'Unbekannt') });
        }

        if (!data?.hourly?.time?.length) {
            return res.status(500).json({ error: 'Keine Daten verfügbar' });
        }

        // Zeitzone extrahieren
        const timezone = data.timezone || 'UTC';

        // Stunden-Daten verarbeiten
        const hours = data.hourly.time.map((t, i) => ({
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
            visibility: data.hourly.visibility?.[i] ?? 0
        }));

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
                    srh: calcSRH(hour),
                    ehi: calcEHI(hour),
                    kIndex: calcKIndex(hour),
                    showalter: calcShowalter(hour),
                    lapse: calcLapse(hour),
                    liftedIndex: calcLiftedIndex(hour),
                    pblHeight: calcPBLHeight(hour),
                    directRadiation: calcDirectRadiation(hour),
                    precipAcc: calcPrecipAcc(hour),
                    visibility: calcVisibility(hour)
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
            days: nextDays
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

function calcEHI(hour) {
    const cape = hour.cape ?? 0;
    const srh = calcSRH(hour);
    const ehi = (cape * srh) / 160000;
    return Math.round(ehi * 100) / 100; // Auf 2 Dezimalstellen gerundet
}

function calcKIndex(hour) {
    const temp500 = hour.temp500 ?? 0;
    const temp850 = hour.temp850 ?? 0;
    const temp700 = hour.temp700 ?? 0;
    const dew850 = hour.dew850 ?? 0;
    const dew700 = hour.dew700 ?? 0;
    return temp850 - temp500 + dew850 - (temp700 - dew700);
}

function calcShowalter(hour) {
    const temp500 = hour.temp500 ?? 0;
    const temp850 = hour.temp850 ?? 0;
    return temp500 - (temp850 - 9.8 * 1.5);
}

function calcLapse(hour) {
    const temp500 = hour.temp500 ?? 0;
    const temp850 = hour.temp850 ?? 0;
    return (temp850 - temp500) / 5.5;
}

function calcLiftedIndex(hour) {
    const showalter = calcShowalter(hour);
    return hour.liftedIndex ?? showalter;
}

function calcPBLHeight(hour) {
    return hour.pblHeight ?? 0;
}

function calcDirectRadiation(hour) {
    return hour.directRadiation ?? 0;
}

function calcPrecipAcc(hour) {
    return hour.precipAcc ?? 0;
}

function calcVisibility(hour) {
    return hour.visibility ?? 0;
}

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
    const visibility = hour.visibility ?? 0;

    // Winterfilter: Bei sehr niedrigen Temperaturen ist Gewitter praktisch unmöglich
    if (temp2m < 0) return 0;
    if (temp2m < 5) return Math.min(5, Math.round(cape / 200));
    if (temp2m < 10) {
        if (cape < 1500) return 0;
    }

    let score = 0;

    // Höhere Schwellenwerte für relevante Gewitterindikatoren
    if (cape > 2000) score += 30; else if (cape > 1500) score += 20; else if (cape > 1000) score += 12; else if (cape > 500) score += 5;
    if (cin > 200) score -= 15; else if (cin > 100) score -= 10; else if (cin > 50) score -= 5;
    if (kIndex > 35) score += 15; else if (kIndex > 30) score += 10; else if (kIndex > 25) score += 5;
    if (liftedIndex < -6) score += 15; else if (liftedIndex < -4) score += 10; else if (liftedIndex < -2) score += 5;
    if (shear > 25) score += 10; else if (shear > 15) score += 5;
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
    if (cloudSum > 80) score -= 5;
    if (visibility < 8000 && temp2m > 10) score += 3;

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
    if (directRadiation < 50 && temp2m > 15 && cape < 1500) score -= 4; // Sehr niedrige Strahlung (Nacht) reduziert Gewitterwahrscheinlichkeit

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

    return Math.min(100, Math.max(0, Math.round(score)));
}
