export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'lat und lon Parameter sind erforderlich' });

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    if (isNaN(latitude) || isNaN(longitude)) return res.status(400).json({ error: 'Ungültige Koordinaten' });

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=wind_gusts_10m,wind_speed_10m,temperature_2m,dew_point_2m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_speed_1000hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
                    `relative_humidity_500hPa,relative_humidity_850hPa,relative_humidity_700hPa,cape,` +
                    `dew_point_850hPa,dew_point_700hPa,direct_radiation,` +
                    `freezing_level_height,precipitation&forecast_days=16&models=icon_eu,ecmwf_ifs025,gfs_global&timezone=auto`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.error) return res.status(500).json({ error: 'API-Fehler: ' + (data.reason || data.error.message || 'Unbekannt') });
        if (!data?.hourly?.time?.length) return res.status(500).json({ error: 'Keine Daten verfügbar' });

        const timezone = data.timezone || 'UTC';
        const region = getRegion(latitude, longitude);
        if (region !== 'europe') {
            return res.status(400).json({ error: 'Vorhersage nur für Europa verfügbar', region, onlyEurope: true });
        }

        // ═══════════════════════════════════════════════════════════════════
        // KERN-METHODIK (ESSL AR-CHaMo):
        // Pro Modell vollständige Stunden-Daten extrahieren,
        // dann pro Modell Wahrscheinlichkeit berechnen,
        // dann gewichteter Ensemble-Mittelwert der Wahrscheinlichkeiten.
        // Erhält die physikalische Kohärenz jedes Modells.
        // Quelle: Rädler et al. 2018 (AR-CHaMo), ESSL Technical Note 2023
        // ═══════════════════════════════════════════════════════════════════

        const MODELS = ['icon_eu', 'ecmwf_ifs025', 'gfs_global'];

        const now = new Date();
        const currentTimeStr = now.toLocaleString('en-US', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone
        });
        const [datePart_now, timePart_now] = currentTimeStr.split(', ');
        const [month_now, day_now, year_now] = datePart_now.split('/');
        const [currentHour] = timePart_now.split(':').map(Number);
        const currentDateStr = `${year_now}-${month_now.padStart(2,'0')}-${day_now.padStart(2,'0')}`;

        // ── Schritt 1: Pro Modell alle Stunden extrahieren ──────────────────
        function extractModelHour(hourly, i, model) {
            function get(field) {
                const key = `${field}_${model}`;
                const arr = hourly[key];
                if (Array.isArray(arr) && arr[i] !== undefined && arr[i] !== null) return arr[i];
                return null;
            }

            const t2m  = get('temperature_2m');
            const d2m  = get('dew_point_2m');
            const t850 = get('temperature_850hPa');
            const d850 = get('dew_point_850hPa');
            const t700 = get('temperature_700hPa');
            const d700 = get('dew_point_700hPa');
            const t500 = get('temperature_500hPa');

            if (t2m === null || t850 === null || t500 === null) return null;

            const hour = {
                time:               hourly.time[i],
                temperature:        t2m,
                dew:                d2m ?? t2m - 10,
                cloudLow:           get('cloud_cover_low') ?? 0,
                cloudMid:           get('cloud_cover_mid') ?? 0,
                cloudHigh:          get('cloud_cover_high') ?? 0,
                precip:             get('precipitation_probability') ?? 0,
                wind:               get('wind_speed_10m') ?? 0,
                gust:               get('wind_gusts_10m') ?? 0,
                windDir1000:        get('wind_direction_1000hPa') ?? 0,
                windDir850:         get('wind_direction_850hPa') ?? 0,
                windDir700:         get('wind_direction_700hPa') ?? 0,
                windDir500:         get('wind_direction_500hPa') ?? 0,
                windDir300:         get('wind_direction_300hPa') ?? 0,
                wind_speed_1000hPa: get('wind_speed_1000hPa') ?? 0,
                wind_speed_850hPa:  get('wind_speed_850hPa') ?? 0,
                wind_speed_700hPa:  get('wind_speed_700hPa') ?? 0,
                wind_speed_500hPa:  get('wind_speed_500hPa') ?? 0,
                wind_speed_300hPa:  get('wind_speed_300hPa') ?? 0,
                temp500:            t500,
                temp850:            t850,
                temp700:            t700 ?? (t850 + t500) / 2,
                dew850:             d850 ?? (d2m ?? t2m - 10),
                dew700:             d700 ?? (d2m ?? t2m - 10),
                // RH direkt von API – genauer als Berechnung aus Taupunkt
                rh500:              get('relative_humidity_500hPa') ?? 50,
                rh700:              get('relative_humidity_700hPa') ?? null,
                rh850:              get('relative_humidity_850hPa') ?? null,
                cape:               Math.max(0, get('cape') ?? 0),
                directRadiation:    get('direct_radiation') ?? 0,
                precipAcc:          get('precipitation') ?? 0,
                freezingLevel:      get('freezing_level_height') ?? 3000,
            };

            hour.cin         = calcCIN(hour);
            hour.liftedIndex = calcLiftedIndex(hour);
            hour.pblHeight   = calcPBLHeight(hour);

            return hour;
        }

        // ── Schritt 2: Modellgewichtung nach Leadtime ──────────────────────
        // Quelle: Haiden et al. 2018 (ECMWF Technical Memorandum), DWD NWP-Verification
        function getModelWeight(model, leadtimeHours) {
            if (leadtimeHours <= 48) {
                return { icon_eu: 0.45, ecmwf_ifs025: 0.35, gfs_global: 0.20 }[model] ?? 0.33;
            } else if (leadtimeHours <= 120) {
                return { icon_eu: 0.33, ecmwf_ifs025: 0.42, gfs_global: 0.25 }[model] ?? 0.33;
            } else {
                return { icon_eu: 0.20, ecmwf_ifs025: 0.55, gfs_global: 0.25 }[model] ?? 0.33;
            }
        }

        function ensembleProb(probsByModel, leadtimeHours) {
            let weightedSum = 0;
            let totalWeight = 0;
            for (const [model, prob] of Object.entries(probsByModel)) {
                if (prob === null) continue;
                const w = getModelWeight(model, leadtimeHours);
                weightedSum += prob * w;
                totalWeight += w;
            }
            if (totalWeight === 0) return 0;
            return Math.round(weightedSum / totalWeight);
        }

        function ensembleMean(values) {
            const valid = values.filter(v => v !== null && !isNaN(v));
            if (!valid.length) return 0;
            return valid.reduce((s, v) => s + v, 0) / valid.length;
        }

        // ── Schritt 3: Stunden verarbeiten ──────────────────────────────────
        const hours = data.hourly.time.map((t, i) => {
            const forecastTime  = new Date(t);
            const leadtimeHours = Math.round((forecastTime - now) / 3600000);

            const modelHours = {};
            for (const model of MODELS) {
                modelHours[model] = extractModelHour(data.hourly, i, model);
            }

            const gewitter_by_model = {};
            const tornado_by_model  = {};
            const hagel_by_model    = {};
            const wind_by_model     = {};

            for (const model of MODELS) {
                const mh = modelHours[model];
                if (!mh) {
                    gewitter_by_model[model] = null;
                    tornado_by_model[model]  = null;
                    hagel_by_model[model]    = null;
                    wind_by_model[model]     = null;
                    continue;
                }
                const shear     = calcShear(mh);
                const srh       = calcSRH(mh, '0-3km');
                const dcape     = calcDCAPE(mh);
                const wmaxshear = calcWMAXSHEAR(mh.cape, shear);

                gewitter_by_model[model] = calculateProbability(mh);
                tornado_by_model[model]  = calculateTornadoProbability(mh, shear, srh);
                hagel_by_model[model]    = calculateHailProbability(mh, wmaxshear, dcape);
                wind_by_model[model]     = calculateWindProbability(mh, wmaxshear, dcape);
            }

            const probability        = ensembleProb(gewitter_by_model, leadtimeHours);
            const tornadoProbability = ensembleProb(tornado_by_model,  leadtimeHours);
            const hailProbability    = ensembleProb(hagel_by_model,    leadtimeHours);
            const windProbability    = ensembleProb(wind_by_model,     leadtimeHours);

            const validModelHours  = Object.values(modelHours).filter(Boolean);
            const displayTemperature = ensembleMean(validModelHours.map(mh => mh.temperature));
            const displayCape        = ensembleMean(validModelHours.map(mh => mh.cape));
            const displayShear       = ensembleMean(validModelHours.map(mh => calcShear(mh)));
            const displaySRH         = ensembleMean(validModelHours.map(mh => calcSRH(mh, '0-3km')));
            const displayDCAPE       = ensembleMean(validModelHours.map(mh => calcDCAPE(mh)));
            const displayWMAXSHEAR   = ensembleMean(validModelHours.map(mh => calcWMAXSHEAR(mh.cape, calcShear(mh))));

            return {
                time: t,
                probability,
                tornadoProbability,
                hailProbability,
                windProbability,
                temperature: Math.round(displayTemperature * 10) / 10,
                cape:        Math.round(displayCape),
                shear:       Math.round(displayShear * 10) / 10,
                srh:         Math.round(displaySRH * 10) / 10,
                dcape:       Math.round(displayDCAPE),
                wmaxshear:   Math.round(displayWMAXSHEAR),
            };
        });

        const nextHours = hours
            .filter(h => {
                const [dp, tp] = h.time.split('T');
                const [hr] = tp.split(':').map(Number);
                return dp > currentDateStr || (dp === currentDateStr && hr >= currentHour);
            })
            .slice(0, 24);

        const daysMap = new Map();
        hours.forEach(h => {
            const [dp] = h.time.split('T');
            if (dp >= currentDateStr) {
                if (!daysMap.has(dp)) {
                    daysMap.set(dp, {
                        date: dp,
                        maxProbability:        h.probability,
                        maxTornadoProbability: h.tornadoProbability,
                        maxHailProbability:    h.hailProbability,
                        maxWindProbability:    h.windProbability,
                    });
                } else {
                    const d = daysMap.get(dp);
                    d.maxProbability        = Math.max(d.maxProbability,        h.probability);
                    d.maxTornadoProbability = Math.max(d.maxTornadoProbability, h.tornadoProbability);
                    d.maxHailProbability    = Math.max(d.maxHailProbability,    h.hailProbability);
                    d.maxWindProbability    = Math.max(d.maxWindProbability,    h.windProbability);
                }
            }
        });

        const stunden = nextHours.map(h => ({
            timestamp:     h.time,
            gewitter:      h.probability,
            tornado:       h.tornadoProbability,
            hagel:         h.hailProbability,
            wind:          h.windProbability,
            gewitter_risk: categorizeRisk(h.probability),
            tornado_risk:  categorizeRisk(h.tornadoProbability),
            hagel_risk:    categorizeRisk(h.hailProbability),
            wind_risk:     categorizeRisk(h.windProbability),
        }));

        const tage = Array.from(daysMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(day => ({
                date:          day.date,
                gewitter:      day.maxProbability,
                tornado:       day.maxTornadoProbability,
                hagel:         day.maxHailProbability,
                wind:          day.maxWindProbability,
                gewitter_risk: categorizeRisk(day.maxProbability),
                tornado_risk:  categorizeRisk(day.maxTornadoProbability),
                hagel_risk:    categorizeRisk(day.maxHailProbability),
                wind_risk:     categorizeRisk(day.maxWindProbability),
            }));

        // Debug: erste 5 Stunden mit Modell-Einzelwerten + srh1km + meanRH
        const debugStunden = nextHours.slice(0, 5).map((h) => {
            const i = data.hourly.time.indexOf(h.time);
            const perModel = {};
            for (const model of MODELS) {
                const mh = extractModelHour(data.hourly, i, model);
                if (!mh) { perModel[model] = null; continue; }
                const shear = calcShear(mh);
                const srh   = calcSRH(mh, '0-3km');
                const dcape = calcDCAPE(mh);
                const wms   = calcWMAXSHEAR(mh.cape, shear);
                const rh850 = mh.rh850 ?? calcRelHum(mh.temp850, mh.dew850);
                const rh700 = mh.rh700 ?? calcRelHum(mh.temp700, mh.dew700);
                perModel[model] = {
                    gewitter: calculateProbability(mh),
                    tornado:  calculateTornadoProbability(mh, shear, srh),
                    hagel:    calculateHailProbability(mh, wms, dcape),
                    wind:     calculateWindProbability(mh, wms, dcape),
                    cape:     Math.round(mh.cape),
                    shear:    Math.round(shear * 10) / 10,
                    srh3km:   Math.round(srh * 10) / 10,
                    srh1km:   Math.round(calcSRH(mh, '0-1km') * 10) / 10,
                    wmaxshear: Math.round(wms),
                    cin:      mh.cin,
                    li:       mh.liftedIndex,
                    meanRH:   Math.round((rh850 + rh700 + mh.rh500) / 3),
                };
            }
            return {
                timestamp:         h.time,
                ensemble_gewitter: h.probability,
                ensemble_tornado:  h.tornadoProbability,
                per_modell:        perModel,
            };
        });

        return res.status(200).json({
            timezone,
            region,
            stunden,
            tage,
            debug: {
                hinweis: 'ESSL-Methodik: Pro Modell Wahrscheinlichkeit, dann gewichteter Ensemble-Mittelwert',
                stunden: debugStunden,
            },
        });

    } catch (error) {
        console.error('Fehler:', error);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// HILFSFUNKTIONEN
// ═══════════════════════════════════════════════════════════════════════════

function getRegion(lat, lon) {
    if (lat >= 35 && lat <= 70 && lon >= -10 && lon <= 40) return 'europe';
    return 'outside_europe';
}

function windToUV(speed, direction) {
    const rad = direction * Math.PI / 180;
    return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
}

function calcRelHum(temp, dew) {
    const es = 6.112 * Math.exp((17.67 * temp) / (temp + 243.5));
    const e  = 6.112 * Math.exp((17.67 * dew)  / (dew  + 243.5));
    return Math.min(100, Math.max(0, (e / es) * 100));
}

function calcCIN(hour) {
    const t2m  = hour.temperature ?? 0;
    const d2m  = hour.dew ?? t2m - 10;
    const t850 = hour.temp850 ?? 0;
    const t700 = hour.temp700 ?? 0;

    if (t2m === 0 && t850 === 0) return 0;

    const dewDep2m = t2m - d2m;
    const T_LCL    = t2m - 0.212 * dewDep2m - 0.001 * dewDep2m * dewDep2m;
    const z_LCL    = 125 * dewDep2m;
    const T2m_K    = t2m + 273.15;
    const T_LCL_K  = T_LCL + 273.15;
    const e_d2m    = 6.112 * Math.exp((17.67 * d2m) / (d2m + 243.5));
    const w2m      = 0.622 * e_d2m / (1013.25 - e_d2m);
    const w2m_gkg  = w2m * 1000;
    const theta_e_surface = T2m_K
        * Math.pow(1000 / 1013.25, 0.2854 * (1 - 0.00028 * w2m_gkg))
        * Math.exp((3.376 / T_LCL_K - 0.00254) * w2m_gkg * (1 + 0.00081 * w2m_gkg));

    const z850 = 1500;
    const DALR = 9.8;
    let T_parcel_850;
    if (z_LCL >= z850) {
        T_parcel_850 = t2m - DALR * (z850 / 1000);
    } else {
        T_parcel_850 = T_LCL - 4;
        for (let iter = 0; iter < 5; iter++) {
            const Tp_K = T_parcel_850 + 273.15;
            const es   = 6.112 * Math.exp((17.67 * T_parcel_850) / (T_parcel_850 + 243.5));
            const ws   = 0.622 * es / (850 - es);
            const ws_gkg = ws * 1000;
            const theta_e_test = Tp_K
                * Math.pow(1000 / 850, 0.2854 * (1 - 0.00028 * ws_gkg))
                * Math.exp((3.376 / Tp_K - 0.00254) * ws_gkg * (1 + 0.00081 * ws_gkg));
            T_parcel_850 += (theta_e_surface - theta_e_test) * 0.3;
        }
    }

    const dT_850       = T_parcel_850 - t850;
    const meanDT_low   = dT_850 / 2;
    const g            = 9.81;
    const T_mean_low_K = ((t2m + t850) / 2) + 273.15;
    const cin_low      = meanDT_low < 0 ? (meanDT_low / T_mean_low_K) * g * z850 : 0;

    let cin_mid = 0;
    if (dT_850 < 0) {
        let T_parcel_700 = T_parcel_850;
        for (let iter = 0; iter < 5; iter++) {
            const Tp_K = T_parcel_700 + 273.15;
            const es   = 6.112 * Math.exp((17.67 * T_parcel_700) / (T_parcel_700 + 243.5));
            const ws   = 0.622 * es / (700 - es);
            const ws_gkg = ws * 1000;
            const theta_e_test = Tp_K
                * Math.pow(1000 / 700, 0.2854 * (1 - 0.00028 * ws_gkg))
                * Math.exp((3.376 / Tp_K - 0.00254) * ws_gkg * (1 + 0.00081 * ws_gkg));
            T_parcel_700 += (theta_e_surface - theta_e_test) * 0.3;
        }
        const dT_700 = T_parcel_700 - t700;
        if (dT_700 < 0) {
            const meanDT_mid   = (dT_850 + dT_700) / 2;
            const T_mean_mid_K = ((t850 + t700) / 2) + 273.15;
            cin_mid = (meanDT_mid / T_mean_mid_K) * g * 1500;
        } else {
            const fraction   = dT_850 / (dT_850 - dT_700);
            const dz_neg     = fraction * 1500;
            const meanDT_mid = dT_850 / 2;
            cin_mid = (meanDT_mid / (t850 + 273.15)) * g * dz_neg;
        }
    }

    return Math.round(Math.max(-500, Math.min(0, cin_low + cin_mid)));
}

// Surface-Based LI (Bolton 1980) – konsistent mit CAPE (Taszarek 2020 / ESTOFEX)
function calcLiftedIndex(hour) {
    const t2m  = hour.temperature ?? 0;
    const d2m  = hour.dew ?? (t2m - 10);
    const t500 = hour.temp500 ?? 0;
    if (t2m === 0 && t500 === 0) return 0;

    const dewDep  = t2m - d2m;
    const T_LCL   = t2m - 0.212 * dewDep - 0.001 * dewDep * dewDep;
    const T_LCL_K = T_LCL + 273.15;
    const T2m_K   = t2m + 273.15;

    const e_d2m   = 6.112 * Math.exp((17.67 * d2m) / (d2m + 243.5));
    const w2m     = 0.622 * e_d2m / (1013.25 - e_d2m);
    const w2m_gkg = w2m * 1000;
    const theta_e = T2m_K
        * Math.pow(1000 / 1013.25, 0.2854 * (1 - 0.00028 * w2m_gkg))
        * Math.exp((3.376 / T_LCL_K - 0.00254) * w2m_gkg * (1 + 0.00081 * w2m_gkg));

    let T_parcel_500 = t500 + 4;
    for (let iter = 0; iter < 6; iter++) {
        const Tp_K   = T_parcel_500 + 273.15;
        const es     = 6.112 * Math.exp((17.67 * T_parcel_500) / (T_parcel_500 + 243.5));
        const ws     = 0.622 * es / (500 - es);
        const ws_gkg = ws * 1000;
        const theta_e_test = Tp_K
            * Math.pow(1000 / 500, 0.2854 * (1 - 0.00028 * ws_gkg))
            * Math.exp((3.376 / Tp_K - 0.00254) * ws_gkg * (1 + 0.00081 * ws_gkg));
        T_parcel_500 += (theta_e - theta_e_test) * 0.3;
    }

    return Math.round((t500 - T_parcel_500) * 10) / 10;
}

function calcPBLHeight(hour) {
    const t2m       = hour.temperature ?? 0;
    const t850      = hour.temp850 ?? 0;
    const t700      = hour.temp700 ?? 0;
    const radiation = hour.directRadiation ?? 0;
    const z850 = 1500, z700 = 3000, DALR = 9.8;

    const T_parcel_850 = t2m - DALR * (z850 / 1000);
    const T_parcel_700 = t2m - DALR * (z700 / 1000);
    let pblHeight = 200;

    if (T_parcel_850 >= t850) {
        if (T_parcel_700 >= t700) {
            const lapse_env = (t850 - t700) / (z700 - z850) * 1000;
            if (lapse_env >= DALR) {
                pblHeight = 3500;
            } else {
                const dT     = T_parcel_700 - t700;
                const extraZ = dT / (DALR - lapse_env) * 1000;
                pblHeight    = Math.min(4000, z700 + extraZ);
            }
        } else {
            const dT_850  = T_parcel_850 - t850;
            const dT_700  = T_parcel_700 - t700;
            pblHeight     = z850 + (dT_850 / (dT_850 - dT_700)) * (z700 - z850);
        }
    } else {
        const lapse_env_low = (t2m - t850) / z850 * 1000;
        if (lapse_env_low <= 0) {
            pblHeight = 200;
        } else {
            pblHeight = Math.max(200, Math.min((t2m - t850) / (DALR - lapse_env_low) * 1000, z850));
        }
    }

    // Additiv statt multiplikativ (verhindert 4000m-Überlauf)
    if      (radiation > 600) pblHeight = Math.min(4000, pblHeight + 400);
    else if (radiation > 300) pblHeight = Math.min(4000, pblHeight + 200);
    else if (radiation < 20)  pblHeight = Math.max(100,  pblHeight - 300);

    return Math.round(Math.max(100, Math.min(4000, pblHeight)));
}

function calcSRH(hour, layer = '0-3km') {
    const levels = layer === '0-1km'
        ? [
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_850hPa  ?? 0) / 3.6, wd: hour.windDir850  ?? 0 },
          ]
        : [
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_850hPa  ?? 0) / 3.6, wd: hour.windDir850  ?? 0 },
            { ws: (hour.wind_speed_700hPa  ?? 0) / 3.6, wd: hour.windDir700  ?? 0 },
          ];

    const winds    = levels.map(l => windToUV(l.ws, l.wd));
    const meanU    = winds.reduce((s, w) => s + w.u, 0) / winds.length;
    const meanV    = winds.reduce((s, w) => s + w.v, 0) / winds.length;
    const shearU   = winds[winds.length-1].u - winds[0].u;
    const shearV   = winds[winds.length-1].v - winds[0].v;
    const shearMag = Math.hypot(shearU, shearV) || 1;
    const devMag   = 7.5;
    const stormU   = meanU + devMag * (shearV / shearMag);
    const stormV   = meanV - devMag * (shearU / shearMag);

    let srh = 0;
    for (let i = 0; i < winds.length - 1; i++) {
        const u1 = winds[i].u   - stormU, v1 = winds[i].v   - stormV;
        const u2 = winds[i+1].u - stormU, v2 = winds[i+1].v - stormV;
        srh += u1 * v2 - u2 * v1;
    }
    return Math.round(Math.abs(srh) * 10) / 10;
}

// Korrekturfaktor 1.08: 500 hPa liegt bei ~5.5 km statt 6 km (ESSL-Standard)
function calcShear(hour) {
    const ws500  = (hour.wind_speed_500hPa  ?? 0) / 3.6;
    const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
    const w500   = windToUV(ws500,  hour.windDir500  ?? 0);
    const w1000  = windToUV(ws1000, hour.windDir1000 ?? 0);
    return Math.round(Math.hypot(w500.u - w1000.u, w500.v - w1000.v) * 1.08 * 10) / 10;
}

function calcIndices(hour) {
    const temp500 = hour.temp500 ?? 0;
    const temp850 = hour.temp850 ?? 0;
    const temp700 = hour.temp700 ?? 0;
    const dew850  = hour.dew850  ?? 0;
    const dew700  = hour.dew700  ?? 0;
    return {
        kIndex:      temp850 - temp500 + dew850 - (temp700 - dew700),
        showalter:   temp500 - (temp850 - 9.8 * 1.5),
        lapse:       (temp850 - temp500) / 3.5,
        liftedIndex: hour.liftedIndex ?? (temp500 - (temp850 - 9.8 * 1.5)),
    };
}

function calcSCP(cape, shear, srh, cin) {
    if (cape < 100 || shear < 6 || srh < 40 || shear < 12.5) return 0;
    const capeTerm  = cape / 1000;
    const srhTerm   = Math.min(srh / 50, 4.0);
    const shearTerm = Math.min(shear / 12, 1.5);
    const magCin    = -Math.min(0, cin);
    const cinTerm   = magCin < 40 ? 1.0 : Math.max(0.1, 1 - (magCin - 40) / 200);
    return Math.max(0, capeTerm * srhTerm * shearTerm * cinTerm);
}

function calcDCAPE(hour) {
    const temp700 = hour.temp700 ?? 0;
    const dew700  = hour.dew700  ?? 0;
    const temp500 = hour.temp500 ?? 0;
    if ((temp700 - dew700) > 35) return 0;

    const wetBulb700  = temp700 - 0.33 * (temp700 - dew700);
    const tempDiff    = wetBulb700 - temp500;
    if (tempDiff <= 0) return 0;

    const dewDep700   = temp700 - dew700;
    const moistFactor = dewDep700 > 20 ? 0.2 : dewDep700 > 10 ? 0.5 : dewDep700 > 5 ? 0.8 : 1.0;
    return Math.round(Math.max(0, (tempDiff / (temp700 + 273.15)) * 9.81 * 2500 * moistFactor));
}

function calcWMAXSHEAR(cape, shear) {
    if (cape <= 0 || shear <= 0) return 0;
    return Math.round(Math.sqrt(2 * cape) * shear);
}

function calcLCLHeight(temp2m, dew2m) {
    if (temp2m <= 0 || dew2m <= 0) return 2000;
    return Math.max(0, 125 * (temp2m - dew2m));
}

function calcMidLevelLapseRate(temp700, temp500) {
    return (temp700 - temp500) / 2.0; // K/km (700→500 hPa ≈ 2 km)
}

function calcMoistureDepth(dew850, dew700, temp850, temp700) {
    return (calcRelHum(temp850, dew850) + calcRelHum(temp700, dew700)) / 2;
}

function calcELI(cape, cin, pblHeight) {
    if (cape < 50) return 0;
    const pblFactor = pblHeight > 1500 ? 1.2 : pblHeight > 1000 ? 1.0 : pblHeight > 500 ? 0.8 : 0.6;
    const magCin    = -Math.min(0, cin);
    const cinFactor = magCin < 25 ? 1.0 : magCin < 50 ? 0.9 : magCin < 100 ? 0.7 : magCin < 150 ? 0.5 : 0.3;
    return cape * pblFactor * cinFactor;
}

// normCAPE=750 (Europa-kalibriert, Taszarek 2020: Median Tornado-CAPE ~470 J/kg)
function calcSTP(cape, srh, shear, liftedIndex, cin, temp2m = null, dew2m = null) {
    if (cape < 80 || srh < 40 || shear < 6 || shear < 12.5) return 0;

    let lclTerm;
    if (temp2m !== null && dew2m !== null) {
        const lclHeight = calcLCLHeight(temp2m, dew2m);
        if      (lclHeight < 1000)  lclTerm = 1.0;
        else if (lclHeight >= 2000) lclTerm = 0.0;
        else                        lclTerm = (2000 - lclHeight) / 1000;
    } else {
        lclTerm = liftedIndex <= -4 ? 1.0 : liftedIndex <= -2 ? 0.8 : liftedIndex <= 0 ? 0.5 : 0.2;
    }

    const capeTerm  = Math.min(cape / 750, 3.0);
    const srhTerm   = Math.min(srh / 150, 3.0);
    const shearTerm = shear >= 30 ? 1.5 : (shear / 20);

    let cinTerm;
    if      (cin >= -50)  cinTerm = 1.0;
    else if (cin <= -200) cinTerm = 0.0;
    else                  cinTerm = (200 + cin) / 150;

    return Math.max(0, capeTerm * srhTerm * shearTerm * lclTerm * cinTerm);
}

// Theta-E nach Bolton 1980 (ESTOFEX-Standard)
// Schwellen aus Guide: < 320K stabil, 320-335 schwach, 335-345 gut, > 345 sehr instabil
function calcThetaE(tempC, dewC, pressHPa) {
    const T_K = tempC + 273.15;
    const e   = 6.112 * Math.exp((17.67 * dewC) / (dewC + 243.5));
    const q   = 0.622 * e / (pressHPa - e);
    const Lv  = 2.501e6;
    const cp  = 1005;
    return T_K * Math.pow(1000 / pressHPa, 0.285) * Math.exp((Lv * q) / (cp * T_K));
}

function categorizeRisk(prob) {
    const p = Math.max(0, Math.min(100, Math.round(prob ?? 0)));
    if (p >= 70) return { level: 3, label: 'high' };
    if (p >= 45) return { level: 2, label: 'moderate' };
    if (p >= 15) return { level: 1, label: 'tstorm' };
    return { level: 0, label: 'none' };
}

// ═══════════════════════════════════════════════════════════════════════════
// WAHRSCHEINLICHKEITS-FUNKTIONEN
// ═══════════════════════════════════════════════════════════════════════════

function calculateHailProbability(hour, wmaxshear, dcape) {
    const cape          = Math.max(0, hour.cape ?? 0);
    const shear         = calcShear(hour);
    const temp500       = hour.temp500 ?? 0;
    const temp700       = hour.temp700 ?? 0;
    const freezingLevel = hour.freezingLevel ?? 4000;
    const temp2m        = hour.temperature ?? 0;
    const dew           = hour.dew ?? 0;
    const lclHeight     = calcLCLHeight(temp2m, dew);
    const midLapse      = calcMidLevelLapseRate(temp700, temp500);
    const srh           = calcSRH(hour, '0-3km');

    // ESTOFEX Hagel-Guideline: CAPE > 1000, Shear > 15-20, WBZ < 3000m
    if (cape < 250)           return 0;
    if (shear < 10)           return 0;
    if (wmaxshear < 450)      return 0;
    if (freezingLevel > 3500) return 0; // WBZ > 3500m = meist kleiner Hagel

    let score = 0;

    // CAPE (ESTOFEX: significant hail bei > 2000 J/kg)
    if      (cape >= 2000) score += 28;
    else if (cape >= 1500) score += 24;
    else if (cape >= 1200) score += 20;
    else if (cape >= 800)  score += 15;
    else if (cape >= 600)  score += 9;
    else if (cape >= 350)  score += 4;

    // WMAXSHEAR – Taszarek 2020 Haupt-Prädiktor
    if      (wmaxshear >= 1700) score += 30;
    else if (wmaxshear >= 1350) score += 26;
    else if (wmaxshear >= 1050) score += 21;
    else if (wmaxshear >= 850)  score += 15;
    else if (wmaxshear >= 650)  score += 9;
    else if (wmaxshear >= 500)  score += 4;

    // Deep-layer shear (ESTOFEX: significant hail bei > 20-25 m/s)
    if      (shear >= 24) score += 13;
    else if (shear >= 20) score += 10;
    else if (shear >= 17) score += 7;
    else if (shear >= 14) score += 4;
    else if (shear >= 10) score += 2;

    if      (srh >= 250) score += 10;
    else if (srh >= 200) score += 8;
    else if (srh >= 150) score += 5;
    else if (srh >= 120) score += 3;

    // EL-Temperatur Proxy via temp500 (ESTOFEX: Superzellen bei < -65°C)
    if      (temp500 <= -22) score += 11;
    else if (temp500 <= -20) score += 9;
    else if (temp500 <= -18) score += 6;
    else if (temp500 <= -16) score += 4;
    else if (temp500 <= -14) score += 2;
    else if (temp500 > -10)  score -= 4;

    // WBZ / Gefrierniveau (ESTOFEX: < 2000m sehr großes Hagelpotential)
    if      (freezingLevel <= 2200) score += 13;
    else if (freezingLevel <= 2700) score += 9;
    else if (freezingLevel <= 3200) score += 5;
    else if (freezingLevel <= 3500) score += 2;
    else if (freezingLevel > 3200)  score -= 5;

    if      (lclHeight >= 1500) score += 7;
    else if (lclHeight >= 1000) score += 4;
    else if (lclHeight >= 700)  score += 1;
    else if (lclHeight < 400)   score -= 5;

    if      (midLapse >= 8.5) score += 7;
    else if (midLapse >= 8.0) score += 5;
    else if (midLapse >= 7.5) score += 4;
    else if (midLapse >= 7.0) score += 2;
    else if (midLapse < 6.0)  score -= 3;

    // Mixing Ratio (ESTOFEX: > 10 g/kg gute Gewitterfeuchte)
    const e_dew    = 6.112 * Math.exp((17.67 * dew) / (dew + 243.5));
    const mixRatio = 622 * e_dew / (1013.25 - e_dew);
    if      (mixRatio >= 12 && cape >= 800) score += 7;
    else if (mixRatio >= 10 && cape >= 600) score += 4;
    else if (mixRatio >= 8  && cape >= 400) score += 2;
    else if (mixRatio < 5   && cape < 800)  score -= 4;

    if      (dcape >= 1000 && cape >= 700) score += 5;
    else if (dcape >= 800  && cape >= 550) score += 3;
    else if (dcape >= 600  && cape >= 400) score += 1;

    if      (hour.rh500 < 30 && cape >= 700) score += 6;
    else if (hour.rh500 < 40 && cape >= 550) score += 4;
    else if (hour.rh500 < 50 && cape >= 450) score += 2;
    else if (hour.rh500 > 80 && cape < 900)  score -= 5;

    // Mittlere RH (AR-CHaMo Rädler 2018 – API-Werte bevorzugt)
    const rh850  = hour.rh850 ?? calcRelHum(hour.temp850 ?? 0, hour.dew850 ?? 0);
    const rh700  = hour.rh700 ?? calcRelHum(hour.temp700 ?? 0, hour.dew700 ?? 0);
    const meanRH = (rh850 + rh700 + (hour.rh500 ?? 50)) / 3;
    if      (meanRH >= 70 && cape >= 600) score += 5;
    else if (meanRH >= 60 && cape >= 400) score += 3;
    else if (meanRH < 35)                 score -= 4;

    let factor = 1.0;
    if      (cape >= 900 && shear >= 17) factor = 1.15;
    else if (cape >= 700 && shear >= 14) factor = 1.1;
    else if (cape < 500  || shear < 10)  factor = 0.7;
    if      (freezingLevel <= 2700 && temp500 <= -18) factor *= 1.1;
    else if (freezingLevel > 3200  || temp500 > -12)  factor *= 0.8;

    score = Math.round(score * factor);
    if (cape < 400 || shear < 12 || wmaxshear < 600) score = Math.min(score, 40);
    if (cape >= 1500 && shear >= 20 && wmaxshear >= 1200 && freezingLevel <= 2500 && temp500 <= -18) {
        score = Math.min(100, score + 10);
    }
    return Math.min(100, Math.max(0, score));
}

function calculateWindProbability(hour, wmaxshear, dcape) {
    const cape     = Math.max(0, hour.cape ?? 0);
    const shear    = calcShear(hour);
    const wind10m  = hour.wind ?? 0;
    const gust     = hour.gust ?? 0;
    const gustDiff = gust - wind10m;
    const temp700  = hour.temp700 ?? 0;
    const dew700   = hour.dew700  ?? 0;
    const temp500  = hour.temp500 ?? 0;

    // ESTOFEX Z_wind: DCAPE + CAPE + Shear + Midlevel_dry_air + PWAT
    if (dcape < 250 && wmaxshear < 450) return 0;
    if (shear < 9 && cape < 450)        return 0;
    if (gust < 60)                      return 0;

    let score = 0;

    // DCAPE – primärer Prädiktor (ESTOFEX Z_wind b1)
    if      (dcape >= 1400) score += 34;
    else if (dcape >= 1200) score += 29;
    else if (dcape >= 1000) score += 25;
    else if (dcape >= 800)  score += 19;
    else if (dcape >= 600)  score += 13;
    else if (dcape >= 400)  score += 7;
    else if (dcape >= 300)  score += 4;

    if      (wmaxshear >= 1200) score += 31;
    else if (wmaxshear >= 1000) score += 27;
    else if (wmaxshear >= 850)  score += 21;
    else if (wmaxshear >= 700)  score += 15;
    else if (wmaxshear >= 550)  score += 10;
    else if (wmaxshear >= 450)  score += 6;
    else if (wmaxshear >= 350)  score += 3;

    if      (shear >= 24) score += 12;
    else if (shear >= 20) score += 9;
    else if (shear >= 17) score += 7;
    else if (shear >= 14) score += 4;
    else if (shear >= 11) score += 2;
    else if (shear >= 9)  score += 1;

    const srh3km    = calcSRH(hour, '0-3km');
    const w850_low  = windToUV((hour.wind_speed_850hPa  ?? 0) / 3.6, hour.windDir850  ?? 0);
    const w1000_low = windToUV((hour.wind_speed_1000hPa ?? 0) / 3.6, hour.windDir1000 ?? 0);
    const shear_low = Math.hypot(w850_low.u - w1000_low.u, w850_low.v - w1000_low.v);
    if      (shear_low >= 15) score += 10;
    else if (shear_low >= 12) score += 7;
    else if (shear_low >= 9)  score += 4;
    else if (shear_low >= 6)  score += 2;

    if      (srh3km >= 200) score += 8;
    else if (srh3km >= 150) score += 6;
    else if (srh3km >= 100) score += 4;
    else if (srh3km >= 60)  score += 2;

    if      (cape >= 1500) score += 11;
    else if (cape >= 1200) score += 9;
    else if (cape >= 800)  score += 7;
    else if (cape >= 450)  score += 4;
    else if (cape >= 250)  score += 2;

    if      (gustDiff >= 40) score += 15;
    else if (gustDiff >= 30) score += 11;
    else if (gustDiff >= 25) score += 9;
    else if (gustDiff >= 20) score += 6;
    else if (gustDiff >= 15) score += 3;
    else if (gustDiff >= 8)  score += 1;

    if      (gust >= 130) score += 20;
    else if (gust >= 110) score += 16;
    else if (gust >= 90)  score += 12;
    else if (gust >= 80)  score += 7;
    else if (gust >= 70)  score += 3;
    else if (gust >= 60)  score += 1;

    // Midlevel dry air (ESTOFEX Z_wind b4: trocken = stärkere Downbursts)
    const dewDep700 = temp700 - dew700;
    if      (dewDep700 >= 20 && dcape >= 600) score += 8;
    else if (dewDep700 >= 15 && dcape >= 500) score += 5;
    else if (dewDep700 >= 8  && dcape >= 350) score += 3;
    else if (dewDep700 < 5   && dcape < 800)  score -= 4;

    if      (temp500 <= -20 && dcape >= 600) score += 6;
    else if (temp500 <= -16 && dcape >= 500) score += 4;
    else if (temp500 <= -12 && dcape >= 400) score += 2;

    if      (hour.rh500 < 35 && dcape >= 600) score += 5;
    else if (hour.rh500 < 45 && dcape >= 500) score += 3;
    else if (hour.rh500 < 55 && dcape >= 400) score += 1;

    // Mittlere RH (API-Werte bevorzugt, Fallback auf Taupunkt)
    const rh850w   = hour.rh850 ?? calcRelHum(hour.temp850 ?? 0, hour.dew850 ?? 0);
    const rh700w   = hour.rh700 ?? calcRelHum(hour.temp700 ?? 0, hour.dew700 ?? 0);
    const meanRH_w = (rh850w + rh700w + (hour.rh500 ?? 50)) / 3;
    if      (meanRH_w < 35 && dcape >= 600) score += 6;
    else if (meanRH_w < 45 && dcape >= 500) score += 3;
    else if (meanRH_w > 75 && dcape < 800)  score -= 4;

    let factor = 1.0;
    if      (dcape >= 1000 && wmaxshear >= 1100) factor = 1.2;
    else if (dcape >= 800  && wmaxshear >= 900)  factor = 1.15;
    else if (dcape >= 550  && wmaxshear >= 650)  factor = 1.1;
    else if (dcape < 350   || wmaxshear < 550)   factor = 0.75;
    if      (shear >= 17 && cape >= 550)         factor *= 1.1;
    else if (shear < 11  && cape < 350)          factor *= 0.8;
    if      (gust >= 100 && dcape >= 800)        factor *= 1.1;
    else if (gust < 75   && dcape < 450)         factor *= 0.85;

    score = Math.round(score * factor);
    if (dcape < 350 || wmaxshear < 550 || gust < 70) score = Math.min(score, 35);
    if (dcape >= 1200 && wmaxshear >= 1300 && shear >= 20 && gust >= 110) score = Math.min(100, score + 12);
    if (cape < 500 && shear >= 18 && wmaxshear >= 800 && dcape >= 600)    score = Math.min(100, score + 8);

    return Math.min(100, Math.max(0, score));
}

function calculateProbability(hour) {
    const temp2m     = hour.temperature ?? 0;
    const dew        = hour.dew ?? 0;
    const cape       = Math.max(0, hour.cape ?? 0);
    const cin        = hour.cin ?? 0;
    const magCin     = -Math.min(0, cin);
    const precipAcc  = hour.precipAcc ?? 0;
    const precipProb = hour.precip ?? 0;
    const pblHeight  = hour.pblHeight ?? 1000;

    if (temp2m < 3 && cape < 300)                          return 0;
    if (temp2m < 8 && cape < 180 && calcShear(hour) < 15) return 0;
    if (cape < 80 && precipAcc < 0.1 && precipProb < 15)  return 0;

    const shear         = calcShear(hour);
    const srh1km        = calcSRH(hour, '0-1km');
    const srh           = calcSRH(hour, '0-3km');
    const { kIndex, liftedIndex } = calcIndices(hour);
    const relHum2m      = calcRelHum(temp2m, dew);
    const lclHeight     = calcLCLHeight(temp2m, dew);
    const midLapse      = calcMidLevelLapseRate(hour.temp700 ?? 0, hour.temp500 ?? 0);
    const moistureDepth = calcMoistureDepth(hour.dew850 ?? 0, hour.dew700 ?? 0, hour.temp850 ?? 0, hour.temp700 ?? 0);
    const eli           = calcELI(cape, cin, pblHeight);
    const ehi           = (cape * srh1km) / 160000;
    const scp           = calcSCP(cape, shear, srh, cin);
    const stp           = calcSTP(cape, srh1km, shear, liftedIndex, cin, temp2m, dew);
    const wmaxshear     = calcWMAXSHEAR(cape, shear);
    const dcape         = calcDCAPE(hour);

    // Mittlere RH 850/700/500 hPa (AR-CHaMo Rädler 2018 – API-Werte bevorzugt)
    const rh850  = hour.rh850 ?? calcRelHum(hour.temp850 ?? 0, hour.dew850 ?? 0);
    const rh700  = hour.rh700 ?? calcRelHum(hour.temp700 ?? 0, hour.dew700 ?? 0);
    const meanRH = (rh850 + rh700 + (hour.rh500 ?? 50)) / 3;

    // Theta-E 850 hPa (ESTOFEX-Standard)
    const thetaE850 = calcThetaE(hour.temp850 ?? 0, hour.dew850 ?? 0, 850);

    // ── HSLC-Regime (Wind-Feld-Gewitter) ──────────────────────────────────
    // Tuschy / Rädler 2018: CAPE < 300 + hoher Shear = eigener Pfad
    const isHSLC = cape < 300 && shear >= 18;
    if (isHSLC) {
        let hslcScore = 0;
        if      (shear >= 25) hslcScore += 30;
        else if (shear >= 20) hslcScore += 20;
        else                  hslcScore += 10;
        if      (meanRH >= 65) hslcScore += 15;
        else if (meanRH <  50) hslcScore -= 15;
        if (temp2m < 8) hslcScore = Math.round(hslcScore * 0.6);
        return Math.min(60, Math.max(0, hslcScore));
    }

    let score = 0;

    // CAPE – abgeflachte Kurve (Westermayer 2017: ab ~400 J/kg kaum mehr Zunahme)
    if      (cape >= 2000) score += 16;
    else if (cape >= 1500) score += 14;
    else if (cape >= 1200) score += 12;
    else if (cape >= 800)  score += 10;
    else if (cape >= 500)  score += 8;
    else if (cape >= 300)  score += 6;
    else if (cape >= 150)  score += 3;

    // EL-Temperatur Proxy (ESTOFEX: -60°C starke Gewitter, < -65°C Superzellen)
    const elTemp = hour.temp500 ?? 0;
    if      (elTemp <= -20 && cape >= 200) score += 8;
    else if (elTemp <= -15 && cape >= 150) score += 5;
    else if (elTemp <= -10 && cape >= 100) score += 3;
    else if (elTemp > -5   && cape < 500)  score -= 5;

    if      (eli >= 2000) score += 10;
    else if (eli >= 1200) score += 7;
    else if (eli >= 800)  score += 5;
    else if (eli >= 400)  score += 3;

    if      (magCin < 25 && cape >= 300) score += 6;
    else if (magCin < 50 && cape >= 200) score += 3;
    else if (magCin > 200) score -= 18;
    else if (magCin > 100) score -= 10;
    else if (magCin > 50)  score -= 5;

    // SCP: erst ab 1.0 (Europa-Schwelle für organisierte Konvektion)
    if      (scp >= 3.0) score += 24;
    else if (scp >= 2.0) score += 20;
    else if (scp >= 1.5) score += 16;
    else if (scp >= 1.0) score += 12;

    if      (stp >= 2.0) score += 18;
    else if (stp >= 1.5) score += 15;
    else if (stp >= 1.0) score += 12;
    else if (stp >= 0.5) score += 8;
    else if (stp >= 0.3) score += 4;

    // EHI: erst ab 0.5
    if      (ehi >= 2.5) score += 14;
    else if (ehi >= 2.0) score += 12;
    else if (ehi >= 1.0) score += 9;
    else if (ehi >= 0.5) score += 5;

    if      (wmaxshear >= 1500) score += 22;
    else if (wmaxshear >= 1200) score += 18;
    else if (wmaxshear >= 900)  score += 14;
    else if (wmaxshear >= 700)  score += 10;
    else if (wmaxshear >= 500)  score += 6;
    else if (wmaxshear >= 400)  score += 3;
    else if (wmaxshear >= 300)  score += 1;

    if      (shear >= 25) score += 14;
    else if (shear >= 20) score += 11;
    else if (shear >= 15) score += 8;
    else if (shear >= 12) score += 5;
    else if (shear >= 10) score += 3;
    else if (shear >= 8)  score += 1;

    if      (srh >= 250) score += 10;
    else if (srh >= 200) score += 8;
    else if (srh >= 150) score += 6;
    else if (srh >= 120) score += 4;
    else if (srh >= 80)  score += 2;

    if      (lclHeight < 500)   score += 8;
    else if (lclHeight < 800)   score += 6;
    else if (lclHeight < 1200)  score += 4;
    else if (lclHeight < 1500)  score += 2;
    else if (lclHeight >= 2500) score -= 6;

    if      (midLapse >= 8.0) score += 8;
    else if (midLapse >= 7.5) score += 6;
    else if (midLapse >= 7.0) score += 4;
    else if (midLapse >= 6.5) score += 2;
    else if (midLapse < 5.5 && cape < 800) score -= 5;

    if      (moistureDepth >= 75) score += 6;
    else if (moistureDepth >= 65) score += 4;
    else if (moistureDepth >= 55) score += 2;
    else if (moistureDepth < 40 && cape < 600) score -= 4;

    // Mittlere RH (AR-CHaMo / Westermayer 2017)
    // < 50%: starke Unterdrückung der Blitzaktivität
    if      (meanRH >= 75) score += 8;
    else if (meanRH >= 65) score += 5;
    else if (meanRH >= 55) score += 2;
    else if (meanRH < 50)  score -= 12;
    else if (meanRH < 40)  score -= 20;

    // Theta-E 850 hPa (ESTOFEX: > 335K gute Gewitterumgebung, > 345K sehr instabil)
    if      (thetaE850 >= 345) score += 8;
    else if (thetaE850 >= 335) score += 5;
    else if (thetaE850 >= 325) score += 2;
    else if (thetaE850 < 315)  score -= 4;

    if      (liftedIndex <= -7) score += 12;
    else if (liftedIndex <= -6) score += 10;
    else if (liftedIndex <= -4) score += 7;
    else if (liftedIndex <= -2) score += 4;
    else if (liftedIndex <= 0)  score += 1;

    if      (kIndex >= 38) score += 8;
    else if (kIndex >= 35) score += 6;
    else if (kIndex >= 30) score += 4;
    else if (kIndex >= 25) score += 2;

    // Mixing Ratio 850 hPa (ESTOFEX: > 10 g/kg gute Gewitterfeuchte, > 13 sehr feucht)
    const e850_dew = 6.112 * Math.exp((17.67 * (hour.dew850 ?? 0)) / ((hour.dew850 ?? 0) + 243.5));
    const mixR850  = 1000 * 0.622 * e850_dew / (850 - e850_dew);
    if      (mixR850 >= 13) score += 8;
    else if (mixR850 >= 10) score += 5;
    else if (mixR850 >= 6)  score += 2;
    else if (mixR850 < 4)   score -= 6;

    if      (dew >= 18 && temp2m >= 18) score += 6;
    else if (dew >= 16 && temp2m >= 16) score += 4;
    else if (dew >= 13 && temp2m >= 13) score += 2;

    if      (relHum2m >= 75 && temp2m >= 18) score += 5;
    else if (relHum2m >= 70 && temp2m >= 16) score += 3;
    else if (relHum2m >= 65 && temp2m >= 14) score += 1;

    if      (precipAcc >= 3.0 && cape >= 600) score += 8;
    else if (precipAcc >= 2.0 && cape >= 400) score += 6;
    else if (precipAcc >= 1.0 && cape >= 300) score += 4;
    else if (precipAcc >= 0.5 && cape >= 200) score += 2;

    if      (precipProb >= 70 && cape >= 500) score += 6;
    else if (precipProb >= 55 && cape >= 400) score += 4;
    else if (precipProb >= 40 && cape >= 300) score += 2;

    if (precipAcc > 3 && cape < 300 && shear < 10) score -= 10;
    else if (precipAcc > 2 && cape < 200)           score -= 6;

    if      (hour.rh500 < 30 && cape >= 600) score += 7;
    else if (hour.rh500 < 40 && cape >= 500) score += 5;
    else if (hour.rh500 < 50 && cape >= 400) score += 3;
    else if (hour.rh500 > 90 && cape < 800)  score -= 6;

    const isNight     = hour.directRadiation < 20;
    const isDaytime   = hour.directRadiation >= 200;
    const isStrongDay = hour.directRadiation >= 600;

    if      (isStrongDay && temp2m >= 14 && cape >= 300)    score += 7;
    else if (isDaytime   && temp2m >= 12 && cape >= 200)    score += 4;
    else if (isNight) {
        const llj = srh >= 120 && shear >= 12 && hour.wind >= 8;
        if      (llj && cape >= 500)              score += 5;
        else if (!llj && shear < 10 && cape < 400) score -= 4;
        else if (cape >= 600 && srh >= 100)       score += 2;
    }

    if      (hour.wind >= 6  && hour.wind <= 18 && temp2m >= 12) score += 3;
    else if (hour.wind > 18  && hour.wind <= 25 && temp2m >= 12) score += 5;
    if      (hour.wind > 30  && cape < 1200)                     score -= 6;

    const gustDiff = hour.gust - hour.wind;
    if      (gustDiff > 15 && cape >= 600 && temp2m >= 12) score += 6;
    else if (gustDiff > 12 && cape >= 500)                 score += 4;
    else if (gustDiff > 8  && cape >= 300)                 score += 2;

    if      (dcape >= 1000 && cape >= 400) score += 7;
    else if (dcape >= 800  && cape >= 300) score += 5;
    else if (dcape >= 600  && cape >= 200) score += 3;
    else if (dcape >= 400  && cape >= 150) score += 1;

    if      (pblHeight >= 2000 && cape >= 300) score += 4;
    else if (pblHeight >= 1500 && cape >= 200) score += 2;
    else if (pblHeight < 300   && cape < 500)  score -= 3;

    // Temperatur-Skalierung
    if      (temp2m < 8)  score = Math.round(score * (shear < 15 && cape < 500 ? 0.4 : 0.6));
    else if (temp2m < 12) score = Math.round(score * 0.7);
    else if (temp2m < 15) score = Math.round(score * 0.85);

    if (score > 0 && cape < 100 && shear < 8)     score = Math.max(0, score - 10);
    if (score > 0 && magCin > 150 && cape < 1000) score = Math.max(0, score - 12);
    if (shear >= 20 && cape >= 150 && score < 30) score = Math.min(score + 5, 35);

    return Math.min(100, Math.max(0, Math.round(score)));
}

// ── Tornado-Wahrscheinlichkeit ──────────────────────────────────────────────
// Hauptprädiktoren: WMAXSHEAR + SRH 0-1km
// Quellen: Taszarek 2020 Part II, Taszarek 2013 (Polen), Púčik 2015 (Zentraleuropa)
// ESTOFEX Z_tornado = f(CAPE, SRH_0-1km, Shear_0-6km, LCL, Storm_motion)
// Kein STP – zu USA-lastig auch mit normCAPE=750
// Kein Veering-Faktor – in Europa kein zuverlässiges Signal (Púčik 2015)
// LCL nur schwache Korrektur – kein guter Diskriminator in Europa
function calculateTornadoProbability(hour, shear, srh) {
    const temp2m = hour.temperature ?? 0;
    const dew    = hour.dew ?? 0;
    const cape   = Math.max(0, hour.cape ?? 0);
    const cin    = hour.cin ?? 0;
    const magCin = -Math.min(0, cin);

    // Basis-Filter
    if (temp2m < 5)   return 0;
    if (magCin > 200) return 0;
    if (cape < 100 && shear < 20) return 0;

    const srh1km    = calcSRH(hour, '0-1km');
    const wmaxshear = calcWMAXSHEAR(cape, shear);

    let score = 0;

    // WMAXSHEAR – Haupt-Prädiktor (enthält CAPE + Shear kombiniert)
    // Taszarek 2020: bedingte Tornadowahrsch. am besten durch WMAXSHEAR + SRH1km
    if      (wmaxshear >= 1000) score += 30;
    else if (wmaxshear >= 700)  score += 20;
    else if (wmaxshear >= 500)  score += 12;
    else if (wmaxshear >= 300)  score += 5;
    else                        score -= 10;

    // SRH 0-1km – wichtigster kinematischer Prädiktor
    // Taszarek 2013: Europa Median SRH3 signifikanter Tornado ~117 m²/s²
    // SRH1km ≈ 60-70% von SRH3 → Median SRH1km ~70-80 m²/s²
    if      (srh1km >= 200) score += 30;
    else if (srh1km >= 150) score += 22;
    else if (srh1km >= 100) score += 14;
    else if (srh1km >= 60)  score += 6;
    else if (srh1km >= 30)  score += 1;
    else                    score -= 20;

    // LCL: nur schwache Korrektur (Púčik 2015: kein guter Diskriminator Europa)
    const lclHeight = calcLCLHeight(temp2m, dew);
    if      (lclHeight >= 2500) score -= 5;
    else if (lclHeight >= 2000) score -= 2;

    // CIN-Dämpfung
    if      (magCin > 150) score -= 10;
    else if (magCin > 100) score -= 6;
    else if (magCin > 50)  score -= 2;

    // Temperatur-Skalierung
    if      (temp2m < 8)  score = Math.round(score * 0.5);
    else if (temp2m < 12) score = Math.round(score * 0.75);

    // Harte Grenzen: ohne Rotation kein Tornado
    if (srh1km < 30)  return 0;
    if (srh1km < 60)  return Math.min(3,  Math.max(0, score));
    if (shear  < 10)  return Math.min(3,  Math.max(0, score));

    return Math.min(100, Math.max(0, Math.round(score)));
}