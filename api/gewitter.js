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
                    `wind_direction_975hPa,wind_direction_950hPa,wind_direction_925hPa,wind_direction_900hPa,` +
                    `wind_speed_1000hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `wind_speed_975hPa,wind_speed_950hPa,wind_speed_925hPa,wind_speed_900hPa,` +
                    `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
                    `relative_humidity_500hPa,relative_humidity_850hPa,relative_humidity_700hPa,cape,` +
                    `dew_point_850hPa,dew_point_700hPa,direct_radiation,total_column_integrated_water_vapour,` +
                    `freezing_level_height,precipitation,boundary_layer_height,convective_inhibition,lifted_index&forecast_days=16&models=icon_seamless,ecmwf_ifs025,gfs_global&timezone=auto`;

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

        const MODELS = ['icon_seamless', 'ecmwf_ifs025', 'gfs_global'];

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
                windDir975:         get('wind_direction_975hPa') ?? 0,
                windDir950:         get('wind_direction_950hPa') ?? 0,
                windDir925:         get('wind_direction_925hPa') ?? 0,
                windDir900:         get('wind_direction_900hPa') ?? 0,
                wind_speed_1000hPa: get('wind_speed_1000hPa') ?? 0,
                wind_speed_850hPa:  get('wind_speed_850hPa') ?? 0,
                wind_speed_700hPa:  get('wind_speed_700hPa') ?? 0,
                wind_speed_500hPa:  get('wind_speed_500hPa') ?? 0,
                wind_speed_300hPa:  get('wind_speed_300hPa') ?? 0,
                wind_speed_975hPa:  get('wind_speed_975hPa') ?? 0,
                wind_speed_950hPa:  get('wind_speed_950hPa') ?? 0,
                wind_speed_925hPa:  get('wind_speed_925hPa') ?? 0,
                wind_speed_900hPa:  get('wind_speed_900hPa') ?? 0,
                pwat:               get('total_column_integrated_water_vapour') ?? 25,
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
                cin:                get('convective_inhibition') ?? null,
                liftedIndex:        get('lifted_index') ?? null,
                pblHeight:          get('boundary_layer_height') ?? null,
            };

            hour.cin        = hour.cin        ?? calcCIN(hour);
            hour.liftedIndex = hour.liftedIndex ?? calcLiftedIndex(hour);
            hour.pblHeight   = hour.pblHeight   ?? calcPBLHeight(hour);

            return hour;
        }

        // ── Schritt 2: Modellgewichtung nach Leadtime ──────────────────────
        // Quelle: Haiden et al. 2018 (ECMWF Technical Memorandum), DWD NWP-Verification
        function getModelWeight(model, leadtimeHours) {
            return 1/3;
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
            const tornadoProbability = Math.min(
                ensembleProb(tornado_by_model, leadtimeHours),
                probability  // Tornado kann nie wahrscheinlicher sein als Gewitter
            );
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
            .slice(0, 24); // max 72 Stunden

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

        // Debug: erste 3 Stunden mit ALLEN Modell-Einzelwerten
        const debugStunden = nextHours.slice(0, 20).map((h) => {
            const i = data.hourly.time.indexOf(h.time);
            const perModel = {};
            for (const model of MODELS) {
                const mh = extractModelHour(data.hourly, i, model);
                if (!mh) { perModel[model] = null; continue; }

                const shear    = calcShear(mh);
                const srh3km   = calcSRH(mh, '0-3km');
                const srh1km   = calcSRH(mh, '0-1km');
                const dcape    = calcDCAPE(mh);
                const wms      = calcWMAXSHEAR(mh.cape, shear);
                const ebwd     = calcEBWD(mh);
                const scp      = calcSCP(mh.cape, shear, srh3km, mh.cin);
                const stp      = calcSTP(mh.cape, srh1km, shear, mh.liftedIndex, mh.cin, mh.temperature, mh.dew, mh);
                const ehi      = (mh.cape * srh1km) / 160000;
                const lcl      = calcLCLHeight(mh.temperature ?? 0, mh.dew ?? 0);
                const eli      = calcELI(mh.cape, mh.cin, mh.pblHeight);
                const wmaxshear = calcWMAXSHEAR(mh.cape, shear);
                const { kIndex, showalter, lapse, liftedIndex } = calcIndices(mh);
                const thetaE850 = calcThetaE(mh.temp850 ?? 0, mh.dew850 ?? 0, 850);
                const thetaE700 = calcThetaE(mh.temp700 ?? 0, mh.dew700 ?? 0, 700);
                const midLapse  = calcMidLevelLapseRate(mh.temp700 ?? 0, mh.temp500 ?? 0);
                const rh850     = mh.rh850 ?? calcRelHum(mh.temp850 ?? 0, mh.dew850 ?? 0);
                const rh700     = mh.rh700 ?? calcRelHum(mh.temp700 ?? 0, mh.dew700 ?? 0);
                const meanRH    = (rh850 + rh700 + (mh.rh500 ?? 50)) / 3;
                const moistureDepth = calcMoistureDepth(mh.dew850 ?? 0, mh.dew700 ?? 0, mh.temp850 ?? 0, mh.temp700 ?? 0);
                const relHum2m  = calcRelHum(mh.temperature ?? 0, mh.dew ?? 0);
                const e850_dew  = 6.112 * Math.exp((17.67 * (mh.dew850 ?? 0)) / ((mh.dew850 ?? 0) + 243.5));
                const mixR850   = 1000 * 0.622 * e850_dew / (850 - e850_dew);

                perModel[model] = {
                    // ── Wahrscheinlichkeiten ──────────────────────────────────────
                    gewitter:  calculateProbability(mh),
                    tornado:   calculateTornadoProbability(mh, shear, srh3km),
                    hagel:     calculateHailProbability(mh, wms, dcape),
                    wind:      calculateWindProbability(mh, wms, dcape),

                    // ── Thermodynamik ─────────────────────────────────────────────
                    cape:        Math.round(mh.cape),
                    cin:         Math.round(mh.cin ?? 0),
                    dcape:       Math.round(dcape),
                    eli:         Math.round(eli),
                    lcl:         Math.round(lcl),
                    freezingLevel: Math.round(mh.freezingLevel ?? 0),
                    pblHeight:   Math.round(mh.pblHeight ?? 0),

                    // ── Temperatur/Taupunkt ───────────────────────────────────────
                    temp2m:    Math.round(mh.temperature * 10) / 10,
                    dew2m:     Math.round(mh.dew * 10) / 10,
                    temp500:   Math.round(mh.temp500 * 10) / 10,
                    temp700:   Math.round(mh.temp700 * 10) / 10,
                    temp850:   Math.round(mh.temp850 * 10) / 10,
                    dew700:    Math.round(mh.dew700 * 10) / 10,
                    dew850:    Math.round(mh.dew850 * 10) / 10,

                    // ── Feuchte ───────────────────────────────────────────────────
                    relHum2m:      Math.round(relHum2m),
                    rh500:         Math.round(mh.rh500 ?? 0),
                    rh700:         Math.round(rh700),
                    rh850:         Math.round(rh850),
                    meanRH:        Math.round(meanRH),
                    moistureDepth: Math.round(moistureDepth),
                    mixR850:       Math.round(mixR850 * 10) / 10,
                    pwat:          Math.round(mh.pwat ?? 0),
                    thetaE850:     Math.round(thetaE850 * 10) / 10,
                    thetaE700:     Math.round(thetaE700 * 10) / 10,

                    // ── Instabilitätsindizes ──────────────────────────────────────
                    liftedIndex: Math.round(liftedIndex * 10) / 10,
                    kIndex:      Math.round(kIndex * 10) / 10,
                    showalter:   Math.round(showalter * 10) / 10,
                    midLapse:    Math.round(midLapse * 10) / 10,

                    // ── Scherung & Rotation ───────────────────────────────────────
                    shear:     Math.round(shear * 10) / 10,
                    srh1km:    Math.round(srh1km * 10) / 10,
                    srh3km:    Math.round(srh3km * 10) / 10,
                    ebwd:      Math.round(ebwd * 10) / 10,
                    wmaxshear: Math.round(wmaxshear),

                    // ── Komposit-Indizes ──────────────────────────────────────────
                    scp:  Math.round(scp * 100) / 100,
                    stp:  Math.round(stp * 100) / 100,
                    ehi:  Math.round(ehi * 100) / 100,

                    // ── Bodenwind ─────────────────────────────────────────────────
                    wind10m:   Math.round(mh.wind * 10) / 10,
                    gust10m:   Math.round(mh.gust * 10) / 10,

                    // ── Wolken & Niederschlag ─────────────────────────────────────
                    cloudLow:    Math.round(mh.cloudLow ?? 0),
                    cloudMid:    Math.round(mh.cloudMid ?? 0),
                    cloudHigh:   Math.round(mh.cloudHigh ?? 0),
                    precipProb:  Math.round(mh.precip ?? 0),
                    precipAcc:   Math.round(mh.precipAcc * 10) / 10,
                    radiation:   Math.round(mh.directRadiation ?? 0),
                     ship:        Math.round(calcSHIP(mh) * 100) / 100,
                };
            }
            return {
                timestamp:         h.time,
                ensemble_gewitter: h.probability,
                ensemble_tornado:  h.tornadoProbability,
                ensemble_hagel:    h.hailProbability,
                ensemble_wind:     h.windProbability,
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

    // Besserer Startwert: trockenadiabatisch bis LCL, dann feuchtadiabatisch
    // Faustregel: Parcel bei 500hPa ≈ T_LCL − 6K/km * (5500−z_LCL)/1000
    const z_LCL = 125 * dewDep;
    const dz_moist = (5500 - z_LCL) / 1000; // km über LCL bis 500 hPa
    let T_parcel_500 = T_LCL - 6.0 * dz_moist; // 6 K/km feuchtadiabatisch

    // Mehr Iterationen + kleinere Schrittweite für bessere Konvergenz
    for (let iter = 0; iter < 20; iter++) {
        const Tp_K   = T_parcel_500 + 273.15;
        const es     = 6.112 * Math.exp((17.67 * T_parcel_500) / (T_parcel_500 + 243.5));
        const ws     = 0.622 * es / (500 - es);
        const ws_gkg = ws * 1000;
        const theta_e_test = Tp_K
            * Math.pow(1000 / 500, 0.2854 * (1 - 0.00028 * ws_gkg))
            * Math.exp((3.376 / Tp_K - 0.00254) * ws_gkg * (1 + 0.00081 * ws_gkg));
        const delta = (theta_e - theta_e_test) * 0.15; // kleinere Schrittweite
        T_parcel_500 += delta;
        if (Math.abs(delta) < 0.001) break; // Konvergenz-Check
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

function calcEBWD(hour) {
    // EBWD = Effective Bulk Wind Difference (vereinfacht: 1000→850 hPa)
    // Quelle: Thompson et al. 2003, Rasmussen 2003
    // Feldnamen konsistent mit extractModelHour

    const levels = [
        { speed: (hour.wind_speed_1000hPa ?? 0) / 3.6, dir: hour.windDir1000 ?? 0 },
        { speed: (hour.wind_speed_975hPa  ?? 0) / 3.6, dir: hour.windDir975  ?? 0 },
        { speed: (hour.wind_speed_950hPa  ?? 0) / 3.6, dir: hour.windDir950  ?? 0 },
        { speed: (hour.wind_speed_925hPa  ?? 0) / 3.6, dir: hour.windDir925  ?? 0 },
        { speed: (hour.wind_speed_900hPa  ?? 0) / 3.6, dir: hour.windDir900  ?? 0 },
        { speed: (hour.wind_speed_850hPa  ?? 0) / 3.6, dir: hour.windDir850  ?? 0 },
    ];

    const uv = levels.map(l => windToUV(l.speed, l.dir));

    // Massengewichteter Mittelwind der Einströmschicht (1000–850 hPa)
    const meanU = uv.reduce((s, w) => s + w.u, 0) / uv.length;
    const meanV = uv.reduce((s, w) => s + w.v, 0) / uv.length;

    // EBWD = Differenz zwischen Oberrand (850 hPa) und Mittelwind
    const du = uv[uv.length - 1].u - meanU;
    const dv = uv[uv.length - 1].v - meanV;

    return Math.round(Math.hypot(du, dv) * 10) / 10; // m/s
}

function calcSRH(hour, layer = '0-3km') {
    const levels = layer === '0-1km'
        ? [
            // 0-1km: 1000/975/950/925/900 hPa (~0-1000m)
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_975hPa  ?? 0) / 3.6, wd: hour.windDir975  ?? 0 },
            { ws: (hour.wind_speed_950hPa  ?? 0) / 3.6, wd: hour.windDir950  ?? 0 },
            { ws: (hour.wind_speed_925hPa  ?? 0) / 3.6, wd: hour.windDir925  ?? 0 },
            { ws: (hour.wind_speed_900hPa  ?? 0) / 3.6, wd: hour.windDir900  ?? 0 },
            ]
        : [
            // 0-3km: bis 700 hPa
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_925hPa  ?? 0) / 3.6, wd: hour.windDir925  ?? 0 },
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

    // ── Showalter: korrekte Implementierung (Bolton 1980) ──────────────
    // Schritt 1: LCL von 850 hPa aus
    const dewDep850 = temp850 - dew850;
    const T_LCL850  = temp850 - 0.212 * dewDep850 - 0.001 * dewDep850 * dewDep850;
    const T_LCL850_K = T_LCL850 + 273.15;
    const T850_K     = temp850 + 273.15;

    // Schritt 2: Theta-E des 850-hPa-Parcels
    const e850   = 6.112 * Math.exp((17.67 * dew850) / (dew850 + 243.5));
    const w850   = 0.622 * e850 / (850 - e850);
    const w850_gkg = w850 * 1000;
    const theta_e850 = T850_K
        * Math.pow(1000 / 850, 0.2854 * (1 - 0.00028 * w850_gkg))
        * Math.exp((3.376 / T_LCL850_K - 0.00254) * w850_gkg * (1 + 0.00081 * w850_gkg));

    // Schritt 3: Parcel-Temperatur bei 500 hPa iterativ bestimmen
    // Startwert: feuchtadiabatisch von LCL bis 500 hPa (~2.5 km über 850 hPa)
    const z_LCL850 = 125 * dewDep850; // Höhe LCL über 850-hPa-Niveau (m)
    const dz_moist = (3000 - z_LCL850) / 1000; // km von LCL bis ~500 hPa
    let T_parcel_500_SI = T_LCL850 - 6.0 * dz_moist;

    for (let iter = 0; iter < 20; iter++) {
        const Tp_K   = T_parcel_500_SI + 273.15;
        const es     = 6.112 * Math.exp((17.67 * T_parcel_500_SI) / (T_parcel_500_SI + 243.5));
        const ws     = 0.622 * es / (500 - es);
        const ws_gkg = ws * 1000;
        const theta_e_test = Tp_K
            * Math.pow(1000 / 500, 0.2854 * (1 - 0.00028 * ws_gkg))
            * Math.exp((3.376 / Tp_K - 0.00254) * ws_gkg * (1 + 0.00081 * ws_gkg));
        const delta = (theta_e850 - theta_e_test) * 0.15;
        T_parcel_500_SI += delta;
        if (Math.abs(delta) < 0.001) break;
    }

    const showalter = Math.round((temp500 - T_parcel_500_SI) * 10) / 10;
    // ───────────────────────────────────────────────────────────────────

    return {
        kIndex:      temp850 - temp500 + dew850 - (temp700 - dew700),
        showalter,
        lapse:       (temp850 - temp500) / 3.5,
        liftedIndex: hour.liftedIndex ?? calcLiftedIndex(hour),
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
    const temp2m  = hour.temperature ?? 0;
    const temp850 = hour.temp850 ?? 0;

    const dewDep700 = temp700 - dew700;
    if (dewDep700 > 40) return 0;

    // Wetbulb bei 700 hPa (Normand-Methode)
    const wetBulb700 = temp700 - 0.43 * dewDep700;

    // Parcel sinkt moist-adiabatisch von 700 hPa (~3000m) zur Oberfläche
    // Erwärmt sich trocken-adiabatisch: DALR = 9.8 K/km × 3 km = +29.4 K
    const T_parcel_sfc = wetBulb700 + 9.8 * 3.0;

    // Vergleich mit Bodentemperatur (Ziel = Oberfläche, nicht 850 hPa!)
    const tempDiff = T_parcel_sfc - temp2m;
    if (tempDiff <= 0) return 0;

    // Feuchtefaktor (Gilmore & Wicker 1998)
    let moistFactor;
    if      (dewDep700 <= 2)  moistFactor = 0.2;
    else if (dewDep700 <= 5)  moistFactor = 0.5;
    else if (dewDep700 <= 10) moistFactor = 0.9;
    else if (dewDep700 <= 15) moistFactor = 1.0;
    else if (dewDep700 <= 20) moistFactor = 0.8;
    else if (dewDep700 <= 25) moistFactor = 0.6;
    else if (dewDep700 <= 30) moistFactor = 0.4;
    else                      moistFactor = 0.2;

    // DCAPE = g × (ΔT / T_mean) × Δz  (700 hPa bis Oberfläche = 3000m)
    const T_mean_K = ((wetBulb700 + temp2m) / 2) + 273.15;
    return Math.round(Math.max(0, (tempDiff / T_mean_K) * 9.81 * 3000 * moistFactor));
}

function calcWMAXSHEAR(cape, shear) {
    // shear kommt in m/s, für WMAXSHEAR-Schwellen in km/h umrechnen
    // Quelle: Taszarek 2020 – Schwellen kalibriert auf m/s × km/h
    if (cape <= 0 || shear <= 0) return 0;
    const shear_kmh = shear * 3.6;
    return Math.round(Math.sqrt(2 * cape) * shear_kmh);
}

function calcLCLHeight(temp2m, dew2m) {
    // Standard-Formel, auch in europäischen Studien verwendet
    // Quelle: Púčik et al. 2015, median LCL Europa ~905m
    const spread = temp2m - dew2m;
    if (spread < 0) return 0;        // Nebel / gesättigte Luft
    if (spread === 0) return 0;      // 100% relative Feuchte
    return Math.max(0, 125 * spread);
}

function calcMidLevelLapseRate(temp700, temp500) {
    return (temp700 - temp500) / 2.5; // K/km (700→500 hPa ≈ 2 km)
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
function calcSTP(cape, srh1km, shear, liftedIndex, cin, temp2m = null, dew2m = null, hour = null) {
    // Europa-kalibrierte STP-Formel — konsistent mit calculateTornadoProbability
    // Quelle: Púčik et al. 2015, Taszarek 2020 (normCAPE=1500 für Europa)
    if (cape < 80 || srh1km < 40 || shear < 12.5) return 0;

    // LCL-Term
    let lclTerm;
    if (temp2m !== null && dew2m !== null) {
        const lclHeight = calcLCLHeight(temp2m, dew2m);
        if      (lclHeight < 1000)  lclTerm = 1.0;
        else if (lclHeight >= 2000) lclTerm = 0.0;
        else                        lclTerm = (2000 - lclHeight) / 1000;
    } else {
        lclTerm = liftedIndex <= -4 ? 1.0 : liftedIndex <= -2 ? 0.8 : liftedIndex <= 0 ? 0.5 : 0.2;
    }

    // CAPE-Term: normCAPE=1500 (Europa, Taszarek 2020)
    const capeTerm = Math.min(cape / 1500, 3.0);

    // SRH-Term: 0-1km
    const srhTerm = Math.min(srh1km / 150, 3.0);

    // Scherung: EBWD wenn hour verfügbar, sonst bulk shear als Fallback
    const ebwd = hour ? calcEBWD(hour) : shear;
    const shearTerm = Math.min(ebwd / 20, 2.0);

    // CIN-Term
    let cinTerm;
    if      (cin >= -50)  cinTerm = 1.0;
    else if (cin <= -200) cinTerm = 0.0;
    else                  cinTerm = (200 + cin) / 150;

    return Math.max(0, capeTerm * srhTerm * shearTerm * lclTerm * cinTerm);
}

// Theta-E nach Bolton 1980 (ESTOFEX-Standard)
// Schwellen aus Guide: < 320K stabil, 320-335 schwach, 335-345 gut, > 345 sehr instabil
function calcThetaE(tempC, dewC, pressHPa) {
    // Bolton 1980 – ESTOFEX-Standard, feuchtekorrigierter Exponent
    const T_K = tempC + 273.15;
    const e   = 6.112 * Math.exp((17.67 * dewC) / (dewC + 243.5));
    const w   = 0.622 * e / (pressHPa - e);   // Mischungsverhältnis kg/kg
    const w_gkg = w * 1000;
    const T_LCL_K = (dewC + 273.15) - 0.212 * (tempC - dewC); // LCL-Näherung

    // Bolton 1980 Gleichung 43 – korrekte feuchtekorrigierte Form
    return T_K
        * Math.pow(1000 / pressHPa, 0.2854 * (1 - 0.00028 * w_gkg))
        * Math.exp((3.376 / T_LCL_K - 0.00254) * w_gkg * (1 + 0.00081 * w_gkg));
}

// Kategorisierung der Gewitterwahrscheinlichkeit in 4 Stufen (ESTOFEX-Standard)

function categorizeRisk(prob) {
    const p = Math.max(0, Math.min(100, Math.round(prob ?? 0)));
    if (p >= 70) return { level: 3, label: 'high' };
    if (p >= 45) return { level: 2, label: 'moderate' };
    if (p >= 15) return { level: 1, label: 'tstorm' };
    return { level: 0, label: 'none' };
}

function calcSHIP(hour) {
    const cape    = Math.max(0, hour.cape ?? 0);
    const temp500 = hour.temp500 ?? 0;
    const shear   = calcShear(hour); // bereits 0-5.5km in m/s

    // Mischungsverhältnis MU-Parcel: hier 850 hPa als Proxy
    // (MUCAPE-Parcel kommt in Europa oft aus 850-950 hPa)
    const e850    = 6.112 * Math.exp((17.67 * (hour.dew850 ?? 0)) / ((hour.dew850 ?? 0) + 243.5));
    const mixR850 = 1000 * 0.622 * e850 / (850 - e850); // g/kg

    // 700-500 hPa Lapserate (K/km) — 700→500 hPa ≈ 2.5 km
    const lapse = calcMidLevelLapseRate(hour.temp700 ?? 0, hour.temp500 ?? 0);

    // Harte Ausschlüsse (physikalisch sinnlos darunter)
    if (cape < 100)      return 0;
    if (temp500 >= -5)   return 0; // zu warm → Hagel schmilzt
    if (mixR850 < 5)     return 0; // zu trocken
    if (shear < 7)       return 0;
    if (lapse < 5.5)     return 0; // zu stabile Mittelschicht

    const ship = (cape * mixR850 * lapse * Math.abs(temp500) * shear) / 28000000;
    //                                                          ↑
    //                         EU-Normierung: ~37% niedriger als NOAA
    //                         → SHIP=1.0 entspricht ca. EU-Signifikanzgrenze

    return Math.max(0, Math.round(ship * 100) / 100);
}

// ═══════════════════════════════════════════════════════════════════════════
// WAHRSCHEINLICHKEITS-FUNKTIONEN – HAGEL ≥2cm nur bei Gewitter
// ═══════════════════════════════════════════════════════════════════════════
function calculateHailProbability(hour) {
    const thunderProb = calculateProbability(hour);
    if (thunderProb < 5) return 0;

    const ship = calcSHIP(hour);

    // SHIP → bedingte Wahrscheinlichkeit für Hagel ≥ 2cm
    // Schwellen nach Johnson & Sugier 2014 / ESSL-Kalibrierung Europa
    let hailProb;
    if      (ship >= 4.0) hailProb = 95;
    else if (ship >= 3.0) hailProb = 80;
    else if (ship >= 2.0) hailProb = 60;
    else if (ship >= 1.5) hailProb = 45;
    else if (ship >= 1.0) hailProb = 30;
    else if (ship >= 0.5) hailProb = 15;
    else if (ship >= 0.2) hailProb = 6;
    else                  hailProb = 0;

    // Bedingt auf Gewitterwahrscheinlichkeit
    return Math.min(100, Math.round(hailProb * (thunderProb / 100)));
}

function calculateWindProbability(hour, wmaxshear, dcape) {

    const thunderProb = calculateProbability(hour); // 0–100%
    if (thunderProb < 5) return 0; // Schwelle: 5% – sonst kein Severe Wind

    const cape     = Math.max(0, hour.cape ?? 0);
    const shear    = calcShear(hour);
    const temp700  = hour.temp700 ?? 0;
    const dew700   = hour.dew700  ?? 0;
    const temp500  = hour.temp500 ?? 0;
    const pwat = hour.pwat ?? 0;
    const lapseRate = calcMidLevelLapseRate(temp700, temp500);

    // ESTOFEX Z_wind: DCAPE + CAPE + Shear + Midlevel_dry_air + PWAT
    if (dcape < 250 && wmaxshear < 450) return 0;
    if (shear < 9 && cape < 450)        return 0;

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

    const w850_low  = windToUV((hour.wind_speed_850hPa  ?? 0) / 3.6, hour.windDir850  ?? 0);
    const w1000_low = windToUV((hour.wind_speed_1000hPa ?? 0) / 3.6, hour.windDir1000 ?? 0);
    const shear_low = Math.hypot(w850_low.u - w1000_low.u, w850_low.v - w1000_low.v);
    if      (shear_low >= 15) score += 10;
    else if (shear_low >= 12) score += 7;
    else if (shear_low >= 9)  score += 4;
    else if (shear_low >= 6)  score += 2;

    if      (lapseRate >= 8.0 && dcape >= 500) score += 10;
    else if (lapseRate >= 7.0 && dcape >= 400) score += 6;
    else if (lapseRate >= 6.5 && dcape >= 300) score += 3;
    else if (lapseRate < 5.5)                  score -= 3;  

    if      (cape >= 1500) score += 11;
    else if (cape >= 1200) score += 9;
    else if (cape >= 800)  score += 7;
    else if (cape >= 450)  score += 4;
    else if (cape >= 250)  score += 2;

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

    // PWAT (ESTOFEX Z_wind b5)
    if      (pwat < 15 && dcape >= 600) score += 5;
    else if (pwat < 20 && dcape >= 500) score += 3;
    else if (pwat > 35 && dcape < 800)  score -= 4;

    let factor = 1.0;
    if      (dcape >= 1000 && wmaxshear >= 1100) factor = 1.2;
    else if (dcape >= 800  && wmaxshear >= 900)  factor = 1.15;
    else if (dcape >= 550  && wmaxshear >= 650)  factor = 1.1;
    else if (dcape < 350   || wmaxshear < 550)   factor = 0.75;
    if      (shear >= 17 && cape >= 550)         factor *= 1.1;
    else if (shear < 11  && cape < 350)          factor *= 0.8;

    score = Math.round(score * factor);
    if      (dcape < 250 || wmaxshear < 400) score = Math.min(score, 10);
    else if (dcape < 350 || wmaxshear < 550) score = Math.min(score, 25);
    if (dcape >= 1200 && wmaxshear >= 1300 && shear >= 20) score = Math.min(100, score + 12);
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

    const shear    = calcShear(hour);
    const li       = hour.liftedIndex ?? calcLiftedIndex(hour);
    const rh850    = hour.rh850 ?? calcRelHum(hour.temp850 ?? 0, hour.dew850 ?? 0);
    const rh700    = hour.rh700 ?? calcRelHum(hour.temp700 ?? 0, hour.dew700 ?? 0);
    const meanRH   = (rh850 + rh700 + (hour.rh500 ?? 50)) / 3;
    if (meanRH < 35) return 0;

    // Spezifische Feuchte 925 hPa (Bodennähe als Proxy, Battaglioli 2023)
    const e850_logit = 6.112 * Math.exp((17.67 * (hour.dew850 ?? dew)) / ((hour.dew850 ?? dew) + 243.5));
    const mixR850_logit = 1000 * 0.622 * e850_logit / (850 - e850_logit);

    // ════════════════════════════════════════════════════════════════════
    // SCHRITT 1: AR-CHaMo Logit-Gate (Rädler 2018 / Battaglioli 2023)
    // P(storm) via logistische Regression: f(LI, meanRH, CAPE, q925)
    // Verhindert Trigger durch precipProb/precip allein bei CAPE=0
    // ════════════════════════════════════════════════════════════════════

    // Harte Ausschlüsse
    if (temp2m < 3 && cape < 300)                          return 0;
    if (temp2m < 8 && cape < 180 && shear < 15)           return 0;

    // Logit: LI und meanRH sind Kernprädiktoren (Rädler 2018)
    // CAPE log-transformiert (Sättigung ab ~200 J/kg, Westermayer 2017)
    let logit = -4.2;
    logit += -li * 0.60;                            // LI: Hauptprädiktor
    logit += (meanRH - 55) / 25 * 1.80;            // meanRH: gleichrangig
    logit += (cape > 0 ? Math.log1p(cape / 150) * 1.2 : 0); // CAPE: log-sättigend
    logit += (mixR850_logit - 5) / 5 * 1.30;            // q925: Niedrigpegel-Feuchte
    if (magCin > 50)  logit -= (magCin - 50) / 100 * 1.2;
    if (magCin > 150) logit -= 1.0;
    if (temp2m < 8)   logit -= 1.0;
    else if (temp2m < 12) logit -= 0.4;

    const wmaxshear_logit = calcWMAXSHEAR(cape, shear);
    logit += Math.log1p(wmaxshear_logit / 300) * 0.9;

    // HSLC-Pfad: hoher Shear kompensiert fehlende CAPE (Rädler 2018)
    const isHSLC = cape < 300 && shear >= 15;
    if (isHSLC && meanRH >= 55) {
        logit += (shear - 18) / 12 * 1.0;
    }

    // Basiswahrscheinlichkeit aus Logit
    const pBase = 1 / (1 + Math.exp(-logit)); // 0.0–1.0

    // Wenn Atmosphäre grundsätzlich zu stabil → frühzeitig begrenzen
    // LI > 3 UND meanRH < 50%: Score kann maximal ~10% erreichen
    const hardCap = (li > 3 && meanRH < 50) ? 10
                  : (li > 2 && meanRH < 55) ? 20
                  : (li > 1 && cape === 0)  ? 25
                  : 100;

    // ════════════════════════════════════════════════════════════════════
    // SCHRITT 2: Score-System für severe-weather Differenzierung
    // (bleibt erhalten – ist gut für SCP/STP/EHI/wmaxshear-Regime)
    // ════════════════════════════════════════════════════════════════════

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
    const stp           = calcSTP(cape, srh1km, shear, liftedIndex, cin, temp2m, dew, hour);
    const wmaxshear     = calcWMAXSHEAR(cape, shear);
    const dcape         = calcDCAPE(hour);
    const thetaE850     = calcThetaE(hour.temp850 ?? 0, hour.dew850 ?? 0, 850);

    // HSLC direkt zurückgeben (Gate bereits oben passiert)
    if (isHSLC) {
        let hslcScore = 0;
        if      (shear >= 25) hslcScore += 30;
        else if (shear >= 20) hslcScore += 20;
        else                  hslcScore += 10;
        if      (meanRH >= 65) hslcScore += 15;
        else if (meanRH <  50) hslcScore -= 15;
        if (temp2m < 8) hslcScore = Math.round(hslcScore * 0.6);

        // ── NEU: LI-Dämpfung auch im HSLC-Pfad ──────────────────────────
        // LI=5.5 bedeutet: trotz hohem Shear ist die Atmosphäre sehr stabil
        // HSLC funktioniert typischerweise bei LI 0–3, nicht bei LI > 4
        if      (li > 5) hslcScore = Math.round(hslcScore * 0.3);
        else if (li > 4) hslcScore = Math.round(hslcScore * 0.5);
        else if (li > 3) hslcScore = Math.round(hslcScore * 0.7);
        else if (li > 2) hslcScore = Math.round(hslcScore * 0.85);

        return Math.min(40, Math.max(0, hslcScore));
    }

    let score = 0;

    // CAPE
    if      (cape >= 2000) score += 16;
    else if (cape >= 1500) score += 14;
    else if (cape >= 1200) score += 12;
    else if (cape >= 800)  score += 10;
    else if (cape >= 500)  score += 8;
    else if (cape >= 300)  score += 6;
    else if (cape >= 150)  score += 3;

    // EL-Temperatur Proxy
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

    // Europa-kalibriert: Taszarek 2020, Púčik 2015
    // SCP ≥ 1.0 bereits signifikant in Europa (US-Schwellen zu hoch)
    if      (scp >= 2.0) score += 24;
    else if (scp >= 1.5) score += 20;
    else if (scp >= 1.0) score += 16;
    else if (scp >= 0.5) score += 10;

    if      (stp >= 2.0) score += 18;
    else if (stp >= 1.5) score += 15;
    else if (stp >= 1.0) score += 12;
    else if (stp >= 0.5) score += 8;
    else if (stp >= 0.3) score += 4;

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

    if      (meanRH >= 75) score += 8;
    else if (meanRH >= 65) score += 5;
    else if (meanRH >= 55) score += 2;
    else if (meanRH < 50)  score -= 12;
    else if (meanRH < 40)  score -= 20;

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

    // precipAcc nur noch mit CAPE-Bedingung (kein Trigger bei CAPE=0)
    if      (precipAcc >= 3.0 && cape >= 600) score += 8;
    else if (precipAcc >= 2.0 && cape >= 400) score += 6;
    else if (precipAcc >= 1.0 && cape >= 300) score += 4;
    else if (precipAcc >= 0.5 && cape >= 200) score += 2;

    // precipProb nur noch mit CAPE-Bedingung
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

    if      (isStrongDay && temp2m >= 14 && cape >= 300) score += 7;
    else if (isDaytime   && temp2m >= 12 && cape >= 200) score += 4;
    else if (isNight) {
        const llj = srh >= 120 && shear >= 12 && hour.wind >= 8;
        if      (llj && cape >= 500)               score += 5;
        else if (!llj && shear < 10 && cape < 400) score -= 4;
        else if (cape >= 600 && srh >= 100)        score += 2;
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

    // ════════════════════════════════════════════════════════════════════
    // SCHRITT 3: Score mit AR-CHaMo Gate kombinieren
    // pBase skaliert den Score — stabile Atmosphäre begrenzt das Maximum
    // ════════════════════════════════════════════════════════════════════

    // pBase wirkt als Multiplikator: bei pBase=0.05 (stabil) → Score stark gedämpft
    // bei pBase=0.5 (labil) → Score läuft normal durch
    const gateMultiplier = Math.min(1.0, pBase * 4.0); // 0.0–1.0
    score = Math.round(score * gateMultiplier);

    return Math.min(hardCap, Math.min(100, Math.max(0, score)));
}

// ── Optional: STP → grobe Tornado-% Wahrscheinlichkeit (Europa) ──
function stpToPercentEurope(stp) {
    if (stp < 0.1) return 0;         // STP < 0.1 → fast keine Gefahr
    if (stp < 0.5) return 5;         // kleine Gefahr, 5%
    if (stp < 1.0) return 10;        // moderate Gefahr, 10%
    if (stp < 1.5) return 20;
    if (stp < 2.0) return 30;
    if (stp < 2.5) return 40;
    if (stp < 3.0) return 50;
    if (stp < 4.0) return 65;
    if (stp < 5.0) return 80;
    return 95;                        // sehr hohe Gefahr
}
// ── Tornado-Wahrscheinlichkeit via STP ──────────────────────────────────────
// Funktion behält den Namen calculateTornadoProbability
function calculateTornadoProbability(hour,shear, srh) {

    const thunderProb = calculateProbability(hour); // 0–100%
    if (thunderProb < 40) return 0; // Schwelle: 40% – sonst kein Tornado

    const cape  = Math.max(0, hour.cape ?? 0);        // MLCAPE in J/kg
    const srh1  = calcSRH(hour, '0-1km');             // SRH 0-1 km in m²/s²                    
    const temp  = hour.temperature ?? 20;             // Boden-Temp °C
    const dew   = hour.dew ?? 10;                     // Taupunkt °C
    const cin   = hour.cin ?? 0;                      // CIN in J/kg

    // LCL berechnen
    const lcl = calcLCLHeight(temp, dew);            // LCL in m
    const ebwd = calcEBWD(hour);                     // m/s

    // CIN-Faktor
    const cinFactor = Math.max(0, (200 + cin)/150);

    // LCL-Faktor
    const lclFactor = Math.max(0, (2000 - lcl)/1000);

    // Europäische STP-Formel
    let stp = (cape / 1500) * lclFactor * (srh1 / 150) * (ebwd / 20) * cinFactor;
    stp = Math.max(0, stp);

    return stpToPercentEurope(stp); // STP-Index
}
