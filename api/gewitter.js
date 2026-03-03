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
        // Basis-API: "best_match"-Modell liefert u.a. MLCAPE (für STP_coffer) und weitere Felder
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=wind_gusts_10m,wind_speed_10m,temperature_2m,dew_point_2m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_925hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_speed_1000hPa,wind_speed_925hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
                    `relative_humidity_500hPa,cape,convective_inhibition,lifted_index,` +
                    `dew_point_850hPa,dew_point_700hPa,boundary_layer_height,direct_radiation,` +
                    `precipitation&forecast_days=16&models=best_match&timezone=auto`;

        // Ensemble-API (für Unsicherheiten)
        const ensembleUrl = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=temperature_2m,dew_point_2m,wind_gusts_10m,wind_speed_10m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_925hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_speed_1000hPa,wind_speed_925hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
                    `relative_humidity_500hPa,cape,convective_inhibition,lifted_index,` +
                    `dew_point_850hPa,dew_point_700hPa,boundary_layer_height,direct_radiation,` +
                    `precipitation&forecast_days=16&models=best_match&timezone=auto`;

        // ECMWF IFS 0.25°: hier holen wir CAPE/CIN, die wir als Näherung für muCAPE/muCIN (SPC) verwenden
        // Quelle: Open-Meteo Doku + SPC-Formel für SCP (Thompson et al. 2004)
        const ecmwfMuUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=cape,convective_inhibition&forecast_days=16&models=ecmwf_ifs025&timezone=auto`;

        const [response, ensembleResponse, ecmwfMuResponse] = await Promise.all([
            fetch(url),
            fetch(ensembleUrl).catch(err => {
                console.warn('Ensemble-API-Fehler:', err);
                return { ok: false, json: () => Promise.resolve({ error: true }) };
            }),
            fetch(ecmwfMuUrl).catch(err => {
                console.warn('ECMWF-muCAPE-API-Fehler:', err);
                return { ok: false, json: () => Promise.resolve({ error: true }) };
            })
        ]);

        const data = await response.json();
        let ensembleData = null;
        if (ensembleResponse.ok) {
            ensembleData = await ensembleResponse.json();
        }
        let muData = null;
        if (ecmwfMuResponse.ok) {
            muData = await ecmwfMuResponse.json();
        }

        if (data.error) {
            return res.status(500).json({ error: 'API-Fehler: ' + (data.reason || data.error.message || 'Unbekannt') });
        }

        if (!data?.hourly?.time?.length) {
            return res.status(500).json({ error: 'Keine Daten verfügbar' });
        }

        const timezone = data.timezone || 'UTC';
        const hasEnsemble = ensembleData && !ensembleData.error && ensembleData?.hourly?.time?.length;
        const hasMu = muData && !muData.error && muData?.hourly?.time?.length;

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
                windDir925: data.hourly.wind_direction_925hPa?.[i] ?? 0,
                windDir850: data.hourly.wind_direction_850hPa?.[i] ?? 0,
                windDir700: data.hourly.wind_direction_700hPa?.[i] ?? 0,
                windDir500: data.hourly.wind_direction_500hPa?.[i] ?? 0,
                windDir300: data.hourly.wind_direction_300hPa?.[i] ?? 0,
                wind_speed_1000hPa: data.hourly.wind_speed_1000hPa?.[i] ?? 0,
                wind_speed_925hPa: data.hourly.wind_speed_925hPa?.[i] ?? 0,
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
                // CAPE/CIN aus best_match.
                // In deinen Formeln werden diese Werte als Mixed-Layer-Proxies (mlCAPE/mlCIN) verwendet (Coffer 2019 / SPC stpc5).
                cape: data.hourly.cape?.[i] ?? 0,
                cin: data.hourly.convective_inhibition?.[i] ?? 0,
                // Alias-Namen für explizite, lesbare Verwendung:
                mlCape: data.hourly.cape?.[i] ?? 0,
                mlCin: Math.abs(data.hourly.convective_inhibition?.[i] ?? 0),
                liftedIndex: data.hourly.lifted_index?.[i] ?? 0,
                pblHeight: data.hourly.boundary_layer_height?.[i] ?? 0,
                directRadiation: data.hourly.direct_radiation?.[i] ?? 0,
                precipAcc: data.hourly.precipitation?.[i] ?? 0,
                // Defaults, damit TypeScript (in JS-Dateien) die Properties kennt:
                muCape: 0,
                muCin: 0,
            };

            // muCAPE/muCIN aus ECMWF IFS 0.25° (als Proxy für SPC-muCAPE/muCIN in SCP)
            // Annahme: gleiche Zeitschritte wie im "best_match"-Lauf (Open-Meteo Forecast-API)
            if (hasMu) {
                baseData.muCape = muData.hourly.cape?.[i] ?? 0;
                // muCIN im Code immer als Absolutwert (J/kg) verwendet
                baseData.muCin = Math.abs(muData.hourly.convective_inhibition?.[i] ?? 0);
            }

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
                const srh1km = calcSRH(hour, '0-1km');
                const srh500m = calcSRH(hour, '0-500m');

                // Klare Trennung der CAPE-Typen:
                const mlCape = Math.max(0, hour.mlCape ?? hour.cape ?? 0);
                const mlCin = Math.abs(hour.mlCin ?? hour.cin ?? 0);
                const muCape = Math.max(0, hour.muCape ?? mlCape);
                const muCin = Math.abs(hour.muCin ?? mlCin);

                // Tornado-/Severe-Parameter nach den eingebauten Studien
                const ehi = (mlCape * srh) / 160000;
                const scp = calcSCP(muCape, shear, srh, muCin, region);
                const stp_fixed = calcSTP(mlCape, srh1km, shear, hour.liftedIndex, mlCin, region, hour.temperature, hour.dew, '0-1km');
                const stp_coffer = calcSTP(mlCape, srh500m, shear, hour.liftedIndex, mlCin, region, hour.temperature, hour.dew, '0-500m');

                return {
                    timestamp: hour.time,
                    probability: calculateProbability(hour, region),
                    tornadoProbability: calculateTornadoProbability(hour, shear, srh, region),
                    temperature: hour.temperature,
                    cape: mlCape,
                    muCape: muCape,
                    cin: mlCin,
                    muCin: muCin,
                    shear: shear,
                    srh: srh,
                    srh1km: srh1km,
                    srh500m: srh500m,
                    ehi: ehi,
                    scp: scp,
                    stp_fixed: stp_fixed,
                    stp_coffer: stp_coffer,
                    dcape: calcDCAPE(hour),
                    wmaxshear: calcWMAXSHEAR(mlCape, shear),
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
    // Lon normalisieren
    while (lon > 180)  lon -= 360;
    while (lon < -180) lon += 360;

    // ─────────────────────────────────────
    // AMERIKA
    // ─────────────────────────────────────

    // Kanada (inkl. Toronto)
    if (lat >= 41 && lat <= 83 && lon >= -141 && lon <= -52)
        return 'canada';

    // USA (ohne Kanada & Mexiko)
    if (lat >= 30 && lat < 41 && lon >= -125 && lon <= -65)
        return 'usa';

    // Mexiko + Mittelamerika (inkl. Panama)
    if (lat >= 5 && lat < 30 && lon >= -120 && lon <= -60)
        return 'central_america';

    // Südamerika
    if (lat >= -60 && lat < 5 && lon >= -85 && lon <= -30)
        return 'south_america';


    // ─────────────────────────────────────
    // AFRIKA (VOR EUROPA & MIDDLE EAST!)
    // ─────────────────────────────────────

    // Nordafrika
    if (lat >= 15 && lat <= 37 && lon >= -20 && lon <= 42)
        return 'north_africa';

    // Westafrika
    if (lat >= 0 && lat < 15 && lon >= -20 && lon <= 10)
        return 'west_africa';

    // Zentralafrika
    if (lat >= -5 && lat < 10 && lon > 10 && lon <= 35)
        return 'central_africa';

    // Ostafrika
    if (lat >= -12 && lat < 15 && lon > 35 && lon <= 52)
        return 'east_africa';

    // Südliches Afrika
    if (lat >= -35 && lat < -12 && lon >= 10 && lon <= 55)
        return 'south_africa';


    // ─────────────────────────────────────
    // NAHER OSTEN
    // ─────────────────────────────────────

    if (lat >= 12 && lat <= 42 && lon > 42 && lon <= 65)
        return 'middle_east';


    // ─────────────────────────────────────
    // RUSSLAND / ZENTRALASIEN
    // ─────────────────────────────────────

    // weiter nach Westen gezogen → Moskau passt jetzt
    if (lat >= 40 && lat <= 75 && lon >= 30 && lon <= 180)
        return 'russia_central_asia';


    // ─────────────────────────────────────
    // EUROPA (kommt NACH Afrika & Russland)
    // ─────────────────────────────────────

    if (lat >= 35 && lat <= 72 && lon >= -25 && lon < 30)
        return 'europe';


    // ─────────────────────────────────────
    // ASIEN
    // ─────────────────────────────────────

    if (lat >= 5 && lat <= 35 && lon > 60 && lon <= 100)
        return 'south_asia';

    if (lat >= -10 && lat <= 25 && lon > 100 && lon <= 145)
        return 'southeast_asia';

    if (lat >= 20 && lat <= 55 && lon > 100 && lon <= 155)
        return 'east_asia';


    // ─────────────────────────────────────
    // AUSTRALIEN & OZEANIEN
    // ─────────────────────────────────────

    if (lat >= -45 && lat <= -10 && lon >= 110 && lon <= 155)
        return 'australia';

    if (lat >= -48 && lat <= -33 && (lon >= 165 || lon <= -165))
        return 'new_zealand';


    // ─────────────────────────────────────
    // FALLBACK
    // ─────────────────────────────────────

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

function veeringAngle(d1, d2) {
        let diff = (d2 - d1 + 360) % 360;
        return diff > 180 ? diff - 360 : diff; // positiv = Veering, negativ = Backing
    }

function calcRelHum(temp, dew) {
    const es = 6.112 * Math.exp((17.67 * temp) / (temp + 243.5));
    const e = 6.112 * Math.exp((17.67 * dew) / (dew + 243.5));
    return Math.min(100, Math.max(0, (e / es) * 100));
}

// SRH-Berechnung nach Bunkers et al. (2000), erweitert nach Coffer et al. (2019)
// Quellen:
// - Bunkers et al. 2000 (WAF): Supercell Sturmbewegung & SRH
// - Coffer et al. 2019 (WAF): 0-500 m SRH diskriminiert sign. Tornados vs. nontornadic
//   signifikant besser als 0-1 km oder effektive SRH
//   "Replacing ESRH with 0–500 m AGL SRH increases correct events by 8%,
//    decreases missed events and false alarms by 18%"
// - Thompson et al. 2007: Effective layer SRH Standard
//
// Pressure-Level → Höhen-Approximation (Standard-Atmosphäre):
//   1000 hPa ≈ 110 m AGL  → Boden-Proxy
//    925 hPa ≈ 760 m AGL  → bester Proxy für 0-500 m Schicht (Mittelwert 110-760 m)
//    850 hPa ≈ 1460 m AGL → 0-1 km Proxy (Mittelwert 110-1460 m)
//    700 hPa ≈ 3010 m AGL → 0-3 km Proxy
//    500 hPa ≈ 5570 m AGL → 0-6 km Proxy
//
// Layer-Definitionen:
//   '0-500m' → 1000 + 925 hPa          (präzisester Proxy für 0-500 m AGL)
//   '0-1km'  → 1000 + 925 + 850 hPa    (3-Level für bessere Hodograph-Auflösung)
//   '0-3km'  → 1000 + 925 + 850 + 700  (Standard für EHI/Synoptik)
//   '0-6km'  → alle Level bis 500 hPa  (für SCP/Bulk-Shear-Checks)
function calcSRH(hour, layer = '0-3km') {
    let levels;

    if (layer === '0-500m') {
        // 925 hPa ≈ 760 m AGL — bester verfügbarer Proxy für 0-500 m Schicht
        // Coffer et al. 2019: Physikalisch repräsentiert 0-500 m den
        // bodennahen Inflow-Layer, in dem Rotation für Tornadogenese entscheidend ist
        levels = [
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_925hPa  ?? 0) / 3.6, wd: hour.windDir925  ?? 0 },
        ];

    } else if (layer === '0-1km') {
        // 3 Level für bessere Hodograph-Auflösung im kritischen 0-1 km Layer
        // 925 hPa als Zwischenpunkt verbessert Genauigkeit erheblich gegenüber
        // direktem Sprung 1000→850 hPa
        levels = [
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_925hPa  ?? 0) / 3.6, wd: hour.windDir925  ?? 0 },
            { ws: (hour.wind_speed_850hPa  ?? 0) / 3.6, wd: hour.windDir850  ?? 0 },
        ];

    } else if (layer === '0-3km') {
        // Standard für EHI und synoptische SRH-Analyse
        levels = [
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_925hPa  ?? 0) / 3.6, wd: hour.windDir925  ?? 0 },
            { ws: (hour.wind_speed_850hPa  ?? 0) / 3.6, wd: hour.windDir850  ?? 0 },
            { ws: (hour.wind_speed_700hPa  ?? 0) / 3.6, wd: hour.windDir700  ?? 0 },
        ];

    } else {
        // '0-6km' — für SCP/Bulk-Shear-Checks
        levels = [
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_925hPa  ?? 0) / 3.6, wd: hour.windDir925  ?? 0 },
            { ws: (hour.wind_speed_850hPa  ?? 0) / 3.6, wd: hour.windDir850  ?? 0 },
            { ws: (hour.wind_speed_700hPa  ?? 0) / 3.6, wd: hour.windDir700  ?? 0 },
            { ws: (hour.wind_speed_500hPa  ?? 0) / 3.6, wd: hour.windDir500  ?? 0 },
        ];
    }

    const winds = levels.map(l => windToUV(l.ws, l.wd));

    // Bunkers-Methode: Mean Wind + 7.5 m/s orthogonal zum Shear-Vektor (rechts)
    // Quelle: Bunkers et al. 2000, WAF — Standard für operationelle SRH-Berechnung
    // Alle Level gleichgewichtet (konsistent mit SPC-Implementierung)
    const meanU = winds.reduce((s, w) => s + w.u, 0) / winds.length;
    const meanV = winds.reduce((s, w) => s + w.v, 0) / winds.length;

    // Shear-Vektor = Differenz zwischen oberstem und unterstem Level
    const shearU = winds[winds.length - 1].u - winds[0].u;
    const shearV = winds[winds.length - 1].v - winds[0].v;
    const shearMag = Math.hypot(shearU, shearV) || 1;

    // Right-Mover Sturmbewegung: 7.5 m/s rechts des Shear-Vektors
    // Bunkers 2000: Empirisch aus 394 Superzellen-Hodographen abgeleitet
    const devMag = 7.5;
    const stormU = meanU + devMag * (shearV / shearMag);
    const stormV = meanV - devMag * (shearU / shearMag);

    // SRH = Summe der Kreuzprodukte (Fläche im storm-relativen Hodographen)
    // Positiv = zyklonische Rotation (Right-Mover), negativ = antizyklonisch
    let srh = 0;
    for (let i = 0; i < winds.length - 1; i++) {
        const u1 = winds[i].u   - stormU, v1 = winds[i].v   - stormV;
        const u2 = winds[i+1].u - stormU, v2 = winds[i+1].v - stormV;
        srh += u1 * v2 - u2 * v1;
    }

    // Absolutwert: Wir wollen den Betrag der Rotation (Right-Mover positiv)
    return Math.round(Math.abs(srh) * 10) / 10;
}

// 0-6 km Bulk Wind Shear nach SPC-Standard
// Quelle: Thompson et al. (2003, 2012) — 0-6 km BWD als primärer Superzell-Parameter
// 1000→500 hPa als bester verfügbarer Proxy für 0-6 km (Standard-Atmosphäre)
// Low-Level-Shear (0-1 km): jetzt über 1000→925→850 hPa für bessere Auflösung
// Gewichtung: 0-6 km dominant (75%), 0-1 km als Qualitätsfaktor (25%)
// Quelle Gewichtung: Bunkers 2014 — Low-Level-Shear entscheidend für Tornadogenese,
//   aber 0-6 km BWD primärer Prädiktor für Superzell-Organisation
function calcShear(hour) {
    // 0-6 km Bulk Shear: 1000→500 hPa Vektor-Differenz
    const ws500  = (hour.wind_speed_500hPa  ?? 0) / 3.6;
    const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
    const w500   = windToUV(ws500,  hour.windDir500  ?? 0);
    const w1000  = windToUV(ws1000, hour.windDir1000 ?? 0);
    const bulkShear = Math.hypot(w500.u - w1000.u, w500.v - w1000.v);

    // 0-1 km Low-Level-Shear: jetzt mit 925 hPa als Zwischenpunkt
    // Physikalisch: 925 hPa ≈ 760 m AGL → repräsentiert Windprofil im
    // kritischen bodennahen Inflow-Layer besser als direkter 1000→850-Sprung
    const ws925 = (hour.wind_speed_925hPa ?? 0) / 3.6;
    const ws850 = (hour.wind_speed_850hPa ?? 0) / 3.6;
    const w925  = windToUV(ws925, hour.windDir925 ?? 0);
    const w850  = windToUV(ws850, hour.windDir850 ?? 0);

    // Low-Level-Shear als maximaler Vektor aus zwei Teilschichten:
    // Schicht 1: 1000→925 hPa (0-760 m) — bodennahe Rotation
    // Schicht 2: 925→850 hPa (760-1460 m) — Übergangsschicht
    // Gesamt: 1000→850 hPa mit 925 als Stützpunkt (vektorielle Summe)
    // Teilschichten für LLJ-Diagnostik
    const llShear_1000_925 = Math.hypot(w925.u - w1000.u, w925.v - w1000.v);
    const llShear_925_850  = Math.hypot(w850.u - w925.u,  w850.v - w925.v);
    // Gesamter 0-1 km Shear: Vektordifferenz 1000→850 (vektoriell korrekt)
    const lowLevelShear = Math.hypot(w850.u - w1000.u, w850.v - w1000.v);

    // LLJ-Fingerprint nach Bonner (1968) & Stull (1988):
    // Starker Shear im untersten Layer (1000→925 hPa, 0-760 m) aber
    // deutlich schwächerer Shear in der Übergangsschicht (925→850 hPa, 760-1460 m)
    // → klassisches LLJ-Profil mit bodennahem Windmaximum
    // Schwelle: unterer Layer ≥ 1.5x oberer Layer UND Mindestbetrag > 4 m/s
    const isLLJ = llShear_1000_925 > llShear_925_850 * 1.5 && llShear_1000_925 > 4.0;

    // Kombinierter Shear-Index: 0-6 km dominant (75%), 0-1 km als Qualitätsfaktor (25%)
    // LLJ-Bonus: Bei aktivem LLJ bodennahen Shear stärker gewichten
    // Physikalisch: LLJ-induzierter Shear erhöht SRH und Tornadopotential (Markowski 2003)
    const weight = isLLJ ? { bulk: 0.65, ll: 0.35 } : { bulk: 0.75, ll: 0.25 };
    return Math.round((bulkShear * weight.bulk + lowLevelShear * weight.ll) * 10) / 10;
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

// Mindestparameter für SCP-Berechnung
// Quelle: SPC SCP-Hilfe — EBWD < 10 m/s → SCP = 0 (hartes Cutoff)
// Alle minShear-Werte auf ≥ 10 m/s angehoben (konsistent mit SPC-Standard)
// minCAPE nach Taszarek 2020: Europa Gewitterschwelle ~150 J/kg MLCAPE bei BSO6-Fällen
function getRegionParams(region) {
    const params = {
        'usa':               { minCAPE: 100, minShear: 10, minSRH: 50,  normCAPE: 1000, normShear: 20, normSRH: 50 },
        'canada':            { minCAPE:  80, minShear: 10, minSRH: 40,  normCAPE:  900, normShear: 18, normSRH: 45 },
        'central_america':   { minCAPE: 150, minShear: 10, minSRH: 35,  normCAPE: 1200, normShear: 16, normSRH: 40 },
        'south_america':     { minCAPE: 100, minShear: 10, minSRH: 45,  normCAPE: 1200, normShear: 20, normSRH: 50 },
        'south_africa':      { minCAPE: 150, minShear: 10, minSRH: 50,  normCAPE: 1500, normShear: 20, normSRH: 60 },
        'east_africa':       { minCAPE: 150, minShear: 10, minSRH: 35,  normCAPE: 1400, normShear: 14, normSRH: 40 },
        'central_africa':    { minCAPE: 150, minShear: 10, minSRH: 25,  normCAPE: 1500, normShear: 12, normSRH: 30 },
        'west_africa':       { minCAPE: 150, minShear: 10, minSRH: 30,  normCAPE: 1500, normShear: 12, normSRH: 35 },
        'north_africa':      { minCAPE: 100, minShear: 10, minSRH: 35,  normCAPE: 1000, normShear: 14, normSRH: 35 },
        'south_asia':        { minCAPE: 150, minShear: 10, minSRH: 35,  normCAPE: 1500, normShear: 14, normSRH: 40 },
        'east_asia':         { minCAPE: 100, minShear: 10, minSRH: 40,  normCAPE: 1200, normShear: 18, normSRH: 45 },
        'southeast_asia':    { minCAPE: 150, minShear: 10, minSRH: 25,  normCAPE: 1500, normShear: 12, normSRH: 30 },
        'australia':         { minCAPE: 100, minShear: 10, minSRH: 45,  normCAPE: 1200, normShear: 20, normSRH: 50 },
        'new_zealand':       { minCAPE:  80, minShear: 10, minSRH: 35,  normCAPE:  800, normShear: 16, normSRH: 35 },
        'russia_central_asia':{ minCAPE: 80, minShear: 10, minSRH: 35,  normCAPE:  800, normShear: 16, normSRH: 35 },
        'middle_east':       { minCAPE: 100, minShear: 10, minSRH: 35,  normCAPE: 1000, normShear: 14, normSRH: 35 },
        // Europa: Taszarek 2020 — min. CAPE für Gewitterentwicklung ~150 J/kg (MLCAPE)
        // Púčik 2015: ESWD-Analysen zeigen Gewitteraktivität ab ~150 J/kg + DLS ≥ 10 m/s
        'europe':            { minCAPE:  80, minShear: 10, minSRH: 35,  normCAPE:  800, normShear: 16, normSRH: 35 },
    };
    return params[region] || params['europe'];
}

// SCP nach Thompson et al. (2004) mit CIN-Korrektur nach Gropp & Davenport (2018)
// Quelle: https://www.spc.noaa.gov/exper/mesoanalysis/help/help_scp.html
// Formel (SPC-aktuell): SCP = (muCAPE/1000) * (ESRH/50) * (EBWD/20) * (-40/muCIN)
// EBWD-Regeln: < 10 m/s → 0; > 20 m/s → Term = 1 (gecappt auf 1.0 laut SPC)
// CIN-Term: muCIN > -40 J/kg → Term = 1.0 (Gropp & Davenport 2018)
// Regionale Skalierung: Taszarek et al. (2020, 2021) — Europa STP-Schwelle 0.75 statt 1.0,
//   d.h. SCP-Werte in Europa klimatologisch ~25-30% niedriger als USA
function calcSCP(cape, shear, srh, cin, region = 'europe') {
    // Mindestwerte für sinnvolle Berechnung
    // SPC-Standard: EBWD < 10 m/s → SCP = 0
    if (shear < 10.0) return 0;
    if (cape <= 0 || srh <= 0) return 0;

    // SPC-Standard CAPE/1000 (keine Normierung nötig)
    const capeTerm = cape / 1000;

    // ESRH/50 — gecappt bei 4.0 (SPC-Praxis, hohe Werte selten > 200 m²/s²)
    const srhTerm = Math.min(srh / 50, 4.0);

    // EBWD/20 — SPC: 10-20 m/s linear, > 20 m/s → Term = 1.0 (GECAPPT)
    // Achtung: SPC cappt bei 1.0, NICHT bei 1.5 für normales SCP
    // (1.5 ist nur für STP-shearTerm gültig!)
    const shearTerm = shear >= 20 ? 1.0 : (shear / 20);

    // CIN-Term nach Gropp & Davenport (2018):
    // muCIN > -40 J/kg → cinTerm = 1.0
    // muCIN <= -40 J/kg → cinTerm = -40 / muCIN (wobei cin als Absolutwert vorliegt)
    // Physikalisch: Starke CIN verhindert Konvektionsauslöse trotz günstiger Kinematik
    let cinTerm;
    if (cin <= 40) {
        cinTerm = 1.0;  // günstig: CIN schwach
    } else {
        // Gropp & Davenport: -40 / muCIN, wobei muCIN negativ ist
        // In unserem Code ist cin = abs(CIN), also: -40 / (-cin) = 40 / cin
        cinTerm = Math.max(0, 40 / cin);
    }

    // Regionaler Skalierungsfaktor
    // Quellen:
    // - Taszarek et al. 2020 (J.Clim.): Europa CAPE-Tail 3000-4000 J/kg vs. USA 6000-8000 J/kg
    //   → Gleiche Physik, aber SCP-Werte strukturell niedriger
    // - Taszarek BAMS 2021: STP-Schwelle 0.75 für Europa (statt 1.0 USA)
    //   → Übertragen auf SCP: Europäische Ereignisse bei SCP ~0.5-1.5 signifikant
    // - Púčik et al. 2015: Europa sig. Tornados bei CAPE ähnlich non-severe, DLS entscheidend
    // - Allen et al. 2011 (Australien): Ähnlich USA Plains klimatologisch
    // - Brooks et al. 2003 (global): WMAXSHEAR > 500 = schweres Gewitter, universell gültig
    const regionScale = {
        // USA: Referenz = 1.0 (SPC-Datenbasis)
        'usa': 1.0,
        // Kanada: ähnlich nördl. USA Plains, etwas weniger CAPE (Bunkers 2014)
        'canada': 0.95,
        // Südamerika: ähnlich USA Plains (Argentinien Pampas), Taszarek 2020
        'south_america': 0.95,
        // Australien: sehr ähnlich USA Plains (Allen et al. 2011)
        'australia': 0.95,
        // Südafrika (Highveld): hoch CAPE, aber SPC-Formeln ungetestet → konservativ
        'south_africa': 0.90,
        // Europa: Taszarek 2020/2021 — STP-Schwelle 0.75, SCP klimatologisch niedriger
        // Púčik 2015: sig. Tornados Europa bei deutlich niedrigeren SCP als USA
        'europe': 0.80,
        // Russland/Zentralasien: europäisches Regime, kontinentaler Charakter
        'russia_central_asia': 0.80,
        // Ostasien (Japan, China): europäisches Regime, Taszarek 2021
        'east_asia': 0.80,
        // Neuseeland: maritim, HSLC-Regime möglich
        'new_zealand': 0.80,
        // Naher Osten: Frühjahrskonvektion, mediterran ähnlich
        'middle_east': 0.75,
        // Nordafrika (Maghreb): Mittelmeernähe, aber weniger häufig
        'north_africa': 0.70,
        // Zentralamerika: tropisch, CAPE hoch, aber Shear niedriger
        'central_america': 0.75,
        // Südasien (Indien/Pakistan): Monsun-Konvektion, Shear-Regime anders
        'south_asia': 0.70,
        // Südostasien: tropisch, ITCZ-dominiert, Shear sehr niedrig
        'southeast_asia': 0.65,
        // Ostafrika: Hochland-Konvektion, wenig Datenlage
        'east_africa': 0.65,
        // Zentralafrika: ITCZ, kaum organisierte Superzellen
        'central_africa': 0.60,
        // Westafrika: Sahel-MCS, kaum Superzellen
        'west_africa': 0.60,
    }[region] ?? 0.80;

    return Math.max(0, capeTerm * srhTerm * shearTerm * cinTerm * regionScale);
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

// STP nach SPC-Standard (Thompson et al. 2012, aktualisiert Coffer et al. 2019)
// Zwei Versionen implementiert:
//   A) STP_fixed (Thompson 2012): 0-1 km SRH / 150, EBWD/20 — SPC-Standard
//   B) STP_coffer (Coffer 2019):  0-500 m SRH / 75  — bessere Diskriminierung
//
// Quelle STP_fixed: https://www.spc.noaa.gov/exper/mesoanalysis/help/begin.html
//   STP = (sbCAPE/1500) * ((2000-sbLCL)/1000) * (SRH1km/150) * (EBWD/20) * ((200+CIN)/150)
//   Cutoffs: EBWD < 12.5 m/s → STP = 0; LCL > 2000 m → LCL-Term = 0; CIN > -200 → CIN-Term = 0
//
// Quelle STP_coffer: Coffer et al. (2019, WAF), SPC stpc5:
//   STP = (mlCAPE/1500) * ((2000-mlLCL)/1000) * (SRH500m/75) * (EBWD/20) * ((200+CIN)/150)
//   "Replacing ESRH with 0-500 m SRH increases correct events by 8%,
//    decreases false alarms by 18%"
//
// Globale Anpassung: Taszarek BAMS 2021:
//   Europa STP-Schwelle = 0.75 (statt 1.0 USA)
//   → Wir verwenden einheitliche SPC-Formel + regionalen Skalierungsfaktor
//
// Parameter:
//   cape    = CAPE (J/kg) — Surface-based oder Mixed-Layer
//   srh     = SRH (m²/s²) — 0-1 km ODER 0-500 m (je nach Aufruf)
//   shear   = 0-6 km Bulk Wind Shear (m/s) — entspricht EBWD
//   liftedIndex = Lifted Index (°C) — Fallback für LCL wenn temp2m/dew2m fehlen
//   cin     = CIN (J/kg, Absolutwert)
//   srh_type = '0-1km' oder '0-500m' — bestimmt Normierung
function calcSTP(cape, srh, shear, liftedIndex, cin, region = 'europe', temp2m = null, dew2m = null, srh_type = '0-1km') {
    // *** HARTES CUTOFF nach SPC: EBWD < 12.5 m/s → STP = 0 ***
    // Quelle: Thompson et al. 2012 & SPC-Mesoanalysis-Help
    if (shear < 12.5) return 0;
    if (cape <= 0 || srh <= 0) return 0;

    // CAPE-Term: sbCAPE/1500 J/kg (SPC-Standard, NICHT regionalisiert)
    // Thompson 2003/2012: normiert auf 1500 J/kg als "Signifikanz-Schwelle"
    const capeTerm = Math.min(cape / 1500, 3.0);

    // LCL-Term nach Bolton (1980): LCL_height ≈ 125 * (T2m - Td2m) [Meter]
    // SPC: < 1000 m → 1.0; > 2000 m → 0.0 (hartes Cutoff)
    let lclTerm;
    if (temp2m !== null && dew2m !== null) {
        // Bolton (1980) LCL-Approximation — ausreichend genau für Modell-Output
        const lclHeight = Math.max(0, 125 * (temp2m - dew2m));
        if      (lclHeight < 1000)  lclTerm = 1.0;  // günstig: tiefe LCL
        else if (lclHeight >= 2000) lclTerm = 0.0;  // hartes SPC-Cutoff
        else    lclTerm = (2000 - lclHeight) / 1000; // lineare Interpolation
    } else {
        // Fallback via Lifted Index (schlechtere Approximation)
        lclTerm = liftedIndex <= -4 ? 1.0
                : liftedIndex <= -2 ? 0.8
                : liftedIndex <=  0 ? 0.5
                : 0.2;
    }

    // SRH-Term: Abhängig von SRH-Layer
    // STP_fixed  (Thompson 2012): SRH_0-1km / 150 m²/s²
    // STP_coffer (Coffer 2019):   SRH_0-500m / 75  m²/s²
    // Beide sind physikalisch konsistent (75 = 150/2, weil 0-500m-Layer halb so tief)
    // SPC cap: 3.0
    let srhNorm;
    if (srh_type === '0-500m') {
        // Coffer et al. 2019: 0-500 m SRH normiert mit 75 m²/s²
        srhNorm = 75;
    } else {
        // Thompson 2012 Standard: 0-1 km SRH normiert mit 150 m²/s²
        srhNorm = 150;
    }
    const srhTerm = Math.min(srh / srhNorm, 3.0);

    // EBWD-Term (= 0-6 km Shear):
    // SPC: < 12.5 m/s → 0 (oben bereits gecappt)
    // > 30 m/s → Term = 1.5 (SPC-Standard für STP, anders als SCP!)
    const shearTerm = shear >= 30 ? 1.5 : (shear / 20);

    // CIN-Term: ((200 + mlCIN) / 150) = ((200 - |CIN|) / 150)
    // SPC: mlCIN > -50 J/kg → CIN-Term = 1.0; mlCIN < -200 J/kg → CIN-Term = 0.0
    let cinTerm;
    if      (cin <= 50)  cinTerm = 1.0;            // günstiges CIN → kein Penalty
    else if (cin >= 200) cinTerm = 0.0;            // hartes Cutoff: starkes Capping
    else    cinTerm = (200 - cin) / 150;           // lineare Interpolation SPC-Formel

    // Basis-STP (SPC-Standard, unregionalisiert)
    const stpRaw = capeTerm * lclTerm * srhTerm * shearTerm * cinTerm;

    // Regionaler Skalierungsfaktor für globale Anwendung
    // Hauptquelle: Taszarek BAMS 2021 — STP-Schwelle Europa = 0.75 (statt 1.0)
    // → Effektiv werden europäische Ereignisse bei STP ~0.5-0.75 als signifikant eingestuft
    // → Regionaler Scale: Europa = 1.0/0.75 ≈ 1.33 wäre FALSCH (erhöht STP)
    // KORREKT: STP-Formel bleibt unverändert, aber die INTERPRETATION der Schwellenwerte
    //           wird regional angepasst (in calculateTornadoProbability)
    // Ausnahme: Für Regionen mit strukturell anderen Hodographen (tropisch) leichte Absenkung
    const regionScale = {
        'usa': 1.0, 'canada': 1.0, 'south_america': 1.0, 'australia': 1.0,
        'south_africa': 1.0,
        // Europäische & gemäßigte Regionen: Taszarek 2021 — STP-Schwelle niedriger
        // WIR SKALIEREN NICHT die Formel, sondern passen Schwellenwerte unten an
        'europe': 1.0, 'russia_central_asia': 1.0, 'east_asia': 1.0,
        'new_zealand': 1.0, 'middle_east': 1.0, 'north_africa': 1.0,
        // Tropische Regionen: Shear-Regime fundamental anders (ITCZ-dominiert)
        // Tornados selten durch klassische Superzellen → konservative Absenkung
        'central_america': 0.85, 'south_asia': 0.80, 'southeast_asia': 0.75,
        'east_africa': 0.75, 'central_africa': 0.70, 'west_africa': 0.70,
    }[region] ?? 1.0;

    return Math.max(0, stpRaw * regionScale);
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
    // "cape/cin" aus best_match werden im restlichen Code als Mixed-Layer-Proxies genutzt
    // (Coffer 2019 STP_coffer). Für klare Semantik verwenden wir mlCape/mlCin.
    const mlCape = Math.max(0, hour.mlCape ?? hour.cape ?? 0);
    const mlCin = Math.abs(hour.mlCin ?? hour.cin ?? 0);
    const precipAcc = hour.precipAcc ?? 0;
    const precipProb = hour.precip ?? 0;
    
    // Regionsspezifische Filter für Fehlalarme
    const p = getProbabilityParams(region);
    if (temp2m < p.minTemp) return 0; // Zu kalt für Gewitter
    if (temp2m < p.minTempWithCAPE && mlCape < (p.minCAPE * 1.5)) return 0; // Kalt und keine hohe Instabilität
    if (mlCape < p.minCAPEWithPrecip && precipAcc < 0.2 && precipProb < 20) return 0; // Keine Instabilität und kein Niederschlag
    
    // Berechne Indizes
    const shear = calcShear(hour);
    const srh1km = calcSRH(hour, '0-1km');
    const srh = calcSRH(hour, '0-3km');
    const { kIndex, showalter, lapse, liftedIndex } = calcIndices(hour);
    const relHum2m = calcRelHum(temp2m, dew);
    const cloudSum = (hour.cloudLow ?? 0) + (hour.cloudMid ?? 0) + (hour.cloudHigh ?? 0);

    const isNight = hour.directRadiation < 20;
    const isDaytime = hour.directRadiation >= 200;
    
    // Kombinierte Indizes (bewährte meteorologische Parameter)
    const ehi = (mlCape * srh) / 160000;

    // Für SCP nach Thompson et al. (2004) sollen muCAPE/muCIN verwendet werden.
    // Open-Meteo liefert für das ECMWF IFS 0.25°-Modell CAPE/CIN, die wir hier als
    // Näherung für muCAPE/muCIN interpretieren (da sie die „instabilste“ Schicht repräsentieren).
    // Fallback: falls ECMWF-Daten nicht verfügbar sind, nutze wie bisher CAPE/CIN aus best_match.
    const muCape = Math.max(0, hour.muCape ?? cape);
    const muCin = Math.abs(hour.muCin ?? mlCin);
    const scp = calcSCP(muCape, shear, srh, muCin, region);
    const stp = calcSTP(mlCape, srh1km, shear, liftedIndex, mlCin, region, temp2m, dew);
    const wmaxshear = calcWMAXSHEAR(mlCape, shear);
    
    // Basis-Score basierend auf kombinierten Indizes (regionsspezifisch)
    let score = 0;
    
    // CAPE-Bewertung (regionsspezifisch)
    for (let i = 0; i < p.capeThresholds.length; i++) {
        if (mlCape >= p.capeThresholds[i]) {
            score += p.capeScores[i];
            break;
        }
    }
    
    // CIN-Penalty (stärker gewichtet)
    if (mlCin > 200) score -= 15;
    else if (mlCin > 100) score -= 8;
    else if (mlCin > 50) score -= 4;
    
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
    
    // WMAXSHEAR = sqrt(2 * CAPE) * BS06
    // Quellen:
    // - Taszarek et al. (2020, J.Clim. Part I): Schwelle 500 m²/s² = "severe environment"
    //   (mit Bedingung: BS06 ≥ 10 m/s)
    // - Taszarek 2019 (J.Clim. Europa-Klimatologie): Diskriminant nonsevere/severe = 400 m²/s²
    // - Brooks et al. (2003, Atmos.Res.): Globale Schwelle bestätigt durch Taszarek
    // - Für tropische Regionen (SE-Asien, Zentralafrika): CAPE dominiert → niedrigere
    //   WMAXSHEAR-Werte trotz realer Gewittergefahr → regionaler Faktor notwendig
    const wmaxshearScale = ['south_asia','southeast_asia','central_africa','west_africa','east_africa'].includes(region) ? 0.7 : 1.0;
    const wms = wmaxshear * wmaxshearScale;

    if      (wms >= 1500) score += 20; // Extreme Bedingungen: breite Ereignisdokumentation
    else if (wms >= 1200) score += 17; // Sehr schwere Gewitter (USA/Argentinien Regime)
    else if (wms >= 900)  score += 13; // Schwere Gewitter, typische Superzell-Umgebung
    else if (wms >= 700)  score += 9;  // Deutliche Gewittergefahr
    else if (wms >= 500)  score += 6;  // Taszarek 2020: "severe environment" Schwelle
    else if (wms >= 400)  score += 3;  // Taszarek 2019 Europa: nonsevere/severe Diskriminant
    else if (wms >= 250)  score += 1;  // Schwacher Hinweis auf organisierte Konvektion
    
    // Shear und SRH (regionsspezifisch)
    const highCAPEThreshold = isHighThreshold ? 800 : 500;
    const lowCAPEThreshold = isHighThreshold ? 500 : 200;
    
    if (mlCape >= highCAPEThreshold) {
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
    } else if (mlCape >= lowCAPEThreshold) {
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
        if (mlCape >= 600) {
            if (liftedIndex <= -7) score += 12;
            else if (liftedIndex <= -6) score += 10;
            else if (liftedIndex <= -4) score += 6;
            else if (liftedIndex <= -2) score += 3;
        } else if (mlCape >= 500) {
            if (liftedIndex <= -5) score += 4;
            else if (liftedIndex <= -3) score += 2;
        }
    } else {
        // Europa: Auch bei niedrigem CAPE
        if (mlCape >= 400) {
            if (liftedIndex <= -6) score += 10;
            else if (liftedIndex <= -4) score += 6;
            else if (liftedIndex <= -2) score += 3;
        } else if (mlCape >= 200) {
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

    const w1000 = windToUV((hour.wind_speed_1000hPa ?? 0) / 3.6, hour.windDir1000 ?? 0);
    const w925  = windToUV((hour.wind_speed_925hPa  ?? 0) / 3.6, hour.windDir925  ?? 0);
    const w850  = windToUV((hour.wind_speed_850hPa  ?? 0) / 3.6, hour.windDir850  ?? 0);
    
    // Feuchtigkeit und Temperatur (regionsspezifisch)
    if (region === 'usa') {
        if (isDaytime && temp2m >= 18 && cape >= 600) {
            if (hour.directRadiation >= 600) score += 5;
            else if (hour.directRadiation >= 400) score += 3;
        } else if (isNight) {
            // LLJ-Check: präziser via Windprofil-Struktur (Bonner 1968)
            // Starker Shear im untersten Layer (1000→925 hPa) aber schwächerer
            // Shear in der Übergangsschicht (925→850 hPa) = klassisches LLJ-Profil
            const llShear_low = Math.hypot(w925.u - w1000.u, w925.v - w1000.v);
            const llShear_mid = Math.hypot(w850.u - w925.u,  w850.v - w925.v);
            // Quelle: Bonner 1968, Hanesiak 2024, Climate Central 2025
            const llj_active = llShear_low > llShear_mid * 1.5 && llShear_low > 4.0 && srh >= 100;

            if (!llj_active && shear < 12 && cape < 1000) score -= 5;
            if (llj_active && cape >= 800) score += 4;   // LLJ-Bonus
            else if (cape >= 1200 && srh >= 150) score += 2;
        }
    } else {
        if (isDaytime && temp2m >= 12 && cape >= 300) {
            if (hour.directRadiation >= 500) score += 4;
            else if (hour.directRadiation >= 300) score += 2;
            else if (hour.directRadiation >= 200) score += 1;
        } else if (isNight) {
            // LLJ-Check Europa: niedrigere Schwellen (Taszarek 2019)
            const llShear_low = Math.hypot(w925.u - w1000.u, w925.v - w1000.v);
            const llShear_mid = Math.hypot(w850.u - w925.u,  w850.v - w925.v);
            const llj_active = llShear_low > llShear_mid * 1.5 && llShear_low > 4.0 && srh >= 75;

            if (!llj_active && shear < 10 && cape < 500) score -= 3;
            if (llj_active && cape >= 600) score += 3;   // LLJ-Bonus
            else if (cape >= 800 && srh >= 100) score += 2;
        }
    }
    
    // Niederschlag (regionsspezifisch)
    if (region === 'usa') {
        if (mlCape >= 600) {
            if (precipAcc >= 3.0 && cape >= 1000) score += 7;
            else if (precipAcc >= 2.0 && cape >= 800) score += 5;
            else if (precipAcc >= 1.0 && cape >= 600) score += 3;
            
            if (precipProb >= 70 && cape >= 800) score += 5;
            else if (precipProb >= 55 && cape >= 600) score += 3;
        } else if (mlCape >= 500) {
            if (precipAcc >= 2.0) score += 2;
            if (precipProb >= 60) score += 2;
        }
    } else {
        // Europa: Auch bei niedrigem CAPE
        if (mlCape >= 400) {
            if (precipAcc >= 2.5 && cape >= 800) score += 6;
            else if (precipAcc >= 1.2 && cape >= 600) score += 4;
            else if (precipAcc >= 0.5 && cape >= 400) score += 2;
            
            if (precipProb >= 65 && cape >= 600) score += 4;
            else if (precipProb >= 45 && cape >= 400) score += 2;
        } else if (mlCape >= 200) {
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
        if (precipAcc > 3 && mlCape < 600) score -= 10;
    } else {
        if (precipAcc > 2 && mlCape < 400) score -= 8;
    }
    
    // Relative Feuchte 500hPa (trockene mittlere Troposphäre begünstigt, regionsspezifisch)
    if (region === 'usa') {
        if (hour.rh500 < 30 && mlCape >= 1000) score += 6;
        else if (hour.rh500 < 40 && mlCape >= 800) score += 4;
        else if (hour.rh500 > 85 && mlCape < 1000) score -= 5;
    } else {
        if (hour.rh500 < 35 && mlCape >= 800) score += 5;
        else if (hour.rh500 < 45 && mlCape >= 600) score += 3;
        else if (hour.rh500 > 85 && mlCape < 800) score -= 4;
    }
    
    if (region === 'usa') {
        if (isDaytime && temp2m >= 18 && mlCape >= 600) {
            if (hour.directRadiation >= 600) score += 5;
            else if (hour.directRadiation >= 400) score += 3;
        } else if (isNight) {
            // Low-Level-Jet Check: hohes SRH nachts = LLJ aktiv → kein Pauschalabzug
            // Quelle: Hanesiak 2024, Climate Central 2025
            const llj_active = srh >= 150 && shear >= 12;
            if (!llj_active && shear < 12 && mlCape < 1000) score -= 5; // vorher -7
            if (llj_active && mlCape >= 800) score += 4;  // LLJ-Bonus
            else if (mlCape >= 1200 && srh >= 150) score += 2;
        }
    } else {
        if (isDaytime && temp2m >= 12 && mlCape >= 300) {
            if (hour.directRadiation >= 500) score += 4;
            else if (hour.directRadiation >= 300) score += 2;
            else if (hour.directRadiation >= 200) score += 1;
        } else if (isNight) {
            const llj_active = srh >= 100 && shear >= 10;
            if (!llj_active && shear < 10 && mlCape < 500) score -= 3; // vorher -4
            if (llj_active && mlCape >= 600) score += 3;  // LLJ-Bonus
            else if (mlCape >= 800 && srh >= 100) score += 2;
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
    if (hour.ensemble) {
        const MIN_PROB = 0.6;
        const capeThreshold = isHighThreshold ? 800 : 600;
        const capeMinCAPE = isHighThreshold ? 600 : 400;
        
        const capeProb = getEnsembleProb(hour.ensemble, 'cape', capeThreshold, 'above');
        if (capeProb !== null && capeProb >= MIN_PROB) {
            score += Math.round((isHighThreshold ? 10 : 8) * capeProb);
        }
        
        const liProb = getEnsembleProb(hour.ensemble, 'lifted_index', -3, 'below');
        if (liProb !== null && liProb >= MIN_PROB && cape >= capeMinCAPE) {
            score += Math.round((isHighThreshold ? 5 : 4) * liProb);
        }
        
        const precipProb = getEnsembleProb(hour.ensemble, 'precipitation', 1, 'above');
        if (precipProb !== null && precipProb >= MIN_PROB && cape >= capeMinCAPE) {
            score += Math.round((isHighThreshold ? 4 : 3) * precipProb);
        }
    }
    
    // Temperatur-Reduktion (kälter = weniger wahrscheinlich, regionsspezifisch)
    if (temp2m < p.minTempReduction) score = Math.round(score * p.tempReductionFactor);
    else if (temp2m < p.minTempReduction2) score = Math.round(score * p.tempReductionFactor2);
    
    // Mindestanforderungen für Gewitter (regionsspezifisch)
    if (region === 'usa') {
        if (score > 0 && mlCape < 500) {
            score = Math.max(0, score - 10);
        }
        if (score > 0 && mlCin > 150 && mlCape < 1500) score = Math.max(0, score - 15);
    } else {
        // Europa: Nur bei sehr niedrigem CAPE (< 200) leicht reduzieren
        if (score > 0 && mlCape < 200) {
            score = Math.max(0, score - 5);
        }
        if (score > 0 && mlCin > 150 && mlCape < 1200) score = Math.max(0, score - 15);
    }
    
    return Math.min(100, Math.max(0, Math.round(score)));
}

// Tornado-Wahrscheinlichkeitsberechnung (regionsspezifisch)
function calculateTornadoProbability(hour, shear, srh, region = 'europe') {
    const temp2m = hour.temperature ?? 0;
    const dew = hour.dew ?? 0; // für LCL-Berechnung
    const cape = Math.max(0, hour.cape ?? 0);
    // muCAPE (Most Unstable CAPE) — wird in den Quellen (z.B. Zhang et al. 2023) explizit verwendet.
    // Wir nutzen muCAPE hier für die Mindest-CAPE-Schwelle, lassen aber STP/HSLC-Logik weiterhin
    // auf dem "cape" (best_match ≈ MLCAPE) laufen, damit HSLC (CAPE ≤ 500) nicht verfälscht wird.
    const muCape = Math.max(0, hour.muCape ?? cape);
    const cin = Math.abs(hour.cin ?? 0);
    const { liftedIndex } = calcIndices(hour);
    
    // Mindest-Schwellen für Tornado-Berechnung
    // Quellen:
    // - Sherburn & Parker 2014 (WAF): HSLC = CAPE ≤ 500 J/kg + Shear ≥ 18 m/s → reale Tornados
    //   → minCAPE darf NICHT > 300 J/kg sein (HSLC-Ereignisse werden sonst komplett verpasst)
    // - Púčik 2015 (MWR): Europa sig. Tornados mit CAPE ähnlich non-severe → DLS entscheidend
    //   → Europa minCAPE auf 150 J/kg (HSLC-kompatibel)
    // - Thompson et al. (2003): 25. Perzentil der USA sig. Tornado-Sounding-Datenbank:
    //   CAPE ~500 J/kg (aber HSLC-Ausnahmen bei >18 m/s Shear!)
    // - Grünwald & Brooks 2011: Europa Tornados bei LCL + CAPE niedriger als USA
    // - Zhang et al. 2023 (QJRMS): China sig. Tornados bei MUCAPE teils < 300 J/kg möglich
    const tornadoThresholds = {
        // USA: 25. Perzentil SPC-Datenbank ~500 J/kg, aber HSLC-Ausnahmen ab CAPE=100
        // Kompromiss: 300 J/kg (HSLC-Bereich wird durch HSLC-Check unten abgedeckt)
        'usa':               { minTemp: 10, minCAPE: 300 },
        // Kanada: ähnlich USA, etwas kälter (Bunkers 2014 Alberta)
        'canada':            { minTemp:  8, minCAPE: 250 },
        // Südamerika (Argentinien): ähnlich USA Plains (Taszarek 2020)
        'south_america':     { minTemp: 10, minCAPE: 300 },
        // Australien: ähnlich USA Plains (Allen et al. 2011)
        'australia':         { minTemp: 10, minCAPE: 300 },
        // Südafrika (Highveld): CAPE-reich, aber weniger dokumentiert
        'south_africa':      { minTemp: 10, minCAPE: 300 },
        // Europa: HSLC-kompatibel nach Sherburn 2014 + Púčik 2015
        // Grünwald 2011: Europa-Tornados bei niedrigerer CAPE+LCL als USA
        'europe':            { minTemp:  6, minCAPE: 150 },
        // Russland/Zentralasien: wie Europa (HSLC-Regime im Westen möglich)
        'russia_central_asia':{ minTemp: 6, minCAPE: 150 },
        // Ostasien (China/Japan): Zhang 2023 — China sig. Tornados ab CAPE ~300
        // Japan Sea effect: HSLC möglich ab CAPE ~100
        'east_asia':         { minTemp:  8, minCAPE: 150 },
        // Neuseeland: HSLC-Regime maritime Luft (wie Brit. Inseln)
        'new_zealand':       { minTemp:  6, minCAPE: 150 },
        // Naher Osten: mediterran ähnlich, Frühjahrskonvektion
        'middle_east':       { minTemp: 10, minCAPE: 200 },
        // Nordafrika (Maghreb): mediterran, selten aber möglich
        'north_africa':      { minTemp: 12, minCAPE: 200 },
        // Südasien: Monsun-Umgebung, Nor'westers (Bengalen) können Tornados erzeugen
        'south_asia':        { minTemp: 18, minCAPE: 250 },
        // Südostasien: tropisch, Tornado-Superzellen selten
        'southeast_asia':    { minTemp: 20, minCAPE: 250 },
        // Zentralamerika: ähnlich SE-Asien, Karibik etwas aktiver
        'central_america':   { minTemp: 16, minCAPE: 200 },
        // Ostafrika: Hochland-Gewitter, Tornados möglich aber selten dokumentiert
        'east_africa':       { minTemp: 16, minCAPE: 200 },
        // Zentralafrika: ITCZ, Tornados sehr selten, CAPE hoch
        'central_africa':    { minTemp: 18, minCAPE: 200 },
        // Westafrika: Sahel, MCS-Tornados möglich (ähnlich QLCS-Regime)
        'west_africa':       { minTemp: 20, minCAPE: 200 },
    };

    const t = tornadoThresholds[region] || tornadoThresholds['europe'];
    if (temp2m < t.minTemp) return 0;
    // HSLC-Ausnahme nach Sherburn & Parker 2014:
    // Wenn Shear ≥ 18 m/s → minCAPE auf 100 J/kg absenkbar (HSLC-Regime)
    const effectiveMinCAPE = (shear >= 18 && muCape >= 100) ? Math.min(t.minCAPE, 150) : t.minCAPE;
    if (muCape < effectiveMinCAPE) return 0;
    if (cin > 250) return 0;  // SPC: CIN < -250 J/kg → keine Konvektion auslösbar

    // Tornado ohne Gewitter unmöglich
    const thunderstormProb = calculateProbability(hour, region);
    if (thunderstormProb === 0) return 0;
    
    // SRH-Berechnung für STP: 0-500 m SRH nach Coffer et al. (2019)
    // "Replacing ESRH with 0-500 m SRH increases correct events by 8%,
    //  decreases missed events and false alarms by 18%" (Coffer et al. 2019, WAF)
    // Fallback: 0-1 km SRH wenn 0-500 m nicht ausreichend aufgelöst
    const srh500m = calcSRH(hour, '0-500m');
    const srh1km  = calcSRH(hour, '0-1km');
    // Nutze 0-500 m SRH für STP (Coffer 2019), 0-1 km als Backup-Check
    const srh_for_stp = srh500m > 0 ? srh500m : srh1km;
    const srh_type_for_stp = srh500m > 0 ? '0-500m' : '0-1km';
    
   // Veering-with-Height Check: Wind muss mit Höhe rechtdrehen (Veering) für
    // positive SRH und Mesozyklonentwicklung
    // Quelle: Markowski & Richardson (2010, Mesoscale Meteorology in Midlatitudes)
    //   "Veering winds with height → warm air advection → cyclonic SRH"
    // Jetzt mit 925 hPa: bodennaher Layer (1000→925) physikalisch am wichtigsten
    // da dort die Tornadogenese-relevante Rotation initiiert wird
    const dir1000 = hour.windDir1000 ?? 0;
    const dir925  = hour.windDir925  ?? 0;
    const dir850  = hour.windDir850  ?? 0;
    const dir700  = hour.windDir700  ?? 0;

    // Drei Schichten: 1000→925 (bodennah, wichtigster Layer!), 925→850, 850→700
    const veer925_1000 = veeringAngle(dir1000, dir925); // bodennah: höchste Gewichtung
    const veer850_925  = veeringAngle(dir925,  dir850);
    const veer700_850  = veeringAngle(dir850,  dir700);

    // Gewichtetes Veering: bodennahe Schicht (1000→925) doppelt gewichtet
    // Physikalisch: Reibungsschicht-Veering entscheidend für Tornadogenese
    // (Rasmussen 2003: low-level wind shear/veer primary discriminator)
    const totalVeering = (veer925_1000 * 2.0 + veer850_925 * 1.0 + veer700_850 * 0.5) / 3.5;

    // Veeringfaktor: Backing (negativ) reduziert Tornadopotential stark,
    // starkes Veering (> 30°) erhöht es leicht
    let veeringFactor = 1.0;
    if      (totalVeering < -20) veeringFactor = 0.25; // starkes Backing → antizyklonisch
    else if (totalVeering < -10) veeringFactor = 0.50;
    else if (totalVeering <   0) veeringFactor = 0.75;
    else if (totalVeering >= 35) veeringFactor = 1.25; // starkes Veering → sehr günstig
    else if (totalVeering >= 20) veeringFactor = 1.15;
    else if (totalVeering >= 10) veeringFactor = 1.05;

    const stp = calcSTP(cape, srh_for_stp, shear, liftedIndex, cin, region, temp2m, dew, srh_type_for_stp) * veeringFactor;
    
    // Basis-Score für Tornado-Wahrscheinlichkeit
    let score = 0;
    
    // STP ist der Hauptindikator für Tornado-Potential (regionsspezifisch)
    const highThresholdRegions = ['usa', 'south_africa', 'south_america', 'australia'];
    const isHighThreshold = highThresholdRegions.includes(region);
    
    // STP-Schwellenwerte für Tornado-Wahrscheinlichkeit
    // Quellen:
    // - Thompson et al. (2012): STP > 1 → sig. Tornados wahrscheinlicher als nontornadic
    // - Taszarek BAMS 2021: Europa effektive Schwelle STP = 0.75 (statt 1.0 USA)
    // - Coffer et al. (2019): Medianwert sig. tornadic Superzellen: STP500 ≈ 2.5-3.0 (USA)
    // - Púčik 2015: Europa sig. Tornados bei STP oft 0.5-1.5 → niedrigere Basis-Schwelle
    //
    // Regionen mit USA-ähnlichem Klima (isHighThreshold): USA, Kanada, Südamerika,
    //   Australien, Südafrika — SPC-Klimatologie direkt anwendbar
    // Andere Regionen: Taszarek 2021 — STP-Schwellen ~25-40% niedriger
    if (isHighThreshold) {
        // USA/Plains-Klimatologie (Thompson 2012, Coffer 2019)
        // STP ≥ 1: Mehrheit sig. Tornados in SPC-Proximitätsdaten
        // STP ≥ 3: Sehr hohe Wahrscheinlichkeit sig. Tornado
        if      (stp >= 4.0) score = 92;
        else if (stp >= 3.0) score = 82;
        else if (stp >= 2.0) score = 68;
        else if (stp >= 1.5) score = 55;
        else if (stp >= 1.0) score = 40;
        else if (stp >= 0.7) score = 28;
        else if (stp >= 0.5) score = 18;
        else if (stp >= 0.3) score = 10;
        else if (stp >  0.0) score = 4;
    } else {
        // Europa + andere Regionen: Schwellen nach Taszarek 2021 (STP-Schwelle 0.75)
        // Púčik 2015: sig. Tornados Europa bei STP 0.5-1.5 häufig
        // Grünwald & Brooks 2011: Europa-Tornados bei strukturell niedrigeren Werten
        if      (stp >= 3.0) score = 88;
        else if (stp >= 2.0) score = 75;
        else if (stp >= 1.5) score = 62;
        else if (stp >= 1.0) score = 50;  // Taszarek 2021: sig. Tornado möglich
        else if (stp >= 0.75)score = 38;  // Taszarek 2021: effektive Europa-Schwelle
        else if (stp >= 0.5) score = 25;
        else if (stp >= 0.3) score = 14;
        else if (stp >  0.0) score = 5;
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

    // Minimale Anforderungen für plausible Tornadogefahr
    // Quellen:
    // - Thompson et al. 2003/2012 (SPC): 25. Perzentil sig. Tornado-Proximity-Soundings USA
    // - Púčik 2015 (MWR): Europa — DLS entscheidend, CAPE ähnlich non-severe
    // - Sherburn & Parker 2014: HSLC-Tornados bei Shear ≥ 18 m/s, CAPE < 500 J/kg REAL
    // - SPC-STP Formel: Shear < 12.5 m/s → STP = 0 (hartes Cutoff bleibt)
    // - Zhang 2023 (China): sig. Tornados bei niedrigeren Werten als US-Klimatologie
    const minReqs = {
        // USA SPC-Klimatologie: 25. Perzentil ~CAPE 500, Shear 12 m/s, SRH 100 m²/s²
        // HSLC-Exception: Bei Shear ≥ 18 m/s gilt minCAPE = 100 (Sherburn 2014)
        'usa':               { minCAPE: 400, minShear: 12.5, minSRH: 80  },
        // Kanada: etwas niedrigere Werte als USA (Bunkers 2014)
        'canada':            { minCAPE: 300, minShear: 11.0, minSRH: 60  },
        // Europa: Púčik 2015 — CAPE ähnlich non-severe, DLS entscheidend
        // Grünwald 2011: Europa-Tornados bei niedrigerer CAPE+LCL
        // Taszarek 2021: Effektive STP-Schwelle 0.75 → kompatibel mit niedrigeren Minima
        'europe':            { minCAPE: 150, minShear: 10.0, minSRH: 40  },
        // Russland/Zentralasien: wie Europa
        'russia_central_asia':{ minCAPE: 150, minShear: 10.0, minSRH: 40  },
        // Ostasien: Zhang 2023 (China) + Japan-Klimatologie
        'east_asia':         { minCAPE: 200, minShear: 10.0, minSRH: 50  },
        // Neuseeland: HSLC-Regime möglich
        'new_zealand':       { minCAPE: 150, minShear: 10.0, minSRH: 40  },
        // Südamerika: ähnlich USA Plains (Taszarek 2020)
        'south_america':     { minCAPE: 350, minShear: 12.0, minSRH: 70  },
        // Australien: ähnlich USA Plains (Allen et al. 2011)
        'australia':         { minCAPE: 350, minShear: 12.0, minSRH: 80  },
        // Südafrika (Highveld)
        'south_africa':      { minCAPE: 400, minShear: 12.0, minSRH: 80  },
        // Naher Osten: mediterran, selten
        'middle_east':       { minCAPE: 200, minShear: 9.0,  minSRH: 40  },
        // Nordafrika
        'north_africa':      { minCAPE: 200, minShear: 9.0,  minSRH: 40  },
        // Südasien (Nor'westers Bengalen)
        'south_asia':        { minCAPE: 250, minShear: 8.0,  minSRH: 40  },
        // Südostasien: sehr selten, CAPE hoch aber Shear niedrig
        'southeast_asia':    { minCAPE: 250, minShear: 7.0,  minSRH: 30  },
        // Zentralamerika
        'central_america':   { minCAPE: 200, minShear: 8.0,  minSRH: 35  },
        // Ostafrika
        'east_africa':       { minCAPE: 200, minShear: 7.0,  minSRH: 30  },
        // Zentralafrika + Westafrika: MCS-Tornados möglich
        'central_africa':    { minCAPE: 200, minShear: 6.0,  minSRH: 25  },
        'west_africa':       { minCAPE: 200, minShear: 6.0,  minSRH: 30  },
    };

    const mr = minReqs[region] || minReqs['europe'];

    // HSLC-Ausnahme nach Sherburn & Parker (2014, WAF):
    // "HSLC = CAPE ≤ 500 J/kg + 0-6km Shear ≥ 18 m/s"
    // In HSLC-Umgebungen sind klassische CAPE-basierte Parameter unzuverlässig.
    // Reale signifikante Tornados (EF2+) treten auf trotz niedrigem STP.
    // → Bei Shear ≥ 18 m/s: minCAPE-Anforderung auf 100 J/kg absenken
    const isHSLC = shear >= 18.0 && cape <= 500;
    const effectiveMrCAPE = isHSLC ? Math.min(mr.minCAPE, 150) : mr.minCAPE;

    // Gestufter Penalty bei Verfehlen der Mindestanforderungen
    // Logik: Bei HSLC-Umgebungen ist minCAPE weniger relevant (Sherburn 2014)
    let failCount = 0;
    if (cape  < effectiveMrCAPE && score > 15) failCount++;
    if (shear < mr.minShear     && score > 10) failCount++;
    if (srh   < mr.minSRH       && score > 10) failCount++;

    // HSLC-Bonus: Bei hohem Shear (≥ 18 m/s) schwächerer Penalty
    // Physikalisch: Dynamischer Auftrieb kann thermodynamisches Defizit teilweise kompensieren
    const penaltyFactors = isHSLC
        ? [1.0, 0.65, 0.50]  // HSLC: weniger streng
        : [1.0, 0.55, 0.35]; // Standard

    if      (failCount === 3) score = Math.round(score * penaltyFactors[2]);
    else if (failCount === 2) score = Math.round(score * penaltyFactors[1]);
    else if (failCount === 1) score = Math.round(score * penaltyFactors[0]);

    return Math.min(100, Math.max(0, Math.round(score)));
}