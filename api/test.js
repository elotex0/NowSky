export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'lat und lon Parameter sind erforderlich' });

    const latitude  = parseFloat(lat);
    const longitude = parseFloat(lon);
    if (isNaN(latitude) || isNaN(longitude)) return res.status(400).json({ error: 'Ungültige Koordinaten' });

    try {
        const url =
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
            `&hourly=wind_gusts_10m,wind_speed_10m,temperature_2m,dew_point_2m,` +
            `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
            `wind_direction_1000hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
            `wind_direction_975hPa,wind_direction_950hPa,wind_direction_925hPa,wind_direction_900hPa,` +
            `wind_speed_1000hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
            `wind_speed_975hPa,wind_speed_950hPa,wind_speed_925hPa,wind_speed_900hPa,` +
            `temperature_500hPa,temperature_850hPa,temperature_700hPa,` +
            `relative_humidity_500hPa,relative_humidity_850hPa,relative_humidity_700hPa,cape,` +
            `dew_point_850hPa,dew_point_700hPa,direct_radiation,total_column_integrated_water_vapour,` +
            `freezing_level_height,precipitation,boundary_layer_height,convective_inhibition,lifted_index` +
            `&forecast_days=16&models=icon_seamless,ecmwf_ifs025,gfs_global&timezone=auto`;

        const response = await fetch(url);
        const data     = await response.json();

        if (data.error)                        return res.status(500).json({ error: 'API-Fehler: ' + (data.reason || data.error.message || 'Unbekannt') });
        if (!data?.hourly?.time?.length)       return res.status(500).json({ error: 'Keine Daten verfügbar' });

        const timezone = data.timezone || 'UTC';
        const region   = getRegion(latitude, longitude);
        if (region !== 'europe') {
            return res.status(400).json({ error: 'Vorhersage nur für Europa verfügbar', region, onlyEurope: true });
        }

        // ═══════════════════════════════════════════════════════════════════
        // METHODIK (überarbeitet – physikalisch hierarchisch):
        //
        // Zwei parallele Konvektionspfade pro Modell:
        //   A) Thermische Konvektion  – CAPE-getrieben (Taszarek 2020)
        //   B) Frontale/dynamische   – mechanische Hebung, niedrige CAPE,
        //      hohe Feuchte, wenig CIN, precipProb (Rädler 2018, Battaglioli 2023)
        //
        // Innerhalb jedes Pfads: logistische Regression als Hauptterm,
        // ergänzt durch physikalische Composite-Indizes (SCP, STP, SHIP).
        //
        // Ensemble: gewichteter Mittelwert der Modell-Wahrscheinlichkeiten
        // nach Leadtime (wie bisher, Haiden 2018).
        //
        // Quellen:
        //   Rädler et al. 2018  – AR-CHaMo, Environ. Res. Lett.
        //   Battaglioli et al. 2023 – European thunderstorm logistic regression
        //   Taszarek et al. 2020 – Severe convection Europe, BAMS
        //   Púčik et al. 2015   – Proximity soundings Europe, MWR
        //   Thompson et al. 2003 – Tornado composite parameters
        //   Johnson & Sugier 2014 – OPERA hail, ESSL TN
        // ═══════════════════════════════════════════════════════════════════

        const MODELS = ['icon_seamless', 'ecmwf_ifs025', 'gfs_global'];

        // Aktuelle Ortszeit bestimmen
        const now           = new Date();
        const currentTimeStr = now.toLocaleString('en-US', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone,
        });
        const [datePart_now, timePart_now] = currentTimeStr.split(', ');
        const [month_now, day_now, year_now] = datePart_now.split('/');
        const [currentHour] = timePart_now.split(':').map(Number);
        const currentDateStr = `${year_now}-${month_now.padStart(2,'0')}-${day_now.padStart(2,'0')}`;

        // ── Stundendaten eines Modells extrahieren ───────────────────────
        function extractModelHour(hourly, i, model) {
            function get(field) {
                const arr = hourly[`${field}_${model}`];
                if (Array.isArray(arr) && arr[i] !== undefined && arr[i] !== null) return arr[i];
                return null;
            }

            const t2m  = get('temperature_2m');
            const d2m  = get('dew_point_2m');
            const t850 = get('temperature_850hPa');
            const t500 = get('temperature_500hPa');
            if (t2m === null || t850 === null || t500 === null) return null;

            const t700 = get('temperature_700hPa');
            const d850 = get('dew_point_850hPa');
            const d700 = get('dew_point_700hPa');

            const h = {
                time:               hourly.time[i],
                temperature:        t2m,
                dew:                d2m ?? t2m - 10,
                cloudLow:           get('cloud_cover_low')  ?? 0,
                cloudMid:           get('cloud_cover_mid')  ?? 0,
                cloudHigh:          get('cloud_cover_high') ?? 0,
                precip:             get('precipitation_probability') ?? 0,
                wind:               get('wind_speed_10m')   ?? 0,
                gust:               get('wind_gusts_10m')   ?? 0,
                windDir1000:        get('wind_direction_1000hPa') ?? 0,
                windDir975:         get('wind_direction_975hPa')  ?? 0,
                windDir950:         get('wind_direction_950hPa')  ?? 0,
                windDir925:         get('wind_direction_925hPa')  ?? 0,
                windDir900:         get('wind_direction_900hPa')  ?? 0,
                windDir850:         get('wind_direction_850hPa')  ?? 0,
                windDir700:         get('wind_direction_700hPa')  ?? 0,
                windDir500:         get('wind_direction_500hPa')  ?? 0,
                windDir300:         get('wind_direction_300hPa')  ?? 0,
                wind_speed_1000hPa: get('wind_speed_1000hPa') ?? 0,
                wind_speed_975hPa:  get('wind_speed_975hPa')  ?? 0,
                wind_speed_950hPa:  get('wind_speed_950hPa')  ?? 0,
                wind_speed_925hPa:  get('wind_speed_925hPa')  ?? 0,
                wind_speed_900hPa:  get('wind_speed_900hPa')  ?? 0,
                wind_speed_850hPa:  get('wind_speed_850hPa')  ?? 0,
                wind_speed_700hPa:  get('wind_speed_700hPa')  ?? 0,
                wind_speed_500hPa:  get('wind_speed_500hPa')  ?? 0,
                wind_speed_300hPa:  get('wind_speed_300hPa')  ?? 0,
                pwat:               get('total_column_integrated_water_vapour') ?? 25,
                temp500:            t500,
                temp850:            t850,
                temp700:            t700 ?? (t850 + t500) / 2,
                dew850:             d850 ?? (d2m ?? t2m - 10),
                dew700:             d700 ?? (d2m ?? t2m - 10),
                rh500:              get('relative_humidity_500hPa') ?? 50,
                rh700:              get('relative_humidity_700hPa') ?? null,
                rh850:              get('relative_humidity_850hPa') ?? null,
                cape:               Math.max(0, get('cape') ?? 0),
                directRadiation:    get('direct_radiation') ?? 0,
                precipAcc:          get('precipitation')    ?? 0,
                freezingLevel:      get('freezing_level_height') ?? 3000,
                cin:                get('convective_inhibition') ?? null,
                liftedIndex:        get('lifted_index')     ?? null,
                pblHeight:          get('boundary_layer_height') ?? null,
            };

            // Fallback-Berechnungen nur wenn API keinen Wert liefert
            if (h.cin        === null) h.cin        = calcCIN(h);
            if (h.liftedIndex === null) h.liftedIndex = calcLiftedIndex(h);
            if (h.pblHeight   === null) h.pblHeight   = calcPBLHeight(h);

            return h;
        }

        // ── Modellgewichtung nach Leadtime ──────────────────────────────
        // Haiden et al. 2018 (ECMWF TM), DWD/ECMWF Verifikation
        function getModelWeight(model, leadtimeHours) {
            const lt = Math.max(0, leadtimeHours ?? 0);
            if      (lt <=  12) { return model === 'icon_seamless' ? 0.45 : model === 'ecmwf_ifs025' ? 0.35 : 0.20; }
            else if (lt <=  36) { return model === 'icon_seamless' ? 0.40 : model === 'ecmwf_ifs025' ? 0.40 : 0.20; }
            else if (lt <=  72) { return model === 'icon_seamless' ? 0.30 : model === 'ecmwf_ifs025' ? 0.50 : 0.20; }
            else if (lt <= 120) { return model === 'icon_seamless' ? 0.20 : model === 'ecmwf_ifs025' ? 0.60 : 0.20; }
            else                { return model === 'icon_seamless' ? 0.20 : model === 'ecmwf_ifs025' ? 0.50 : 0.30; }
        }

        function ensembleProb(probsByModel, leadtimeHours) {
            let weightedSum = 0, totalWeight = 0;
            for (const [model, prob] of Object.entries(probsByModel)) {
                if (prob === null) continue;
                const w = getModelWeight(model, leadtimeHours);
                weightedSum += prob * w;
                totalWeight += w;
            }
            return totalWeight === 0 ? 0 : Math.round(weightedSum / totalWeight);
        }

        function ensembleMean(values) {
            const valid = values.filter(v => v !== null && !isNaN(v));
            return valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : 0;
        }

        // ── Alle Stunden verarbeiten ─────────────────────────────────────
        const hours = data.hourly.time.map((t, i) => {
            const forecastTime  = new Date(t);
            const leadtimeHours = Math.round((forecastTime - now) / 3600000);

            const modelHours = {};
            for (const model of MODELS) modelHours[model] = extractModelHour(data.hourly, i, model);

            const gew_m = {}, tor_m = {}, hag_m = {}, win_m = {};

            for (const model of MODELS) {
                const mh = modelHours[model];
                if (!mh) { gew_m[model] = tor_m[model] = hag_m[model] = win_m[model] = null; continue; }

                const derived = getDerived(mh);
                gew_m[model] = calcThunderProb(mh, derived);
                tor_m[model] = calcTornadoProb(mh, derived, gew_m[model]);
                hag_m[model] = calcHailProb(mh, derived, gew_m[model]);
                win_m[model] = calcWindProb(mh, derived, gew_m[model]);
            }

            const probability        = ensembleProb(gew_m, leadtimeHours);
            const tornadoProbability = Math.min(ensembleProb(tor_m, leadtimeHours), probability);
            const hailProbability    = ensembleProb(hag_m, leadtimeHours);
            const windProbability    = ensembleProb(win_m, leadtimeHours);

            const vmh = Object.values(modelHours).filter(Boolean);
            return {
                time: t,
                probability,
                tornadoProbability,
                hailProbability,
                windProbability,
                temperature: Math.round(ensembleMean(vmh.map(m => m.temperature)) * 10) / 10,
                cape:        Math.round(ensembleMean(vmh.map(m => m.cape))),
                shear:       Math.round(ensembleMean(vmh.map(m => getDerived(m).shear)) * 10) / 10,
                srh:         Math.round(ensembleMean(vmh.map(m => getDerived(m).srh3km)) * 10) / 10,
                dcape:       Math.round(ensembleMean(vmh.map(m => getDerived(m).dcape))),
                wmaxshear:   Math.round(ensembleMean(vmh.map(m => getDerived(m).wmaxshear))),
            };
        });

        // ── Zeitfilter: nur ab jetzt ─────────────────────────────────────
        const nextHours = hours
            .filter(h => {
                const [dp, tp] = h.time.split('T');
                const [hr]     = tp.split(':').map(Number);
                return dp > currentDateStr || (dp === currentDateStr && hr >= currentHour);
            })
            .slice(0, 72);

        // ── Tages-Maxima (nur zukünftige Stunden) ───────────────────────
        const daysMap = new Map();
        hours.forEach(h => {
            const [dp, tp] = h.time.split('T');
            const [hr]     = tp.split(':').map(Number);
            if (dp < currentDateStr) return;
            if (dp === currentDateStr && hr < currentHour) return;

            if (!daysMap.has(dp)) {
                daysMap.set(dp, { date: dp,
                    maxProbability: h.probability, maxTornadoProbability: h.tornadoProbability,
                    maxHailProbability: h.hailProbability, maxWindProbability: h.windProbability });
            } else {
                const d = daysMap.get(dp);
                d.maxProbability        = Math.max(d.maxProbability,        h.probability);
                d.maxTornadoProbability = Math.max(d.maxTornadoProbability, h.tornadoProbability);
                d.maxHailProbability    = Math.max(d.maxHailProbability,    h.hailProbability);
                d.maxWindProbability    = Math.max(d.maxWindProbability,    h.windProbability);
            }
        });

        // ── Output-Formate ───────────────────────────────────────────────
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

        // ── Debug: erste 20 Stunden mit vollständigen Modelldetails ─────
        const debugStunden = nextHours.slice(0, 20).map(h => {
            const i = data.hourly.time.indexOf(h.time);
            const perModel = {};
            for (const model of MODELS) {
                const mh = extractModelHour(data.hourly, i, model);
                if (!mh) { perModel[model] = null; continue; }
                const d = getDerived(mh);
                const gew = calcThunderProb(mh, d);
                perModel[model] = {
                    // Wahrscheinlichkeiten
                    gewitter: gew,
                    tornado:  calcTornadoProb(mh, d, gew),
                    hagel:    calcHailProb(mh, d, gew),
                    wind:     calcWindProb(mh, d, gew),
                    // Debug-Internals
                    _pfad:    debugThunderPath(mh, d),
                    // Thermodynamik
                    cape: Math.round(mh.cape), cin: Math.round(mh.cin ?? 0),
                    dcape: Math.round(d.dcape), eli: Math.round(d.eli),
                    lcl: Math.round(d.lcl), freezingLevel: Math.round(mh.freezingLevel ?? 0),
                    pblHeight: Math.round(mh.pblHeight ?? 0),
                    // Temperatur/Taupunkt
                    temp2m: Math.round(mh.temperature * 10) / 10,
                    dew2m:  Math.round(mh.dew * 10) / 10,
                    temp500: Math.round(mh.temp500 * 10) / 10,
                    temp700: Math.round(mh.temp700 * 10) / 10,
                    temp850: Math.round(mh.temp850 * 10) / 10,
                    dew700: Math.round(mh.dew700 * 10) / 10,
                    dew850: Math.round(mh.dew850 * 10) / 10,
                    // Feuchte
                    relHum2m: Math.round(calcRelHum(mh.temperature, mh.dew)),
                    rh500: Math.round(mh.rh500 ?? 0),
                    rh700: Math.round(mh.rh700 ?? calcRelHum(mh.temp700, mh.dew700)),
                    rh850: Math.round(mh.rh850 ?? calcRelHum(mh.temp850, mh.dew850)),
                    meanRH: Math.round(d.meanRH),
                    moistureDepth: Math.round(d.moistureDepth),
                    mixR850: Math.round(d.mixR850 * 10) / 10,
                    pwat: Math.round(mh.pwat ?? 0),
                    thetaE850: Math.round(d.thetaE850 * 10) / 10,
                    thetaE700: Math.round(d.thetaE700 * 10) / 10,
                    // Instabilität
                    liftedIndex: Math.round(mh.liftedIndex * 10) / 10,
                    kIndex:      Math.round(d.kIndex * 10) / 10,
                    showalter:   Math.round(d.showalter * 10) / 10,
                    midLapse:    Math.round(d.midLapse * 10) / 10,
                    // Scherung
                    shear:     Math.round(d.shear * 10) / 10,
                    srh1km:    Math.round(d.srh1km * 10) / 10,
                    srh3km:    Math.round(d.srh3km * 10) / 10,
                    ebwd:      Math.round(d.ebwd * 10) / 10,
                    wmaxshear: Math.round(d.wmaxshear),
                    // Komposit
                    scp:  Math.round(d.scp  * 100) / 100,
                    stp:  Math.round(d.stp  * 100) / 100,
                    ship: Math.round(d.ship * 100) / 100,
                    ehi:  Math.round(d.ehi  * 100) / 100,
                    // Wind/Wolken
                    wind10m:  Math.round(mh.wind  * 10) / 10,
                    gust10m:  Math.round(mh.gust  * 10) / 10,
                    cloudLow:   Math.round(mh.cloudLow  ?? 0),
                    cloudMid:   Math.round(mh.cloudMid  ?? 0),
                    cloudHigh:  Math.round(mh.cloudHigh ?? 0),
                    precipProb: Math.round(mh.precip    ?? 0),
                    precipAcc:  Math.round(mh.precipAcc * 10) / 10,
                    radiation:  Math.round(mh.directRadiation ?? 0),
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
            timezone, region, stunden, tage,
            debug: {
                hinweis: 'Zwei-Pfad-Methodik: A) Thermische Konvektion (CAPE-Logit, Taszarek 2020) + B) Frontale/dynamische Konvektion (RH/CIN/precipProb, Rädler 2018). Ensemble-Gewichtung nach Leadtime (Haiden 2018).',
                stunden: debugStunden,
            },
        });

    } catch (error) {
        console.error('Fehler:', error);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PHYSIKALISCHE HILFSFUNKTIONEN
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

// Bolton 1980 – theta-e (ESTOFEX-Standard)
function calcThetaE(tempC, dewC, pressHPa) {
    const T_K   = tempC + 273.15;
    const e     = 6.112 * Math.exp((17.67 * dewC) / (dewC + 243.5));
    const w     = 0.622 * e / (pressHPa - e);
    const w_gkg = w * 1000;
    const T_LCL_K = (dewC + 273.15) - 0.212 * (tempC - dewC);
    return T_K
        * Math.pow(1000 / pressHPa, 0.2854 * (1 - 0.00028 * w_gkg))
        * Math.exp((3.376 / T_LCL_K - 0.00254) * w_gkg * (1 + 0.00081 * w_gkg));
}

// Bolton 1980 CIN-Näherung (iterativ, Theta-E-Erhaltung)
function calcCIN(hour) {
    const t2m  = hour.temperature ?? 0;
    const d2m  = hour.dew ?? (t2m - 10);
    const t850 = hour.temp850 ?? 0;
    const t700 = hour.temp700 ?? 0;
    if (t2m === 0 && t850 === 0) return 0;

    const dewDep2m = t2m - d2m;
    const T_LCL    = t2m - 0.212 * dewDep2m - 0.001 * dewDep2m ** 2;
    const T_LCL_K  = T_LCL + 273.15;
    const T2m_K    = t2m + 273.15;
    const e_d2m    = 6.112 * Math.exp((17.67 * d2m) / (d2m + 243.5));
    const w2m_gkg  = 1000 * 0.622 * e_d2m / (1013.25 - e_d2m);
    const theta_e_surface = T2m_K
        * Math.pow(1000 / 1013.25, 0.2854 * (1 - 0.00028 * w2m_gkg))
        * Math.exp((3.376 / T_LCL_K - 0.00254) * w2m_gkg * (1 + 0.00081 * w2m_gkg));

    const z850 = 1500, DALR = 9.8;
    const z_LCL = 125 * dewDep2m;
    let T_parcel_850 = z_LCL >= z850 ? t2m - DALR * (z850 / 1000) : T_LCL - 4;

    if (z_LCL < z850) {
        for (let iter = 0; iter < 8; iter++) {
            const Tp_K = T_parcel_850 + 273.15;
            const es   = 6.112 * Math.exp((17.67 * T_parcel_850) / (T_parcel_850 + 243.5));
            const ws_gkg = 1000 * 0.622 * es / (850 - es);
            const thet = Tp_K * Math.pow(1000/850, 0.2854*(1-0.00028*ws_gkg))
                * Math.exp((3.376/Tp_K - 0.00254)*ws_gkg*(1+0.00081*ws_gkg));
            const delta = (theta_e_surface - thet) * 0.3;
            T_parcel_850 += delta;
            if (Math.abs(delta) < 0.001) break;
        }
    }

    const dT_850     = T_parcel_850 - t850;
    const cin_low    = dT_850 < 0
        ? (dT_850 / 2) / ((t2m + t850) / 2 + 273.15) * 9.81 * z850
        : 0;

    let cin_mid = 0;
    if (dT_850 < 0) {
        let T_parcel_700 = T_parcel_850;
        for (let iter = 0; iter < 8; iter++) {
            const Tp_K = T_parcel_700 + 273.15;
            const es   = 6.112 * Math.exp((17.67 * T_parcel_700) / (T_parcel_700 + 243.5));
            const ws_gkg = 1000 * 0.622 * es / (700 - es);
            const thet = Tp_K * Math.pow(1000/700, 0.2854*(1-0.00028*ws_gkg))
                * Math.exp((3.376/Tp_K - 0.00254)*ws_gkg*(1+0.00081*ws_gkg));
            const delta = (theta_e_surface - thet) * 0.3;
            T_parcel_700 += delta;
            if (Math.abs(delta) < 0.001) break;
        }
        const dT_700 = T_parcel_700 - t700;
        if (dT_700 < 0) {
            cin_mid = ((dT_850 + dT_700) / 2) / ((t850 + t700) / 2 + 273.15) * 9.81 * 1500;
        } else {
            const dz_neg = (dT_850 / (dT_850 - dT_700)) * 1500;
            cin_mid = (dT_850 / 2) / (t850 + 273.15) * 9.81 * dz_neg;
        }
    }

    return Math.round(Math.max(-500, Math.min(0, cin_low + cin_mid)));
}

// Bolton 1980 – Surface-Based LI
function calcLiftedIndex(hour) {
    const t2m  = hour.temperature ?? 0;
    const d2m  = hour.dew ?? (t2m - 10);
    const t500 = hour.temp500 ?? 0;
    if (t2m === 0 && t500 === 0) return 0;

    const dewDep  = t2m - d2m;
    const T_LCL   = t2m - 0.212 * dewDep - 0.001 * dewDep ** 2;
    const T_LCL_K = T_LCL + 273.15;
    const T2m_K   = t2m + 273.15;
    const e_d2m   = 6.112 * Math.exp((17.67 * d2m) / (d2m + 243.5));
    const w_gkg   = 1000 * 0.622 * e_d2m / (1013.25 - e_d2m);
    const theta_e = T2m_K
        * Math.pow(1000/1013.25, 0.2854*(1-0.00028*w_gkg))
        * Math.exp((3.376/T_LCL_K - 0.00254)*w_gkg*(1+0.00081*w_gkg));

    const z_LCL = 125 * dewDep;
    let T_parcel_500 = T_LCL - 6.0 * ((5500 - z_LCL) / 1000);
    for (let iter = 0; iter < 20; iter++) {
        const Tp_K = T_parcel_500 + 273.15;
        const es   = 6.112 * Math.exp((17.67 * T_parcel_500) / (T_parcel_500 + 243.5));
        const ws_gkg = 1000 * 0.622 * es / (500 - es);
        const thet = Tp_K * Math.pow(1000/500, 0.2854*(1-0.00028*ws_gkg))
            * Math.exp((3.376/Tp_K - 0.00254)*ws_gkg*(1+0.00081*ws_gkg));
        const delta = (theta_e - thet) * 0.15;
        T_parcel_500 += delta;
        if (Math.abs(delta) < 0.001) break;
    }
    return Math.round((t500 - T_parcel_500) * 10) / 10;
}

function calcPBLHeight(hour) {
    const t2m = hour.temperature ?? 0, t850 = hour.temp850 ?? 0, t700 = hour.temp700 ?? 0;
    const radiation = hour.directRadiation ?? 0;
    const z850 = 1500, z700 = 3000, DALR = 9.8;
    const Tp850 = t2m - DALR * (z850/1000), Tp700 = t2m - DALR * (z700/1000);

    let pbl = 200;
    if (Tp850 >= t850) {
        if (Tp700 >= t700) {
            const lapse = (t850 - t700) / (z700 - z850) * 1000;
            pbl = lapse >= DALR ? 3500 : Math.min(4000, z700 + (Tp700 - t700) / Math.max(0.01, DALR - lapse) * 1000);
        } else {
            pbl = z850 + ((Tp850 - t850) / Math.max(0.01, (Tp850-t850) - (Tp700-t700))) * (z700-z850);
        }
    } else {
        const lapse = (t2m - t850) / z850 * 1000;
        pbl = lapse <= 0 ? 200 : Math.max(200, Math.min((t2m-t850) / Math.max(0.01, DALR-lapse) * 1000, z850));
    }

    if      (radiation > 600) pbl = Math.min(4000, pbl + 400);
    else if (radiation > 300) pbl = Math.min(4000, pbl + 200);
    else if (radiation <  20) pbl = Math.max(100,  pbl - 300);
    return Math.round(Math.max(100, Math.min(4000, pbl)));
}

function calcShear(hour) {
    const ws500  = (hour.wind_speed_500hPa  ?? 0) / 3.6;
    const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
    const w500   = windToUV(ws500,  hour.windDir500  ?? 0);
    const w1000  = windToUV(ws1000, hour.windDir1000 ?? 0);
    return Math.hypot(w500.u - w1000.u, w500.v - w1000.v) * 1.08; // 1.08: 500hPa≈5.5km
}

function calcLowLevelShear(hour) {
    // 0–1 km: 1000→900 hPa
    const w1000 = windToUV((hour.wind_speed_1000hPa ?? 0)/3.6, hour.windDir1000 ?? 0);
    const w900  = windToUV((hour.wind_speed_900hPa  ?? 0)/3.6, hour.windDir900  ?? 0);
    return Math.hypot(w900.u - w1000.u, w900.v - w1000.v);
}

function calcSRH(hour, layer = '0-3km') {
    const levels = layer === '0-1km'
        ? [
            { ws: (hour.wind_speed_1000hPa ?? 0)/3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_975hPa  ?? 0)/3.6, wd: hour.windDir975  ?? 0 },
            { ws: (hour.wind_speed_950hPa  ?? 0)/3.6, wd: hour.windDir950  ?? 0 },
            { ws: (hour.wind_speed_925hPa  ?? 0)/3.6, wd: hour.windDir925  ?? 0 },
            { ws: (hour.wind_speed_900hPa  ?? 0)/3.6, wd: hour.windDir900  ?? 0 },
          ]
        : [
            { ws: (hour.wind_speed_1000hPa ?? 0)/3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_925hPa  ?? 0)/3.6, wd: hour.windDir925  ?? 0 },
            { ws: (hour.wind_speed_850hPa  ?? 0)/3.6, wd: hour.windDir850  ?? 0 },
            { ws: (hour.wind_speed_700hPa  ?? 0)/3.6, wd: hour.windDir700  ?? 0 },
          ];

    const winds  = levels.map(l => windToUV(l.ws, l.wd));
    const meanU  = winds.reduce((s,w) => s+w.u, 0) / winds.length;
    const meanV  = winds.reduce((s,w) => s+w.v, 0) / winds.length;
    const dU     = winds[winds.length-1].u - winds[0].u;
    const dV     = winds[winds.length-1].v - winds[0].v;
    const shMag  = Math.hypot(dU, dV) || 1;
    const stormU = meanU + 7.5 * (dV / shMag);
    const stormV = meanV - 7.5 * (dU / shMag);

    let srh = 0;
    for (let i = 0; i < winds.length - 1; i++) {
        const u1 = winds[i].u   - stormU, v1 = winds[i].v   - stormV;
        const u2 = winds[i+1].u - stormU, v2 = winds[i+1].v - stormV;
        srh += u1*v2 - u2*v1;
    }
    return Math.abs(srh);
}

// EBWD (Thompson 2003) – effektive Einströmschicht 1000→850 hPa
function calcEBWD(hour) {
    const levels = [
        { s: (hour.wind_speed_1000hPa ?? 0)/3.6, d: hour.windDir1000 ?? 0 },
        { s: (hour.wind_speed_975hPa  ?? 0)/3.6, d: hour.windDir975  ?? 0 },
        { s: (hour.wind_speed_950hPa  ?? 0)/3.6, d: hour.windDir950  ?? 0 },
        { s: (hour.wind_speed_925hPa  ?? 0)/3.6, d: hour.windDir925  ?? 0 },
        { s: (hour.wind_speed_900hPa  ?? 0)/3.6, d: hour.windDir900  ?? 0 },
        { s: (hour.wind_speed_850hPa  ?? 0)/3.6, d: hour.windDir850  ?? 0 },
    ];
    const uv   = levels.map(l => windToUV(l.s, l.d));
    const mU   = uv.reduce((s,w) => s+w.u, 0) / uv.length;
    const mV   = uv.reduce((s,w) => s+w.v, 0) / uv.length;
    return Math.hypot(uv[uv.length-1].u - mU, uv[uv.length-1].v - mV);
}

function calcLCLHeight(temp2m, dew2m) {
    const spread = temp2m - dew2m;
    return spread <= 0 ? 0 : Math.max(0, 125 * spread);
}

function calcMidLevelLapseRate(temp700, temp500) {
    return (temp700 - temp500) / 2.5; // K/km (≈2.5 km zwischen 700 und 500 hPa)
}

// DCAPE (Gilmore & Wicker 1998) – Downburst-Potential
function calcDCAPE(hour) {
    const temp700 = hour.temp700 ?? 0;
    const dew700  = hour.dew700  ?? 0;
    const temp2m  = hour.temperature ?? 0;
    const dewDep700 = temp700 - dew700;
    if (dewDep700 > 40) return 0;

    const wetBulb700   = temp700 - 0.43 * dewDep700;
    const T_parcel_sfc = wetBulb700 + 9.8 * 3.0;
    const tempDiff     = T_parcel_sfc - temp2m;
    if (tempDiff <= 0) return 0;

    let mf;
    if      (dewDep700 <=  2) mf = 0.20;
    else if (dewDep700 <=  5) mf = 0.50;
    else if (dewDep700 <= 10) mf = 0.90;
    else if (dewDep700 <= 15) mf = 1.00;
    else if (dewDep700 <= 20) mf = 0.80;
    else if (dewDep700 <= 25) mf = 0.60;
    else if (dewDep700 <= 30) mf = 0.40;
    else                      mf = 0.20;

    return Math.round(Math.max(0, (tempDiff / ((wetBulb700 + temp2m) / 2 + 273.15)) * 9.81 * 3000 * mf));
}

function calcWMAXSHEAR(cape, shear_ms) {
    if (cape <= 0 || shear_ms <= 0) return 0;
    return Math.round(Math.sqrt(2 * cape) * shear_ms * 3.6);
}

// Showalter (Bolton 1980, von 850 hPa aus)
function calcShowalter(hour) {
    const t850  = hour.temp850 ?? 0, d850 = hour.dew850 ?? 0, t500 = hour.temp500 ?? 0;
    const dd850 = t850 - d850;
    const T_LCL_K = (t850 - 0.212*dd850 - 0.001*dd850**2) + 273.15;
    const T850_K  = t850 + 273.15;
    const e850    = 6.112 * Math.exp((17.67*d850)/(d850+243.5));
    const w_gkg   = 1000 * 0.622 * e850 / (850 - e850);
    const theta_e = T850_K
        * Math.pow(1000/850, 0.2854*(1-0.00028*w_gkg))
        * Math.exp((3.376/T_LCL_K - 0.00254)*w_gkg*(1+0.00081*w_gkg));

    let T_p500 = (t850 - 0.212*dd850) - 6.0 * ((3000-125*dd850)/1000);
    for (let iter = 0; iter < 20; iter++) {
        const Tp_K = T_p500 + 273.15;
        const es   = 6.112 * Math.exp((17.67*T_p500)/(T_p500+243.5));
        const ws_g = 1000 * 0.622 * es / (500 - es);
        const thet = Tp_K * Math.pow(1000/500, 0.2854*(1-0.00028*ws_g))
            * Math.exp((3.376/Tp_K - 0.00254)*ws_g*(1+0.00081*ws_g));
        const delta = (theta_e - thet) * 0.15;
        T_p500 += delta;
        if (Math.abs(delta) < 0.001) break;
    }
    return t500 - T_p500;
}

// SCP (Thompson 2003, Europa-kalibriert Taszarek 2020)
function calcSCP(cape, shear, srh3km, cin) {
    if (cape < 100 || shear < 6 || srh3km < 40) return 0;
    const magCin   = -Math.min(0, cin ?? 0);
    const cinTerm  = magCin < 40 ? 1.0 : Math.max(0.1, 1 - (magCin-40)/200);
    return Math.max(0, (cape/1000) * Math.min(srh3km/50, 4) * Math.min(shear/12, 1.5) * cinTerm);
}

// STP (Púčik 2015, Thompson 2003 – Europa-kalibriert)
function calcSTP(cape, srh1km, shear, cin, temp2m, dew2m, hour) {
    if (cape < 80 || srh1km < 40 || shear < 12.5) return 0;
    const lcl     = calcLCLHeight(temp2m, dew2m);
    const lclTerm = lcl < 1000 ? 1.0 : lcl >= 2000 ? 0.0 : (2000-lcl)/1000;
    const magCin  = -Math.min(0, cin ?? 0);
    const cinTerm = magCin <= 50 ? 1.0 : magCin >= 200 ? 0.0 : (200-magCin)/150;
    const ebwd    = hour ? calcEBWD(hour) : shear;
    return Math.max(0,
        Math.min(cape/1500, 3) *
        Math.min(srh1km/150, 3) *
        Math.min(ebwd/20, 2) *
        lclTerm * cinTerm);
}

// SHIP (Europäisch kalibriert, ~37% niedriger als NOAA)
function calcSHIP(hour, shear) {
    const cape  = hour.cape ?? 0;
    const t500  = hour.temp500 ?? 0;
    const lapse = calcMidLevelLapseRate(hour.temp700 ?? 0, t500);
    const e850  = 6.112 * Math.exp((17.67*(hour.dew850??0))/((hour.dew850??0)+243.5));
    const mixR  = 1000 * 0.622 * e850 / (850 - e850);
    if (cape < 100 || t500 >= -5 || mixR < 5 || shear < 7 || lapse < 5.5) return 0;
    return Math.max(0, (cape * mixR * lapse * Math.abs(t500) * shear) / 28000000);
}

function calcELI(cape, cin, pblHeight) {
    if (cape < 50) return 0;
    const pblF = pblHeight > 1500 ? 1.2 : pblHeight > 1000 ? 1.0 : pblHeight > 500 ? 0.8 : 0.6;
    const magCin = -Math.min(0, cin ?? 0);
    const cinF = magCin < 25 ? 1.0 : magCin < 50 ? 0.9 : magCin < 100 ? 0.7 : magCin < 150 ? 0.5 : 0.3;
    return cape * pblF * cinF;
}

// ═══════════════════════════════════════════════════════════════════════════
// ABGELEITETE PARAMETER – einmal pro Modellstunde berechnen
// ═══════════════════════════════════════════════════════════════════════════
function getDerived(h) {
    const shear   = calcShear(h);
    const srh1km  = calcSRH(h, '0-1km');
    const srh3km  = calcSRH(h, '0-3km');
    const ebwd    = calcEBWD(h);
    const dcape   = calcDCAPE(h);
    const wmaxshear = calcWMAXSHEAR(h.cape, shear);
    const lcl     = calcLCLHeight(h.temperature, h.dew);
    const midLapse = calcMidLevelLapseRate(h.temp700, h.temp500);
    const eli     = calcELI(h.cape, h.cin, h.pblHeight);

    const rh850   = h.rh850 ?? calcRelHum(h.temp850, h.dew850);
    const rh700   = h.rh700 ?? calcRelHum(h.temp700, h.dew700);
    const meanRH  = (rh850 + rh700 + (h.rh500 ?? 50)) / 3;
    const moistureDepth = (rh850 + rh700) / 2;

    const e850    = 6.112 * Math.exp((17.67*(h.dew850??0))/((h.dew850??0)+243.5));
    const mixR850 = 1000 * 0.622 * e850 / (850 - e850);

    const thetaE850 = calcThetaE(h.temp850, h.dew850, 850);
    const thetaE700 = calcThetaE(h.temp700, h.dew700, 700);

    const scp  = calcSCP(h.cape, shear, srh3km, h.cin);
    const stp  = calcSTP(h.cape, srh1km, shear, h.cin, h.temperature, h.dew, h);
    const ship = calcSHIP(h, shear);
    const ehi  = (h.cape * srh1km) / 160000;

    const kIndex   = (h.temp850 - h.temp500) + h.dew850 - (h.temp700 - h.dew700);
    const showalter = calcShowalter(h);
    const llShear  = calcLowLevelShear(h);

    return {
        shear, srh1km, srh3km, ebwd, dcape, wmaxshear,
        lcl, midLapse, eli, rh850, rh700, meanRH, moistureDepth,
        mixR850, thetaE850, thetaE700, scp, stp, ship, ehi,
        kIndex, showalter, llShear,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// SAISONALE KALIBRIERUNG
// Taszarek 2020: saisonale und regionale Variabilität europäischer Gewitter
// März/April: Schwellen ~15–20 K niedriger als Sommer (weniger CAPE nötig)
// ═══════════════════════════════════════════════════════════════════════════
function getSeasonalOffset(month) {
    // Rückgabe: { thetaE: K, cape: J/kg, li: Kelvin }
    // Negativ = niedrigere Schwelle = leichter zu erreichen
    if (month <= 2 || month >= 11) return { thetaE: -20, cape: -150, li: +1.0 }; // Winter
    if (month <= 4)                return { thetaE: -15, cape: -100, li: +0.7 }; // Frühling
    if (month <= 9)                return { thetaE:   0, cape:    0, li:  0.0 }; // Sommer
    return                                { thetaE: -10, cape:  -75, li: +0.5 }; // Herbst
}

// ═══════════════════════════════════════════════════════════════════════════
// GEWITTERWAHRSCHEINLICHKEIT – ZWEI-PFAD-METHODIK
//
// Pfad A: Thermisch (CAPE-dominiert) – Rädler 2018 Logit, kalibriert Sommer
// Pfad B: Frontal/dynamisch – mechanische Hebung, wenig CIN, hohe Feuchte
//         Prädiktoren: precipProb, meanRH, LI, CIN, shear (Rädler 2018 Tab.2)
//
// Finale Wahrscheinlichkeit = max(pA, pB) – konservative Obergrenze
// ═══════════════════════════════════════════════════════════════════════════
function calcThunderProb(hour, d) {
    const month  = new Date().getMonth() + 1;
    const season = getSeasonalOffset(month);

    const cape      = hour.cape ?? 0;
    const cin       = hour.cin  ?? 0;
    const magCin    = -Math.min(0, cin);
    const temp2m    = hour.temperature ?? 0;
    const dew2m     = hour.dew ?? 0;
    const li        = hour.liftedIndex ?? 0;
    const precipProb = hour.precip    ?? 0;
    const precipAcc  = hour.precipAcc ?? 0;
    const { shear, meanRH, thetaE850, mixR850, dcape, scp, stp, wmaxshear,
            lcl, midLapse, srh3km, ehi, eli, kIndex } = d;

    // ── Harte Ausschlüsse (physikalisch unmöglich) ──────────────────────
    if (temp2m < 2 && cape < 500)                      return 0;
    if (meanRH < 35)                                   return 0; // extreme Trockenheit
    if (li > 6  && cape < 100 && precipProb < 30)     return 0;

    // ─────────────────────────────────────────────────────────────────────
    // PFAD A: Thermische Konvektion (Sommer, CAPE-getrieben)
    // Logistische Regression nach Rädler 2018 / Battaglioli 2023
    // Hauptprädiktoren: CAPE (log), LI, meanRH, Mischungsverhältnis
    // ─────────────────────────────────────────────────────────────────────
    let pA = 0;
    {
        // Saisonal angepasster LI-Term
        const li_eff = li - season.li; // positiver offset = schwieriger
        // CAPE saisonal: im Frühling reichen 100 J/kg wo im Sommer 200 bräuchte
        const cape_eff = Math.max(0, cape + season.cape); // scheinbar höher = leichter

        let logit = -4.5;
        logit += -li_eff * 0.55;
        logit += (meanRH - 55) / 25 * 1.70;
        logit += cape_eff > 0 ? Math.log1p(cape_eff / 120) * 1.25 : 0;
        logit += (mixR850 - 4.5) / 5 * 1.20;

        // CIN dämpft die Auslöse – weniger als bisher, da CIN oft überschätzt wird
        if (magCin >  50) logit -= (magCin -  50) / 120 * 1.0;
        if (magCin > 150) logit -= 0.8;

        // Temperatur-Gate (zu kalt → kein thermischer Trigger)
        if (temp2m < 6)  logit -= 1.5;
        else if (temp2m < 10) logit -= 0.5;

        // Scherungsverstärkung (HSLC: high shear low cape)
        if (shear >= 12 && cape >= 50) logit += Math.log1p(wmaxshear / 350) * 0.8;

        // Composite-Terme: SCP, STP signifikant in Europa (Taszarek 2020)
        if (scp >= 0.5) logit += Math.log1p(scp) * 0.9;
        if (stp >= 0.3) logit += Math.log1p(stp) * 0.7;

        pA = Math.round((1 / (1 + Math.exp(-logit))) * 100);

        // Unter ~8% → konservativ auf 0 (CAPE-Pfad braucht substanzielle Grundlage)
        if (pA < 8) pA = 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    // PFAD B: Frontale / dynamische Konvektion
    // Mechanische Hebung (Kaltfront, Konvergenz, Orographie),
    // geringes CAPE reicht wenn CIN klein und Feuchte hoch.
    //
    // Prädiktoren (Rädler 2018 Tabelle 2, Battaglioli 2023):
    //   precipProb   – NWP-Niederschlagswahrscheinlichkeit (gute Proxy für Hebung)
    //   meanRH       – Feuchte im Profil
    //   CIN (negativ)– Hemmung (wenig CIN = leichte Auslöse)
    //   shear        – Scherung (frontale Konvektion organisierter bei hoher Scherung)
    //   li_frontal   – LI mit Frontal-Offset (mechanische Hebung überwindet li<5)
    //   dcape        – Trockene Mittelschicht → Downburst-Antrieb
    // ─────────────────────────────────────────────────────────────────────
    let pB = 0;
    {
        // Mindestbedingungen frontale Konvektion
        // precipProb >= 25% UND meanRH >= 55% UND LI < 5.5 (saisonal korrigiert)
        const li_frontal = li - season.li;
        const triggerFrontal =
            precipProb >= 25 &&
            meanRH >= 55 &&
            li_frontal < 5.5 &&
            magCin < 180;     // CIN > 180 J/kg → auch mechanische Hebung reicht nicht

        if (triggerFrontal) {
            // Basisterm: precipProb ist der stärkste Proxy für vorhandene Hebung
            let logit = -5.0;

            // precipProb: Hauptprädiktor (stark nichtlinear)
            logit += Math.log1p(precipProb / 15) * 2.5;

            // Feuchte: sehr wichtig (trockenes Profil → kein Gewitter trotz Hebung)
            logit += (meanRH - 55) / 20 * 1.60;

            // LI: auch bei frontaler Konvektion relevant (weniger als thermisch)
            logit += -li_frontal * 0.35;

            // CIN: dämpft, aber schwächer als bei thermischer Konvektion
            // (mechanische Hebung überwindet CIN leichter)
            if (magCin > 80)  logit -= (magCin -  80) / 150 * 0.8;
            if (magCin > 160) logit -= 0.5;

            // Scherung: frontale Gewitter bei Scherung deutlich häufiger
            if      (shear >= 18) logit += 0.9;
            else if (shear >= 13) logit += 0.6;
            else if (shear >= 9)  logit += 0.3;

            // CAPE ergänzt (optional bei frontaler Konvektion)
            if (cape > 0) logit += Math.log1p(cape / 200) * 0.6;

            // thetaE850 (saisonal korrigiert) – Feuchte-Energiegehalt
            const thetaRef = 315 + season.thetaE;
            if      (thetaE850 >= thetaRef + 10) logit += 0.8;
            else if (thetaE850 >= thetaRef)      logit += 0.4;
            else if (thetaE850 < thetaRef - 10)  logit -= 0.5;

            // Feuchtprofil Mittelschicht (Rädler 2018: mixR850 ≥ 5 g/kg günstig)
            if      (mixR850 >= 8) logit += 0.5;
            else if (mixR850 >= 5) logit += 0.2;
            else if (mixR850 < 3)  logit -= 0.7;

            // DCAPE: trockene, kalte Mittelluft befördert konvektive Zellen
            if      (dcape >= 800) logit += 0.6;
            else if (dcape >= 500) logit += 0.3;

            // precip akkumuliert (tatsächliche Niederschlagsmengen)
            if      (precipAcc >= 1.0) logit += 0.4;
            else if (precipAcc >= 0.5) logit += 0.2;

            pB = Math.round((1 / (1 + Math.exp(-logit))) * 100);

            // Frontaler Pfad: konservative Obergrenze
            // Bei sehr wenig CAPE und CIN kann dieser Pfad max. ~55% erreichen
            // (entspricht ESTOFEX "slight risk" bis "moderate risk" bei Frontallagen)
            const frontCap = cape < 100 ? 40 : cape < 300 ? 55 : 75;
            pB = Math.min(frontCap, pB);

            // Sehr kleine Werte unterdrücken (Rauschen)
            if (pB < 8) pB = 0;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // FINALE KOMBINATION
    // max(pA, pB) – der stärkere Pfad gewinnt.
    // Kein additives Mischen, da beide Pfade bereits unabhängige Vollschätzungen sind.
    // Physikalisch: wenn eine der Konvektionsarten wahrscheinlich ist, zählt das.
    // ─────────────────────────────────────────────────────────────────────
    let prob = Math.max(pA, pB);

    // Temperaturskalierung bei Kälte (auch frontale Konvektion seltener unter 5°C)
    if      (temp2m < 4)  prob = Math.round(prob * 0.45);
    else if (temp2m < 8)  prob = Math.round(prob * 0.65);
    else if (temp2m < 11) prob = Math.round(prob * 0.82);

    // Nacht-Dämpfung nur wenn keine Frontal-Unterstützung
    const isNight = hour.directRadiation < 20;
    if (isNight && shear < 10 && cape < 300 && precipProb < 40) {
        prob = Math.round(prob * 0.7);
    }

    return Math.min(100, Math.max(0, prob));
}

// Debug-Hilfsfunktion: welcher Pfad hat getriggert
function debugThunderPath(hour, d) {
    const month  = new Date().getMonth() + 1;
    const season = getSeasonalOffset(month);
    const cape = hour.cape ?? 0;
    const li   = hour.liftedIndex ?? 0;
    const precipProb = hour.precip ?? 0;
    const { meanRH, thetaE850 } = d;
    const magCin = -Math.min(0, hour.cin ?? 0);
    const li_frontal = li - season.li;
    const thetaRef   = 315 + season.thetaE;

    const reasons = [];
    if (cape >= 50)                        reasons.push(`CAPE=${cape}J/kg`);
    if (li < 2 - season.li)               reasons.push(`LI=${li.toFixed(1)}`);
    if (precipProb >= 25 && meanRH >= 55 && li_frontal < 5.5 && magCin < 180)
                                           reasons.push(`FRONTAL(pp=${precipProb}%,RH=${Math.round(meanRH)}%,li_eff=${li_frontal.toFixed(1)})`);
    if (thetaE850 >= thetaRef)             reasons.push(`θE850=${thetaE850.toFixed(0)}K≥${thetaRef}K`);
    if (magCin > 150)                      reasons.push(`CIN_LIMIT(cin=${Math.round(hour.cin??0)}J/kg)`);
    if (meanRH < 35)                       reasons.push('BLOCKED_DRY');
    return reasons.join(' | ') || 'keine_trigger';
}

// ═══════════════════════════════════════════════════════════════════════════
// TORNADO-WAHRSCHEINLICHKEIT
// Europa-STP (Púčik 2015, Taszarek 2020): normCAPE=1500, EBWD/20
// Nur wenn Gewitterwahrscheinlichkeit >= 45% (konservativ)
// ═══════════════════════════════════════════════════════════════════════════
function stpToPercentEurope(stp) {
    if (stp < 0.1) return 0;
    if (stp < 0.3) return 3;
    if (stp < 0.5) return 6;
    if (stp < 1.0) return 12;
    if (stp < 1.5) return 22;
    if (stp < 2.0) return 32;
    if (stp < 2.5) return 45;
    if (stp < 3.0) return 58;
    if (stp < 4.0) return 72;
    if (stp < 5.0) return 85;
    return 95;
}

function calcTornadoProb(hour, d, thunderProb) {
    if (thunderProb < 45) return 0;

    const cape  = hour.cape ?? 0;
    const lcl   = calcLCLHeight(hour.temperature, hour.dew);
    const { srh1km, ebwd } = d;

    const lclTerm = lcl < 1000 ? 1.0 : lcl >= 2000 ? 0.0 : (2000-lcl)/1000;
    const cinTerm = Math.max(0, (200 + (hour.cin??0)) / 150);
    const stp = Math.max(0, (cape/1500) * lclTerm * (srh1km/150) * (ebwd/20) * cinTerm);

    let p = stpToPercentEurope(stp);
    if (p < 8) return 0;
    return Math.min(thunderProb, Math.round(p * 0.85));
}

// ═══════════════════════════════════════════════════════════════════════════
// HAGELWAHRSCHEINLICHKEIT
// SHIP (Johnson & Sugier 2014, ESSL TN) – bedingt auf Gewitterwahrscheinlichkeit
// Nur wenn Gewitter >= 15%
// ═══════════════════════════════════════════════════════════════════════════
function calcHailProb(hour, d, thunderProb) {
    if (thunderProb < 15) return 0;

    const { ship } = d;
    let hailRaw;
    if      (ship >= 4.0) hailRaw = 95;
    else if (ship >= 3.0) hailRaw = 80;
    else if (ship >= 2.0) hailRaw = 62;
    else if (ship >= 1.5) hailRaw = 46;
    else if (ship >= 1.0) hailRaw = 30;
    else if (ship >= 0.5) hailRaw = 15;
    else if (ship >= 0.2) hailRaw =  6;
    else                  hailRaw =  0;

    // Bedingt auf Gewitterwahrscheinlichkeit, leicht konservativ
    return Math.min(100, Math.round(hailRaw * (thunderProb / 100) * 0.85));
}

// ═══════════════════════════════════════════════════════════════════════════
// SEVERE-WIND-WAHRSCHEINLICHKEIT
// ESTOFEX Z_wind Methodik: DCAPE + WMAXSHEAR + Midlevel-Trockenheit
// Vereinfacht auf physikalisch kohärente Logit-Form
// Nur wenn Gewitter >= 15%
// ═══════════════════════════════════════════════════════════════════════════
function calcWindProb(hour, d, thunderProb) {
    if (thunderProb < 15) return 0;

    const { dcape, wmaxshear, shear, llShear, midLapse, meanRH } = d;
    const cape   = hour.cape ?? 0;
    const dew700 = hour.dew700 ?? 0;
    const temp700 = hour.temp700 ?? 0;
    const dewDep700 = temp700 - dew700;

    // Mindestbedingungen (Gilmore & Wicker 1998, ESTOFEX Z_wind)
    if (dcape < 200 && wmaxshear < 400) return 0;

    // Logit-Ansatz statt Score-Summe
    let logit = -4.8;

    // DCAPE: Primärprädiktor für Downburst-Potenzial
    logit += Math.log1p(dcape / 200) * 1.8;

    // WMAXSHEAR: kombiniert Aufwärts- und Schermechanismus
    logit += Math.log1p(wmaxshear / 300) * 1.6;

    // Bulk-Shear: organisierte Konvektion = gefährlichere Böen
    if      (shear >= 22) logit += 0.9;
    else if (shear >= 16) logit += 0.6;
    else if (shear >= 11) logit += 0.3;

    // Low-level Shear: wichtig für Downburst-Kanalisierung
    if      (llShear >= 12) logit += 0.6;
    else if (llShear >= 8)  logit += 0.3;

    // Midlevel-Trockenheit: begünstigt Downbursts stark
    if      (dewDep700 >= 20 && dcape >= 500) logit += 0.9;
    else if (dewDep700 >= 15 && dcape >= 400) logit += 0.6;
    else if (dewDep700 >= 8  && dcape >= 300) logit += 0.3;
    else if (dewDep700 < 4   && dcape < 700)  logit -= 0.4;

    // Mittlere RH: Feucht-Umgebung dämpft Downburst (Verdampfungskühlung weniger effizient)
    if      (meanRH < 40 && dcape >= 500) logit += 0.5;
    else if (meanRH < 55 && dcape >= 400) logit += 0.2;
    else if (meanRH > 75 && dcape < 700)  logit -= 0.5;

    // Midlevel-Lapserate: steile Rate = schneller sinkende Luft
    if (midLapse >= 7.5 && dcape >= 400) logit += 0.5;
    else if (midLapse >= 6.5 && dcape >= 300) logit += 0.3;

    const pWind = Math.round((1 / (1 + Math.exp(-logit))) * 100);

    // Bedingt auf Gewitterwahrscheinlichkeit
    const combined = Math.round(pWind * (thunderProb / 100) * 0.9);
    return Math.min(100, Math.max(0, combined));
}

// ═══════════════════════════════════════════════════════════════════════════
// RISIKO-KATEGORISIERUNG (ESTOFEX-Standard)
// ═══════════════════════════════════════════════════════════════════════════
function categorizeRisk(prob) {
    const p = Math.max(0, Math.min(100, Math.round(prob ?? 0)));
    if (p >= 70) return { level: 3, label: 'high' };
    if (p >= 45) return { level: 2, label: 'moderate' };
    if (p >= 15) return { level: 1, label: 'tstorm' };
    return        { level: 0, label: 'none' };
}