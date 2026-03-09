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
                rh500:              get('relative_humidity_500hPa') ?? 50,
                rh700:              get('relative_humidity_700hPa') ?? null,
                rh850:              get('relative_humidity_850hPa') ?? null,
                cape_api:           Math.max(0, get('cape') ?? 0),
                directRadiation:    get('direct_radiation') ?? 0,
                precipAcc:          get('precipitation') ?? 0,
                freezingLevel:      get('freezing_level_height') ?? 3000,
                cin_api:            get('convective_inhibition') ?? null,
                liftedIndex_api:    get('lifted_index') ?? null,
                pblHeight:          get('boundary_layer_height') ?? null,
            };

            // ══ Parcel-Berechnungen (SHARPpy-konform: SB / ML / MU) ══════
            const parcels = calcAllParcels(hour);
            hour.sb = parcels.sb;  // { cape, cin, lcl, lfc, li, temp, dew }
            hour.ml = parcels.ml;  // { cape, cin, lcl, lfc, li, temp, dew }
            hour.mu = parcels.mu;  // { cape, cin, lcl, lfc, li, temp, dew, pres_label }

            hour.sbcape = hour.sb.cape;
            hour.mlcape = hour.ml.cape;
            hour.mucape = hour.mu.cape;
            hour.sbcin  = hour.sb.cin;
            hour.mlcin  = hour.ml.cin;
            hour.mucin  = hour.mu.cin;
            hour.sblcl  = hour.sb.lcl;
            hour.mllcl  = hour.ml.lcl;
            hour.mulcl  = hour.mu.lcl;

            // Standard für alle Probabilities: MLCAPE / MLCIN (ESSL-operationell)
            hour.cape = hour.mlcape;
            hour.cin  = hour.mlcin;

            hour.pblHeight    = hour.pblHeight ?? calcPBLHeight(hour);
            hour.liftedIndex  = hour.ml.li;

            return hour;
        }

        function getModelWeight(model, leadtimeHours) { return 1/3; }

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
            if (!valid.length) return 0;
            return valid.reduce((s, v) => s + v, 0) / valid.length;
        }

        const hours = data.hourly.time.map((t, i) => {
            const forecastTime  = new Date(t);
            const leadtimeHours = Math.round((forecastTime - now) / 3600000);
            const modelHours    = {};

            for (const model of MODELS) {
                modelHours[model] = extractModelHour(data.hourly, i, model);
            }

            const gewitter_by_model = {}, tornado_by_model  = {};
            const hagel_by_model    = {}, wind_by_model     = {};

            for (const model of MODELS) {
                const mh = modelHours[model];
                if (!mh) {
                    gewitter_by_model[model] = null; tornado_by_model[model]  = null;
                    hagel_by_model[model]    = null; wind_by_model[model]     = null;
                    continue;
                }
                const shear     = calcShear(mh);
                const srh       = calcSRH(mh, '0-3km');
                const dcape     = calcDCAPE(mh);
                const wmaxshear = calcWMAXSHEAR(mh.mlcape, shear);

                gewitter_by_model[model] = calculateProbability(mh);
                tornado_by_model[model]  = calculateTornadoProbability(mh, shear, srh);
                hagel_by_model[model]    = calculateHailProbability(mh, wmaxshear, dcape);
                wind_by_model[model]     = calculateWindProbability(mh, wmaxshear, dcape);
            }

            const probability        = ensembleProb(gewitter_by_model, leadtimeHours);
            const tornadoProbability = Math.min(ensembleProb(tornado_by_model, leadtimeHours), probability);
            const hailProbability    = ensembleProb(hagel_by_model, leadtimeHours);
            const windProbability    = ensembleProb(wind_by_model,  leadtimeHours);

            const validModelHours = Object.values(modelHours).filter(Boolean);

            return {
                time: t,
                probability,
                tornadoProbability,
                hailProbability,
                windProbability,
                temperature: Math.round(ensembleMean(validModelHours.map(mh => mh.temperature)) * 10) / 10,
                cape:        Math.round(ensembleMean(validModelHours.map(mh => mh.mlcape))),
                shear:       Math.round(ensembleMean(validModelHours.map(mh => calcShear(mh))) * 10) / 10,
                srh:         Math.round(ensembleMean(validModelHours.map(mh => calcSRH(mh, '0-3km'))) * 10) / 10,
                dcape:       Math.round(ensembleMean(validModelHours.map(mh => calcDCAPE(mh)))),
                wmaxshear:   Math.round(ensembleMean(validModelHours.map(mh => calcWMAXSHEAR(mh.mlcape, calcShear(mh))))),
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

        // ══ DEBUG: erste 3 Stunden vollständig ══════════════════════════════
        const debugStunden = nextHours.slice(0, 3).map((h) => {
            const i = data.hourly.time.indexOf(h.time);
            const perModel = {};

            for (const model of MODELS) {
                const mh = extractModelHour(data.hourly, i, model);
                if (!mh) { perModel[model] = null; continue; }

                const shear  = calcShear(mh);
                const srh3km = calcSRH(mh, '0-3km');
                const srh1km = calcSRH(mh, '0-1km');
                const dcape  = calcDCAPE(mh);
                const wms    = calcWMAXSHEAR(mh.mlcape, shear);
                const ebwd   = calcEBWD(mh);

                // Komposit-Indizes je Parcel-Typ
                const scp_mu  = calcSCP(mh.mucape, shear, srh3km, mh.mucin);
                const scp_ml  = calcSCP(mh.mlcape, shear, srh3km, mh.mlcin);
                const stp_ml  = calcSTP(mh.mlcape, srh1km, shear, mh.ml.li, mh.mlcin, mh.ml.temp, mh.ml.dew, mh);
                const stp_sb  = calcSTP(mh.sbcape, srh1km, shear, mh.sb.li, mh.sbcin, mh.temperature, mh.dew, mh);
                const ehi_ml  = (mh.mlcape * srh1km) / 160000;
                const ehi_sb  = (mh.sbcape * srh1km) / 160000;
                const ship    = calcSHIP(mh);

                const { kIndex, showalter } = calcIndices(mh);
                const midLapse    = calcMidLevelLapseRate(mh.temp700 ?? 0, mh.temp500 ?? 0);
                const rh850       = mh.rh850 ?? calcRelHum(mh.temp850 ?? 0, mh.dew850 ?? 0);
                const rh700       = mh.rh700 ?? calcRelHum(mh.temp700 ?? 0, mh.dew700 ?? 0);
                const meanRH      = (rh850 + rh700 + (mh.rh500 ?? 50)) / 3;
                const moistDepth  = calcMoistureDepth(mh.dew850 ?? 0, mh.dew700 ?? 0, mh.temp850 ?? 0, mh.temp700 ?? 0);
                const relHum2m    = calcRelHum(mh.temperature ?? 0, mh.dew ?? 0);
                const e850_dew    = 6.112 * Math.exp((17.67 * (mh.dew850 ?? 0)) / ((mh.dew850 ?? 0) + 243.5));
                const mixR850     = 1000 * 0.622 * e850_dew / (850 - e850_dew);
                const thetaE850   = calcThetaE(mh.temp850 ?? 0, mh.dew850 ?? 0, 850);
                const thetaE700   = calcThetaE(mh.temp700 ?? 0, mh.dew700 ?? 0, 700);
                const thetaE_sfc  = calcThetaE_Bolton(mh.temperature ?? 0, mh.dew ?? 0, 1013.25);
                const thetaE_ml   = calcThetaE_Bolton(mh.ml.temp, mh.ml.dew, 1013.25);

                perModel[model] = {
                    // ── Wahrscheinlichkeiten ──────────────────────────────
                    gewitter:  calculateProbability(mh),
                    tornado:   calculateTornadoProbability(mh, shear, srh3km),
                    hagel:     calculateHailProbability(mh, wms, dcape),
                    wind:      calculateWindProbability(mh, wms, dcape),

                    // ── CAPE nach Parcel-Typ (SHARPpy: SB / ML / MU) ─────
                    sbcape:    Math.round(mh.sbcape),
                    mlcape:    Math.round(mh.mlcape),
                    mucape:    Math.round(mh.mucape),
                    cape_api:  Math.round(mh.cape_api),

                    // ── CIN nach Parcel-Typ ───────────────────────────────
                    sbcin:     Math.round(mh.sbcin),
                    mlcin:     Math.round(mh.mlcin),
                    mucin:     Math.round(mh.mucin),
                    cin_api:   Math.round(mh.cin_api ?? 0),

                    // ── LCL nach Parcel-Typ ───────────────────────────────
                    sblcl:     Math.round(mh.sblcl),
                    mllcl:     Math.round(mh.mllcl),
                    mulcl:     Math.round(mh.mulcl),

                    // ── LFC nach Parcel-Typ (m AGL) ───────────────────────
                    sblfc:     mh.sb.lfc ?? null,
                    mllfc:     mh.ml.lfc ?? null,
                    mulfc:     mh.mu.lfc ?? null,

                    // ── Lifted Index nach Parcel-Typ ──────────────────────
                    li_sb:     Math.round(mh.sb.li * 10) / 10,
                    li_ml:     Math.round(mh.ml.li * 10) / 10,
                    li_mu:     Math.round(mh.mu.li * 10) / 10,
                    li_api:    Math.round((mh.liftedIndex_api ?? 0) * 10) / 10,

                    // ── Parcel-Startbedingungen ───────────────────────────
                    sb_temp:       Math.round(mh.temperature * 10) / 10,
                    sb_dew:        Math.round(mh.dew * 10) / 10,
                    ml_temp:       Math.round(mh.ml.temp * 10) / 10,
                    ml_dew:        Math.round(mh.ml.dew * 10) / 10,
                    mu_temp:       Math.round(mh.mu.temp * 10) / 10,
                    mu_dew:        Math.round(mh.mu.dew * 10) / 10,
                    mu_niveau:     mh.mu.pres_label,

                    // ── θe nach Parcel-Typ ────────────────────────────────
                    thetaE_sfc:   Math.round(thetaE_sfc * 10) / 10,
                    thetaE_ml:    Math.round(thetaE_ml * 10) / 10,
                    thetaE_850:   Math.round(thetaE850 * 10) / 10,
                    thetaE_700:   Math.round(thetaE700 * 10) / 10,

                    // ── Thermodynamik sonstige ────────────────────────────
                    dcape:         Math.round(dcape),
                    eli:           Math.round(calcELI(mh.mlcape, mh.mlcin, mh.pblHeight)),
                    ship:          Math.round(ship * 100) / 100,
                    freezingLevel: Math.round(mh.freezingLevel ?? 0),
                    pblHeight:     Math.round(mh.pblHeight ?? 0),

                    // ── Temperatur/Taupunkt Niveaus ───────────────────────
                    temp2m:    Math.round(mh.temperature * 10) / 10,
                    dew2m:     Math.round(mh.dew * 10) / 10,
                    temp500:   Math.round(mh.temp500 * 10) / 10,
                    temp700:   Math.round(mh.temp700 * 10) / 10,
                    temp850:   Math.round(mh.temp850 * 10) / 10,
                    dew700:    Math.round(mh.dew700 * 10) / 10,
                    dew850:    Math.round(mh.dew850 * 10) / 10,

                    // ── Feuchte ───────────────────────────────────────────
                    relHum2m:    Math.round(relHum2m),
                    rh500:       Math.round(mh.rh500 ?? 0),
                    rh700:       Math.round(rh700),
                    rh850:       Math.round(rh850),
                    meanRH:      Math.round(meanRH),
                    moistDepth:  Math.round(moistDepth),
                    mixR850:     Math.round(mixR850 * 10) / 10,
                    pwat:        Math.round(mh.pwat ?? 0),

                    // ── Instabilitätsindizes ──────────────────────────────
                    kIndex:    Math.round(kIndex * 10) / 10,
                    showalter: Math.round(showalter * 10) / 10,
                    midLapse:  Math.round(midLapse * 10) / 10,

                    // ── Scherung & Rotation ───────────────────────────────
                    shear:     Math.round(shear * 10) / 10,
                    srh1km:    Math.round(srh1km * 10) / 10,
                    srh3km:    Math.round(srh3km * 10) / 10,
                    ebwd:      Math.round(ebwd * 10) / 10,
                    wmaxshear: Math.round(wms),

                    // ── Komposit-Indizes je Parcel-Typ ────────────────────
                    scp_mu:  Math.round(scp_mu * 100) / 100,
                    scp_ml:  Math.round(scp_ml * 100) / 100,
                    stp_ml:  Math.round(stp_ml * 100) / 100,
                    stp_sb:  Math.round(stp_sb * 100) / 100,
                    ehi_ml:  Math.round(ehi_ml * 100) / 100,
                    ehi_sb:  Math.round(ehi_sb * 100) / 100,

                    // ── Bodenwind ─────────────────────────────────────────
                    wind10m:  Math.round(mh.wind * 10) / 10,
                    gust10m:  Math.round(mh.gust * 10) / 10,

                    // ── Wolken & Niederschlag ─────────────────────────────
                    cloudLow:   Math.round(mh.cloudLow ?? 0),
                    cloudMid:   Math.round(mh.cloudMid ?? 0),
                    cloudHigh:  Math.round(mh.cloudHigh ?? 0),
                    precipProb: Math.round(mh.precip ?? 0),
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
            timezone,
            region,
            stunden,
            tage,
            debug: {
                hinweis:   'ESSL AR-CHaMo Methodik. MLCAPE/MLCIN als Standard für alle Probabilities. SCP nutzt MUCAPE, STP nutzt MLCAPE.',
                methodik: {
                    sb_parcel:  'Surface-Based: 2m T/Td direkt als Parcel-Start',
                    ml_parcel:  'Mixed-Layer: gewichteter Mittelwert SFC(60%) + 850hPa(40%) ≈ unterste 100 hPa (SHARPpy flag=4)',
                    mu_parcel:  'Most-Unstable: Level mit maximalem θe aus SFC/850/700 hPa (SHARPpy flag=3)',
                    cape_cin:   'Integration via Bolton 1980 θe-Erhaltung, iterative feuchtadiabatische Hebung, 3 Schichten (SFC→850→700→500 hPa)',
                    lcl:        'Bolton 1980: LCL = 125 * (T - Td) in Metern',
                    lfc:        'Niveau wo Parcel erstmals wärmer als Umgebung (zwischen 850/700/500 hPa)',
                    li:         'Lifted Index = T_env_500 - T_parcel_500 (negativ = instabil)',
                    scp:        'Supercell Composite Parameter mit MUCAPE (Thompson 2004)',
                    stp:        'Significant Tornado Parameter mit MLCAPE + MLLCL + MLCIN (Thompson 2012)',
                    ship:       'Significant Hail Parameter mit MUCAPE (SPC/Jewell 2014)',
                    ehi:        'Energy Helicity Index mit MLCAPE',
                },
                stunden: debugStunden,
            },
        });

    } catch (error) {
        console.error('Fehler:', error);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PARCEL-BERECHNUNGEN (SHARPpy-konform)
// Quellen: SHARPpy params.py, Bolton 1980, Taszarek 2020, Thompson 2012
// ═══════════════════════════════════════════════════════════════════════════

/**
 * θe nach Bolton 1980 mit LCL-Berechnung
 * Quelle: SHARPpy thermo.py, Bolton 1980 Eq. 43
 */
function calcThetaE_Bolton(tempC, dewC, pressHPa) {
    const T_K    = tempC + 273.15;
    const dewDep = Math.max(0, tempC - dewC);
    const T_LCL_K = (tempC - 0.212 * dewDep - 0.001 * dewDep * dewDep) + 273.15;
    const e_d    = 6.112 * Math.exp((17.67 * dewC) / (dewC + 243.5));
    const w_gkg  = 1000 * 0.622 * e_d / (Math.max(pressHPa - e_d, 1));
    return T_K
        * Math.pow(1000 / pressHPa, 0.2854 * (1 - 0.00028 * w_gkg))
        * Math.exp((3.376 / T_LCL_K - 0.00254) * w_gkg * (1 + 0.00081 * w_gkg));
}

/**
 * LCL-Höhe nach Bolton 1980
 * Quelle: SHARPpy thermo.py lcltemp + drylift
 */
function calcLCLHeight(temp2m, dew2m) {
    const spread = temp2m - dew2m;
    if (spread <= 0) return 0;
    return Math.max(0, 125 * spread);
}

/**
 * Parcel-Temperatur iterativ via θe-Erhaltung (feuchtadiabatisch)
 * Quelle: SHARPpy thermo.py wetlift()
 */
function liftParcelToLevel(thetaE, targetHPa, startTemp) {
    let T = startTemp;
    for (let iter = 0; iter < 30; iter++) {
        const T_K  = T + 273.15;
        const es   = 6.112 * Math.exp((17.67 * T) / (T + 243.5));
        const ws   = 0.622 * es / (Math.max(targetHPa - es, 1));
        const ws_g = ws * 1000;
        const theta_e_test = T_K
            * Math.pow(1000 / targetHPa, 0.2854 * (1 - 0.00028 * ws_g))
            * Math.exp((3.376 / T_K - 0.00254) * ws_g * (1 + 0.00081 * ws_g));
        const delta = (thetaE - theta_e_test) * 0.20;
        T += delta;
        if (Math.abs(delta) < 0.001) break;
    }
    return T;
}

/**
 * CAPE und CIN eines Parcels via schichtweiser Integration
 * Unterhalb LCL: trockenadiabatisch (DALR)
 * Oberhalb LCL:  feuchtadiabatisch via θe-Erhaltung (Bolton 1980)
 * Quelle: SHARPpy params.py parcelx()
 */
function calcParcelCAPE_CIN(hour, t_parcel, td_parcel, p_start = 1013.25) {
    const g    = 9.81;
    const DALR = 9.8; // K/km, trockenadiabatische Rate
    const lcl_m = calcLCLHeight(t_parcel, td_parcel);

    // θe des Parcels (Bolton 1980)
    const dewDep  = Math.max(0, t_parcel - td_parcel);
    const T_LCL_K = (t_parcel - 0.212 * dewDep - 0.001 * dewDep * dewDep) + 273.15;
    const T_K     = t_parcel + 273.15;
    const e_d     = 6.112 * Math.exp((17.67 * td_parcel) / (td_parcel + 243.5));
    const w_gkg   = 1000 * 0.622 * e_d / (Math.max(p_start - e_d, 1));
    const thetaE  = T_K
        * Math.pow(1000 / p_start, 0.2854 * (1 - 0.00028 * w_gkg))
        * Math.exp((3.376 / T_LCL_K - 0.00254) * w_gkg * (1 + 0.00081 * w_gkg));

    // Referenzniveaus mit approx. Standardhöhen
    const levels = [
        { p: 850, z: 1500, t_env: hour.temp850 ?? 0 },
        { p: 700, z: 3000, t_env: hour.temp700 ?? 0 },
        { p: 500, z: 5500, t_env: hour.temp500 ?? 0 },
    ];

    function parcelTempAt(p, z_m) {
        if (z_m <= lcl_m) {
            return t_parcel - DALR * (z_m / 1000);
        } else {
            const T_at_LCL = t_parcel - DALR * (lcl_m / 1000);
            const dz_moist = (z_m - lcl_m) / 1000;
            return liftParcelToLevel(thetaE, p, T_at_LCL - 6.0 * dz_moist);
        }
    }

    let cape = 0, cin = 0, lfc = null;
    let lfcFound = false;
    let prevZ = 0;
    let prevDT = 0; // Parcel-Umgebung-Differenz am Start ≈ 0

    for (let idx = 0; idx < levels.length; idx++) {
        const lev    = levels[idx];
        const t_p    = parcelTempAt(lev.p, lev.z);
        const dT     = t_p - lev.t_env;
        const prevEnv = idx === 0 ? t_parcel : levels[idx-1].t_env;
        const T_mean_K = ((lev.t_env + prevEnv) / 2) + 273.15;
        const dz       = lev.z - prevZ;
        const buoy     = (((prevDT + dT) / 2) / T_mean_K) * g * dz;

        if (!lfcFound) {
            if (dT > 0) {
                lfcFound = true;
                lfc = lev.z;
                // Nur positiven Anteil zu CAPE zählen
                const fracPos = prevDT < 0 ? dT / (dT - prevDT) : 1.0;
                cape += Math.max(0, buoy * fracPos);
                cin  += Math.min(0, buoy * (1 - fracPos));
            } else {
                cin += Math.min(0, buoy);
            }
        } else {
            cape += Math.max(0, buoy);
        }

        prevZ  = lev.z;
        prevDT = dT;
    }

    // Lifted Index bei 500 hPa
    const t_p500 = parcelTempAt(500, 5500);
    const li     = (hour.temp500 ?? 0) - t_p500;

    return {
        cape: Math.max(0, Math.round(cape)),
        cin:  Math.max(-500, Math.min(0, Math.round(cin))),
        lcl:  Math.round(lcl_m),
        lfc:  lfc ? Math.round(lfc) : null,
        li:   Math.round(li * 10) / 10,
    };
}

/**
 * ML-Parcel Startbedingungen
 * Gewichteter Mittelwert unterste ~100 hPa: SFC 60% + 850 hPa 40%
 * Quelle: SHARPpy DefineParcel flag=4 (mean_theta + mean_mixratio)
 */
function calcMLParcel(hour) {
    const t_sfc  = hour.temperature ?? 15;
    const td_sfc = hour.dew        ?? (t_sfc - 10);
    const t_850  = hour.temp850    ?? (t_sfc - 5);
    const td_850 = hour.dew850     ?? (td_sfc - 3);
    return {
        temp: 0.60 * t_sfc  + 0.40 * t_850,
        dew:  0.60 * td_sfc + 0.40 * td_850,
    };
}

/**
 * MU-Parcel: Level mit maximalem θe aus SFC / 850 / 700 hPa
 * Quelle: SHARPpy DefineParcel flag=3 + most_unstable_level()
 */
function calcMUParcel(hour) {
    const candidates = [
        { temp: hour.temperature ?? 15, dew: hour.dew   ?? 5,   p: 1013.25, label: 'SFC'   },
        { temp: hour.temp850    ?? 10,  dew: hour.dew850 ?? 2,   p: 850,     label: '850hPa'},
        { temp: hour.temp700    ?? 5,   dew: hour.dew700 ?? -5,  p: 700,     label: '700hPa'},
    ];
    let best = candidates[0], bestTE = -Infinity;
    for (const c of candidates) {
        const te = calcThetaE_Bolton(c.temp, c.dew, c.p);
        if (te > bestTE) { bestTE = te; best = c; }
    }
    return { temp: best.temp, dew: best.dew, p: best.p, pres_label: best.label };
}

/**
 * Alle drei Parcel-Typen berechnen
 */
function calcAllParcels(hour) {
    // Surface-Based
    const sb_r = calcParcelCAPE_CIN(hour, hour.temperature ?? 15, hour.dew ?? 5, 1013.25);
    const sb   = { ...sb_r, temp: hour.temperature ?? 15, dew: hour.dew ?? 5 };

    // Mixed-Layer
    const ml_s = calcMLParcel(hour);
    const ml_r = calcParcelCAPE_CIN(hour, ml_s.temp, ml_s.dew, 1013.25);
    const ml   = { ...ml_r, temp: ml_s.temp, dew: ml_s.dew };

    // Most-Unstable
    const mu_s = calcMUParcel(hour);
    const mu_r = calcParcelCAPE_CIN(hour, mu_s.temp, mu_s.dew, mu_s.p);
    const mu   = { ...mu_r, temp: mu_s.temp, dew: mu_s.dew, pres_label: mu_s.pres_label };

    return { sb, ml, mu };
}

/**
 * SHIP – Significant Hail Parameter
 * Quelle: SHARPpy params.py ship(), Ryan Jewell (SPC), Johnson & Sugden 2014
 * Nutzt MUCAPE + MU-Mischungsverhältnis
 */
function calcSHIP(hour) {
    const mucape = hour.mucape ?? 0;
    if (mucape < 100) return 0;

    const mu_dew = hour.mu ? hour.mu.dew : (hour.dew ?? 5);
    const p_mu   = hour.mu?.pres_label === '850hPa' ? 850
                 : hour.mu?.pres_label === '700hPa' ? 700 : 1013.25;
    const e_mu   = 6.112 * Math.exp((17.67 * mu_dew) / (mu_dew + 243.5));
    let mumr     = 1000 * 0.622 * e_mu / (Math.max(p_mu - e_mu, 1));
    mumr = Math.max(11.0, Math.min(13.6, mumr));

    const h5_temp = Math.min(-5.5, hour.temp500 ?? -10);
    const lr75    = calcMidLevelLapseRate(hour.temp700 ?? 0, hour.temp500 ?? -20);
    const frz_lvl = hour.freezingLevel ?? 3000;
    const shear   = calcShear(hour);
    const shr06   = Math.max(7, Math.min(27, shear));

    let ship = -1.0 * (mucape * mumr * lr75 * h5_temp * shr06) / 42000000.0;
    if (mucape  < 1300) ship *= (mucape / 1300);
    if (lr75    < 5.8)  ship *= (lr75 / 5.8);
    if (frz_lvl < 2400) ship *= (frz_lvl / 2400);

    return Math.max(0, ship);
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

function calcPBLHeight(hour) {
    const t2m  = hour.temperature ?? 0;
    const t850 = hour.temp850 ?? 0;
    const t700 = hour.temp700 ?? 0;
    const rad  = hour.directRadiation ?? 0;
    const z850 = 1500, z700 = 3000, DALR = 9.8;

    const Tp850 = t2m - DALR * (z850 / 1000);
    const Tp700 = t2m - DALR * (z700 / 1000);
    let pbl = 200;

    if (Tp850 >= t850) {
        if (Tp700 >= t700) {
            const lapse = (t850 - t700) / (z700 - z850) * 1000;
            pbl = lapse >= DALR ? 3500 : Math.min(4000, z700 + (Tp700 - t700) / (DALR - lapse) * 1000);
        } else {
            pbl = z850 + ((Tp850 - t850) / ((Tp850 - t850) - (Tp700 - t700))) * (z700 - z850);
        }
    } else {
        const lapse_low = (t2m - t850) / z850 * 1000;
        pbl = lapse_low <= 0 ? 200 : Math.max(200, Math.min((t2m - t850) / (DALR - lapse_low) * 1000, z850));
    }

    if      (rad > 600) pbl = Math.min(4000, pbl + 400);
    else if (rad > 300) pbl = Math.min(4000, pbl + 200);
    else if (rad < 20)  pbl = Math.max(100,  pbl - 300);

    return Math.round(Math.max(100, Math.min(4000, pbl)));
}

function calcEBWD(hour) {
    const levels = [
        { speed: (hour.wind_speed_1000hPa ?? 0) / 3.6, dir: hour.windDir1000 ?? 0 },
        { speed: (hour.wind_speed_975hPa  ?? 0) / 3.6, dir: hour.windDir975  ?? 0 },
        { speed: (hour.wind_speed_950hPa  ?? 0) / 3.6, dir: hour.windDir950  ?? 0 },
        { speed: (hour.wind_speed_925hPa  ?? 0) / 3.6, dir: hour.windDir925  ?? 0 },
        { speed: (hour.wind_speed_900hPa  ?? 0) / 3.6, dir: hour.windDir900  ?? 0 },
        { speed: (hour.wind_speed_850hPa  ?? 0) / 3.6, dir: hour.windDir850  ?? 0 },
    ];
    const uv    = levels.map(l => windToUV(l.speed, l.dir));
    const meanU = uv.reduce((s, w) => s + w.u, 0) / uv.length;
    const meanV = uv.reduce((s, w) => s + w.v, 0) / uv.length;
    return Math.round(Math.hypot(uv[uv.length-1].u - meanU, uv[uv.length-1].v - meanV) * 10) / 10;
}

function calcSRH(hour, layer = '0-3km') {
    const levels = layer === '0-1km'
        ? [
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_975hPa  ?? 0) / 3.6, wd: hour.windDir975  ?? 0 },
            { ws: (hour.wind_speed_950hPa  ?? 0) / 3.6, wd: hour.windDir950  ?? 0 },
            { ws: (hour.wind_speed_925hPa  ?? 0) / 3.6, wd: hour.windDir925  ?? 0 },
            { ws: (hour.wind_speed_900hPa  ?? 0) / 3.6, wd: hour.windDir900  ?? 0 },
          ]
        : [
            { ws: (hour.wind_speed_1000hPa ?? 0) / 3.6, wd: hour.windDir1000 ?? 0 },
            { ws: (hour.wind_speed_925hPa  ?? 0) / 3.6, wd: hour.windDir925  ?? 0 },
            { ws: (hour.wind_speed_850hPa  ?? 0) / 3.6, wd: hour.windDir850  ?? 0 },
            { ws: (hour.wind_speed_700hPa  ?? 0) / 3.6, wd: hour.windDir700  ?? 0 },
          ];

    const winds  = levels.map(l => windToUV(l.ws, l.wd));
    const meanU  = winds.reduce((s, w) => s + w.u, 0) / winds.length;
    const meanV  = winds.reduce((s, w) => s + w.v, 0) / winds.length;
    const shearU = winds[winds.length-1].u - winds[0].u;
    const shearV = winds[winds.length-1].v - winds[0].v;
    const sMag   = Math.hypot(shearU, shearV) || 1;
    const devMag = 7.5;
    const stormU = meanU + devMag * (shearV / sMag);
    const stormV = meanV - devMag * (shearU / sMag);

    let srh = 0;
    for (let i = 0; i < winds.length - 1; i++) {
        const u1 = winds[i].u   - stormU, v1 = winds[i].v   - stormV;
        const u2 = winds[i+1].u - stormU, v2 = winds[i+1].v - stormV;
        srh += u1 * v2 - u2 * v1;
    }
    return Math.round(Math.abs(srh) * 10) / 10;
}

function calcShear(hour) {
    const ws500  = (hour.wind_speed_500hPa  ?? 0) / 3.6;
    const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
    const w500   = windToUV(ws500,  hour.windDir500  ?? 0);
    const w1000  = windToUV(ws1000, hour.windDir1000 ?? 0);
    return Math.round(Math.hypot(w500.u - w1000.u, w500.v - w1000.v) * 1.08 * 10) / 10;
}

function calcIndices(hour) {
    const t500 = hour.temp500 ?? 0, t850 = hour.temp850 ?? 0;
    const t700 = hour.temp700 ?? 0, d850 = hour.dew850  ?? 0, d700 = hour.dew700 ?? 0;

    const dd850    = t850 - d850;
    const TLCL850  = (t850 - 0.212 * dd850 - 0.001 * dd850 * dd850) + 273.15;
    const e850     = 6.112 * Math.exp((17.67 * d850) / (d850 + 243.5));
    const w850_g   = 1000 * 0.622 * e850 / (Math.max(850 - e850, 1));
    const thetaE850 = (t850 + 273.15)
        * Math.pow(1000 / 850, 0.2854 * (1 - 0.00028 * w850_g))
        * Math.exp((3.376 / TLCL850 - 0.00254) * w850_g * (1 + 0.00081 * w850_g));
    const T_p500_SI = liftParcelToLevel(thetaE850, 500, t850 - 6.0 * (3000 - 125 * dd850) / 1000);

    return {
        kIndex:      t850 - t500 + d850 - (t700 - d700),
        showalter:   Math.round((t500 - T_p500_SI) * 10) / 10,
        lapse:       (t850 - t500) / 3.5,
        liftedIndex: hour.ml ? hour.ml.li : 0,
    };
}

// SCP: MUCAPE (Thompson 2004, SHARPpy scp())
function calcSCP(cape, shear, srh, cin) {
    if (cape < 100 || shear < 6 || srh < 40 || shear < 12.5) return 0;
    const magCin   = -Math.min(0, cin ?? 0);
    const cinTerm  = magCin < 40 ? 1.0 : Math.max(0.1, 1 - (magCin - 40) / 200);
    return Math.max(0, (cape / 1000) * Math.min(srh / 50, 4.0) * Math.min(shear / 12, 1.5) * cinTerm);
}

function calcDCAPE(hour) {
    const t700 = hour.temp700 ?? 0, d700 = hour.dew700 ?? 0;
    const t850 = hour.temp850 ?? 0;
    const dd700 = t700 - d700;
    if (dd700 > 35) return 0;
    const wb700 = t700 - 0.43 * dd700;
    const diff  = wb700 - t850;
    if (diff <= 0) return 0;
    const mf = dd700 <= 2 ? 0.2 : dd700 <= 5 ? 0.5 : dd700 <= 10 ? 0.9
             : dd700 <= 15 ? 1.0 : dd700 <= 20 ? 0.8 : dd700 <= 25 ? 0.5 : 0.3;
    return Math.round(Math.max(0, (diff / (((t700 + t850) / 2) + 273.15)) * 9.81 * 1500 * mf));
}

function calcWMAXSHEAR(cape, shear) {
    if (cape <= 0 || shear <= 0) return 0;
    return Math.round(Math.sqrt(2 * cape) * shear * 3.6);
}

function calcMidLevelLapseRate(t700, t500) { return (t700 - t500) / 2.5; }

function calcMoistureDepth(d850, d700, t850, t700) {
    return (calcRelHum(t850, d850) + calcRelHum(t700, d700)) / 2;
}

// ELI nutzt MLCAPE + MLCIN
function calcELI(mlcape, mlcin, pblHeight) {
    if (mlcape < 50) return 0;
    const pf = pblHeight > 1500 ? 1.2 : pblHeight > 1000 ? 1.0 : pblHeight > 500 ? 0.8 : 0.6;
    const magCin = -Math.min(0, mlcin ?? 0);
    const cf = magCin < 25 ? 1.0 : magCin < 50 ? 0.9 : magCin < 100 ? 0.7 : magCin < 150 ? 0.5 : 0.3;
    return mlcape * pf * cf;
}

// STP: MLCAPE + MLLCL + MLCIN (Thompson et al. 2012)
function calcSTP(mlcape, srh1km, shear, li, mlcin, temp2m = null, dew2m = null, hour = null) {
    if (mlcape < 80 || srh1km < 40 || shear < 12.5) return 0;
    let lclTerm;
    if (temp2m !== null && dew2m !== null) {
        const lcl = calcLCLHeight(temp2m, dew2m);
        lclTerm = lcl < 1000 ? 1.0 : lcl >= 2000 ? 0.0 : (2000 - lcl) / 1000;
    } else {
        lclTerm = li <= -4 ? 1.0 : li <= -2 ? 0.8 : li <= 0 ? 0.5 : 0.2;
    }
    const ebwd      = hour ? calcEBWD(hour) : shear;
    let cinTerm     = mlcin >= -50 ? 1.0 : mlcin <= -200 ? 0.0 : (200 + mlcin) / 150;
    return Math.max(0,
        Math.min(mlcape / 1500, 3.0) *
        Math.min(srh1km / 150, 3.0) *
        Math.min(ebwd / 20, 2.0) *
        lclTerm * cinTerm
    );
}

function calcThetaE(tempC, dewC, pressHPa) {
    const T_K = tempC + 273.15;
    const e   = 6.112 * Math.exp((17.67 * dewC) / (dewC + 243.5));
    const q   = 0.622 * e / (Math.max(pressHPa - e, 1));
    return T_K * Math.pow(1000 / pressHPa, 0.285) * Math.exp((2.501e6 * q) / (1005 * T_K));
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
    const thunderProb = calculateProbability(hour);
    if (thunderProb < 5) return 0;

    // Hagel nutzt MUCAPE (größtes CAPE = größte Hagelgefahr, SHARPpy-Konvention)
    const cape  = Math.max(0, hour.mucape ?? hour.mlcape ?? 0);
    const shear = calcShear(hour);
    const srh   = calcSRH(hour, '0-3km');
    const lcl   = hour.mllcl ?? calcLCLHeight(hour.temperature ?? 0, hour.dew ?? 0);
    const FL    = hour.freezingLevel ?? 4000;

    let HPP_base = (cape / 1000) * (shear / 20) * (srh / 150);

    const f_LCL  = lcl > 1500 ? 0.9 : 1.0;
    const magCIN = -Math.min(0, hour.mucin ?? hour.mlcin ?? 0);
    const f_CIN  = magCIN > 50 ? 0.9 : 1.0;
    const f_FL   = FL < 2500 ? 1.0 : FL < 3500 ? 0.8 : FL < 4500 ? 0.6 : 0.4;

    // SHIP-Boost: SHARPpy-konform, MUCAPE-basiert
    const ship      = calcSHIP(hour);
    const shipBoost = ship >= 1.0 ? 1.3 : ship >= 0.5 ? 1.1 : 1.0;

    const hail2cmProb = HPP_base * f_LCL * f_CIN * f_FL * shipBoost * 100;
    return Math.min(100, Math.round(hail2cmProb * (thunderProb / 100)));
}

function calculateWindProbability(hour, wmaxshear, dcape) {
    const thunderProb = calculateProbability(hour);
    if (thunderProb < 5) return 0;

    // Wind: MLCAPE (operationeller Standard)
    const cape      = Math.max(0, hour.mlcape ?? hour.cape ?? 0);
    const shear     = calcShear(hour);
    const temp700   = hour.temp700 ?? 0;
    const dew700    = hour.dew700  ?? 0;
    const temp500   = hour.temp500 ?? 0;
    const pwat      = hour.pwat ?? 0;
    const lapseRate = calcMidLevelLapseRate(temp700, temp500);

    if (dcape < 250 && wmaxshear < 450) return 0;
    if (shear < 9 && cape < 450)        return 0;

    let score = 0;

    if      (dcape >= 1400) score += 34; else if (dcape >= 1200) score += 29;
    else if (dcape >= 1000) score += 25; else if (dcape >= 800)  score += 19;
    else if (dcape >= 600)  score += 13; else if (dcape >= 400)  score += 7;
    else if (dcape >= 300)  score += 4;

    if      (wmaxshear >= 1200) score += 31; else if (wmaxshear >= 1000) score += 27;
    else if (wmaxshear >= 850)  score += 21; else if (wmaxshear >= 700)  score += 15;
    else if (wmaxshear >= 550)  score += 10; else if (wmaxshear >= 450)  score += 6;
    else if (wmaxshear >= 350)  score += 3;

    if      (shear >= 24) score += 12; else if (shear >= 20) score += 9;
    else if (shear >= 17) score += 7;  else if (shear >= 14) score += 4;
    else if (shear >= 11) score += 2;  else if (shear >= 9)  score += 1;

    const w850L = windToUV((hour.wind_speed_850hPa  ?? 0) / 3.6, hour.windDir850  ?? 0);
    const w100L = windToUV((hour.wind_speed_1000hPa ?? 0) / 3.6, hour.windDir1000 ?? 0);
    const sLow  = Math.hypot(w850L.u - w100L.u, w850L.v - w100L.v);
    if      (sLow >= 15) score += 10; else if (sLow >= 12) score += 7;
    else if (sLow >= 9)  score += 4;  else if (sLow >= 6)  score += 2;

    if      (lapseRate >= 8.0 && dcape >= 500) score += 10;
    else if (lapseRate >= 7.0 && dcape >= 400) score += 6;
    else if (lapseRate >= 6.5 && dcape >= 300) score += 3;
    else if (lapseRate < 5.5)                  score -= 3;

    if      (cape >= 1500) score += 11; else if (cape >= 1200) score += 9;
    else if (cape >= 800)  score += 7;  else if (cape >= 450)  score += 4;
    else if (cape >= 250)  score += 2;

    const dd700 = temp700 - dew700;
    if      (dd700 >= 20 && dcape >= 600) score += 8;
    else if (dd700 >= 15 && dcape >= 500) score += 5;
    else if (dd700 >= 8  && dcape >= 350) score += 3;
    else if (dd700 < 5   && dcape < 800)  score -= 4;

    if      (temp500 <= -20 && dcape >= 600) score += 6;
    else if (temp500 <= -16 && dcape >= 500) score += 4;
    else if (temp500 <= -12 && dcape >= 400) score += 2;

    if      (hour.rh500 < 35 && dcape >= 600) score += 5;
    else if (hour.rh500 < 45 && dcape >= 500) score += 3;
    else if (hour.rh500 < 55 && dcape >= 400) score += 1;

    const rh850w  = hour.rh850 ?? calcRelHum(hour.temp850 ?? 0, hour.dew850 ?? 0);
    const rh700w  = hour.rh700 ?? calcRelHum(hour.temp700 ?? 0, hour.dew700 ?? 0);
    const mRH_w   = (rh850w + rh700w + (hour.rh500 ?? 50)) / 3;
    if      (mRH_w < 35 && dcape >= 600) score += 6;
    else if (mRH_w < 45 && dcape >= 500) score += 3;
    else if (mRH_w > 75 && dcape < 800)  score -= 4;

    if      (pwat < 15 && dcape >= 600) score += 5;
    else if (pwat < 20 && dcape >= 500) score += 3;
    else if (pwat > 35 && dcape < 800)  score -= 4;

    let factor = 1.0;
    if      (dcape >= 1000 && wmaxshear >= 1100) factor = 1.2;
    else if (dcape >= 800  && wmaxshear >= 900)  factor = 1.15;
    else if (dcape >= 550  && wmaxshear >= 650)  factor = 1.1;
    else if (dcape < 350   || wmaxshear < 550)   factor = 0.75;
    if      (shear >= 17 && cape >= 550) factor *= 1.1;
    else if (shear < 11  && cape < 350)  factor *= 0.8;

    score = Math.round(score * factor);
    if (dcape < 250 || wmaxshear < 400) score = Math.min(score, 10);
    else if (dcape < 350 || wmaxshear < 550) score = Math.min(score, 25);
    if (dcape >= 1200 && wmaxshear >= 1300 && shear >= 20) score = Math.min(100, score + 12);
    if (cape < 500 && shear >= 18 && wmaxshear >= 800 && dcape >= 600) score = Math.min(100, score + 8);

    return Math.min(100, Math.max(0, score));
}

function calculateProbability(hour) {
    const temp2m = hour.temperature ?? 0;
    const dew    = hour.dew ?? 0;

    // ── ML-Werte als Standard (ESSL/operationell) ─────────────────────
    const cape   = Math.max(0, hour.mlcape ?? hour.cape ?? 0);
    const cin    = hour.mlcin ?? hour.cin ?? 0;
    const magCin = -Math.min(0, cin);
    const li     = hour.ml ? hour.ml.li : 0;
    const lclH   = hour.mllcl ?? calcLCLHeight(temp2m, dew);

    const precipAcc  = hour.precipAcc ?? 0;
    const precipProb = hour.precip ?? 0;
    const pblHeight  = hour.pblHeight ?? 1000;
    const shear      = calcShear(hour);
    const rh850      = hour.rh850 ?? calcRelHum(hour.temp850 ?? 0, hour.dew850 ?? 0);
    const rh700      = hour.rh700 ?? calcRelHum(hour.temp700 ?? 0, hour.dew700 ?? 0);
    const meanRH     = (rh850 + rh700 + (hour.rh500 ?? 50)) / 3;

    const e925     = 6.112 * Math.exp((17.67 * dew) / (dew + 243.5));
    const q925_gkg = 1000 * 0.622 * e925 / (1013.25 - e925);

    if (temp2m < 3 && cape < 300)                return 0;
    if (temp2m < 8 && cape < 180 && shear < 15)  return 0;

    // AR-CHaMo Logit (Rädler 2018)
    let logit = -4.2;
    logit += -li * 0.60;
    logit += (meanRH - 55) / 25 * 1.80;
    logit += (cape > 0 ? Math.log1p(cape / 150) * 1.2 : 0);
    logit += (q925_gkg - 5) / 4 * 0.90;
    if (magCin > 50)  logit -= (magCin - 50) / 100 * 1.2;
    if (magCin > 150) logit -= 1.0;
    if (temp2m < 8)   logit -= 1.0;
    else if (temp2m < 12) logit -= 0.4;

    const isHSLC = cape < 300 && shear >= 18;
    if (isHSLC && meanRH >= 55) logit += (shear - 18) / 12 * 1.0;
    const pBase = 1 / (1 + Math.exp(-logit));

    const hardCap = (li > 3 && meanRH < 50) ? 10
                  : (li > 2 && meanRH < 55) ? 20
                  : (li > 1 && cape === 0)  ? 25 : 100;

    const srh1km    = calcSRH(hour, '0-1km');
    const srh       = calcSRH(hour, '0-3km');
    const { kIndex, liftedIndex } = calcIndices(hour);
    const relHum2m  = calcRelHum(temp2m, dew);
    const midLapse  = calcMidLevelLapseRate(hour.temp700 ?? 0, hour.temp500 ?? 0);
    const moistDepth = calcMoistureDepth(hour.dew850 ?? 0, hour.dew700 ?? 0, hour.temp850 ?? 0, hour.temp700 ?? 0);

    // SCP mit MUCAPE, STP + EHI mit MLCAPE (SHARPpy-Standard)
    const eli       = calcELI(cape, cin, pblHeight);
    const ehi       = (cape * srh1km) / 160000;
    const scp       = calcSCP(hour.mucape ?? cape, shear, srh, hour.mucin ?? cin);
    const stp       = calcSTP(cape, srh1km, shear, li, cin, hour.ml?.temp ?? temp2m, hour.ml?.dew ?? dew, hour);
    const wmaxshear = calcWMAXSHEAR(cape, shear);
    const dcape     = calcDCAPE(hour);
    const thetaE850 = calcThetaE(hour.temp850 ?? 0, hour.dew850 ?? 0, 850);

    if (isHSLC) {
        let hs = shear >= 25 ? 30 : shear >= 20 ? 20 : 10;
        if (meanRH >= 65) hs += 15; else if (meanRH < 50) hs -= 15;
        if (temp2m < 8) hs = Math.round(hs * 0.6);
        if      (li > 5) hs = Math.round(hs * 0.3);
        else if (li > 4) hs = Math.round(hs * 0.5);
        else if (li > 3) hs = Math.round(hs * 0.7);
        else if (li > 2) hs = Math.round(hs * 0.85);
        return Math.min(40, Math.max(0, hs));
    }

    let score = 0;

    if      (cape >= 2000) score += 16; else if (cape >= 1500) score += 14;
    else if (cape >= 1200) score += 12; else if (cape >= 800)  score += 10;
    else if (cape >= 500)  score += 8;  else if (cape >= 300)  score += 6;
    else if (cape >= 150)  score += 3;

    const elT = hour.temp500 ?? 0;
    if      (elT <= -20 && cape >= 200) score += 8;
    else if (elT <= -15 && cape >= 150) score += 5;
    else if (elT <= -10 && cape >= 100) score += 3;
    else if (elT > -5   && cape < 500)  score -= 5;

    if      (eli >= 2000) score += 10; else if (eli >= 1200) score += 7;
    else if (eli >= 800)  score += 5;  else if (eli >= 400)  score += 3;

    if      (magCin < 25 && cape >= 300) score += 6;
    else if (magCin < 50 && cape >= 200) score += 3;
    else if (magCin > 200) score -= 18; else if (magCin > 100) score -= 10;
    else if (magCin > 50)  score -= 5;

    if      (scp >= 3.0) score += 24; else if (scp >= 2.0) score += 20;
    else if (scp >= 1.5) score += 16; else if (scp >= 1.0) score += 12;

    if      (stp >= 2.0) score += 18; else if (stp >= 1.5) score += 15;
    else if (stp >= 1.0) score += 12; else if (stp >= 0.5) score += 8;
    else if (stp >= 0.3) score += 4;

    if      (ehi >= 2.5) score += 14; else if (ehi >= 2.0) score += 12;
    else if (ehi >= 1.0) score += 9;  else if (ehi >= 0.5) score += 5;

    if      (wmaxshear >= 1500) score += 22; else if (wmaxshear >= 1200) score += 18;
    else if (wmaxshear >= 900)  score += 14; else if (wmaxshear >= 700)  score += 10;
    else if (wmaxshear >= 500)  score += 6;  else if (wmaxshear >= 400)  score += 3;
    else if (wmaxshear >= 300)  score += 1;

    if      (shear >= 25) score += 14; else if (shear >= 20) score += 11;
    else if (shear >= 15) score += 8;  else if (shear >= 12) score += 5;
    else if (shear >= 10) score += 3;  else if (shear >= 8)  score += 1;

    if      (srh >= 250) score += 10; else if (srh >= 200) score += 8;
    else if (srh >= 150) score += 6;  else if (srh >= 120) score += 4;
    else if (srh >= 80)  score += 2;

    if      (lclH < 500)   score += 8; else if (lclH < 800)   score += 6;
    else if (lclH < 1200)  score += 4; else if (lclH < 1500)  score += 2;
    else if (lclH >= 2500) score -= 6;

    if      (midLapse >= 8.0) score += 8; else if (midLapse >= 7.5) score += 6;
    else if (midLapse >= 7.0) score += 4; else if (midLapse >= 6.5) score += 2;
    else if (midLapse < 5.5 && cape < 800) score -= 5;

    if      (moistDepth >= 75) score += 6; else if (moistDepth >= 65) score += 4;
    else if (moistDepth >= 55) score += 2; else if (moistDepth < 40 && cape < 600) score -= 4;

    if      (meanRH >= 75) score += 8; else if (meanRH >= 65) score += 5;
    else if (meanRH >= 55) score += 2; else if (meanRH < 50)  score -= 12;
    else if (meanRH < 40)  score -= 20;

    if      (thetaE850 >= 345) score += 8; else if (thetaE850 >= 335) score += 5;
    else if (thetaE850 >= 325) score += 2; else if (thetaE850 < 315)  score -= 4;

    if      (liftedIndex <= -7) score += 12; else if (liftedIndex <= -6) score += 10;
    else if (liftedIndex <= -4) score += 7;  else if (liftedIndex <= -2) score += 4;
    else if (liftedIndex <= 0)  score += 1;

    if      (kIndex >= 38) score += 8; else if (kIndex >= 35) score += 6;
    else if (kIndex >= 30) score += 4; else if (kIndex >= 25) score += 2;

    const e850d  = 6.112 * Math.exp((17.67 * (hour.dew850 ?? 0)) / ((hour.dew850 ?? 0) + 243.5));
    const mxR850 = 1000 * 0.622 * e850d / (850 - e850d);
    if      (mxR850 >= 13) score += 8; else if (mxR850 >= 10) score += 5;
    else if (mxR850 >= 6)  score += 2; else if (mxR850 < 4)   score -= 6;

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

    const isNight = hour.directRadiation < 20;
    const isDaytime = hour.directRadiation >= 200;
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

    const gd = hour.gust - hour.wind;
    if      (gd > 15 && cape >= 600 && temp2m >= 12) score += 6;
    else if (gd > 12 && cape >= 500)                 score += 4;
    else if (gd > 8  && cape >= 300)                 score += 2;

    if      (dcape >= 1000 && cape >= 400) score += 7;
    else if (dcape >= 800  && cape >= 300) score += 5;
    else if (dcape >= 600  && cape >= 200) score += 3;
    else if (dcape >= 400  && cape >= 150) score += 1;

    if      (pblHeight >= 2000 && cape >= 300) score += 4;
    else if (pblHeight >= 1500 && cape >= 200) score += 2;
    else if (pblHeight < 300   && cape < 500)  score -= 3;

    if      (temp2m < 8)  score = Math.round(score * (shear < 15 && cape < 500 ? 0.4 : 0.6));
    else if (temp2m < 12) score = Math.round(score * 0.7);
    else if (temp2m < 15) score = Math.round(score * 0.85);

    if (score > 0 && cape < 100 && shear < 8)     score = Math.max(0, score - 10);
    if (score > 0 && magCin > 150 && cape < 1000) score = Math.max(0, score - 12);
    if (shear >= 20 && cape >= 150 && score < 30) score = Math.min(score + 5, 35);

    score = Math.round(score * Math.min(1.0, pBase * 4.0));

    return Math.min(hardCap, Math.min(100, Math.max(0, score)));
}

function stpToPercentEurope(stp) {
    if (stp < 0.1) return 0;  if (stp < 0.5) return 5;
    if (stp < 1.0) return 10; if (stp < 1.5) return 20;
    if (stp < 2.0) return 30; if (stp < 2.5) return 40;
    if (stp < 3.0) return 50; if (stp < 4.0) return 65;
    if (stp < 5.0) return 80; return 95;
}

// Tornado: STP mit MLCAPE + MLLCL + MLCIN (Thompson 2012, Europa-kalibriert)
function calculateTornadoProbability(hour, shear, srh) {
    const thunderProb = calculateProbability(hour);
    if (thunderProb < 40) return 0;

    const mlcape = Math.max(0, hour.mlcape ?? hour.cape ?? 0);
    const srh1   = calcSRH(hour, '0-1km');
    const mlcin  = hour.mlcin ?? hour.cin ?? 0;
    const ml_temp = hour.ml?.temp ?? (hour.temperature ?? 20);
    const ml_dew  = hour.ml?.dew  ?? (hour.dew ?? 10);
    const lcl     = hour.mllcl ?? calcLCLHeight(ml_temp, ml_dew);
    const ebwd    = calcEBWD(hour);

    const cinFactor = Math.max(0, (200 + mlcin) / 150);
    const lclFactor = Math.max(0, (2000 - lcl) / 1000);
    const stp = Math.max(0, (mlcape / 1500) * lclFactor * (srh1 / 150) * (ebwd / 20) * cinFactor);

    return stpToPercentEurope(stp);
}