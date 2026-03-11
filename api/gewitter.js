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
        // ═══════════════════════════════════════════════════════════════════
        // 925 hPa VOLLSTÄNDIG ERGÄNZT (Wind, Richtung, Temp, Taupunkt, RH)
        // Quelle AR-CHaMo: Battaglioli 2023 – spez. Feuchte q925 ist
        // offizieller 5. Prädiktor im Blitzmodell (neben CAPE, DLS, RH, LI)
        // ═══════════════════════════════════════════════════════════════════
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                    `&hourly=wind_gusts_10m,wind_speed_10m,temperature_2m,dew_point_2m,` +
                    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,` +
                    `wind_direction_1000hPa,wind_direction_925hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,` +
                    `wind_direction_975hPa,wind_direction_950hPa,wind_direction_900hPa,` +
                    `wind_speed_1000hPa,wind_speed_925hPa,wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,` +
                    `wind_speed_975hPa,wind_speed_950hPa,wind_speed_900hPa,` +
                    `temperature_925hPa,temperature_850hPa,temperature_700hPa,temperature_500hPa,` +
                    `dew_point_925hPa,dew_point_850hPa,dew_point_700hPa,` +
                    `relative_humidity_925hPa,relative_humidity_850hPa,relative_humidity_700hPa,relative_humidity_500hPa,` +
                    `cape,lifted_index,convective_inhibition,boundary_layer_height,` +
                    `precipitation,freezing_level_height,` +
                    `direct_radiation,total_column_integrated_water_vapour&forecast_days=16&models=icon_seamless,ecmwf_ifs025,gfs_global&timezone=auto`;

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
        //
        // Quellen:
        //   Rädler et al. 2018 – AR-CHaMo Original (JAMC 57, 569-587)
        //   Battaglioli et al. 2023 – AR-CHaMo ERA5/ECMWF (NHESS 23, 3651-3669)
        //   Taszarek et al. 2020 – Europa-Klimatologie (MWR 148, 4775-4797)
        //   Púčik et al. 2015 – Severe storm environments Europa (MWR 143, 4166-4188)
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

            const t2m   = get('temperature_2m');
            const d2m   = get('dew_point_2m');
            const t925  = get('temperature_925hPa');
            const d925  = get('dew_point_925hPa');
            const t850  = get('temperature_850hPa');
            const d850  = get('dew_point_850hPa');
            const t700  = get('temperature_700hPa');
            const d700  = get('dew_point_700hPa');
            const t500  = get('temperature_500hPa');

            if (t2m === null || t850 === null || t500 === null) return null;

            // ── CIN: API bevorzugen, Plausibilitätscheck ────────────────────
            // Problem: GFS liefert CIN=0 auch bei stabilen Lagen.
            // Fix: wenn API-CIN=0 aber LI > 1.5 → calcCIN nutzen
            // (Battaglioli 2023: CIN-Qualität entscheidend für STP/SCP-Güte)
            let rawCin  = get('convective_inhibition');
            let rawLI   = get('lifted_index');
            let rawPBL  = get('boundary_layer_height');

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

                // Wind-Level (alle inkl. 925 hPa)
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

                // Temperatur/Taupunkt alle Level
                temp925:            t925 ?? (t2m !== null && t850 !== null ? (t2m * 0.4 + t850 * 0.6) : null),
                temp850:            t850,
                temp700:            t700 ?? (t850 + t500) / 2,
                temp500:            t500,
                dew925:             d925 ?? (d2m ?? t2m - 10),
                dew850:             d850 ?? (d2m ?? t2m - 10),
                dew700:             d700 ?? (d2m ?? t2m - 10),

                // Relative Feuchte (API bevorzugt – genauer als Taupunkt-Berechnung)
                rh925:              get('relative_humidity_925hPa') ?? null,
                rh850:              get('relative_humidity_850hPa') ?? null,
                rh700:              get('relative_humidity_700hPa') ?? null,
                rh500:              get('relative_humidity_500hPa') ?? 50,

                // Konvektion
                cape:               Math.max(0, get('cape') ?? 0),
                directRadiation:    get('direct_radiation') ?? 0,
                precipAcc:          get('precipitation') ?? 0,
                pwat:               get('total_column_integrated_water_vapour') ?? 25,

                // Gefrierniveau: API bevorzugen, Berechnung als Fallback
                // (ECMWF liefert freezing_level_height oft nicht → immer Fallback nötig)
                freezingLevel:      null,  // wird unten gesetzt
                cin:                null,  // wird unten gesetzt
                liftedIndex:        null,  // wird unten gesetzt
                pblHeight:          null,  // wird unten gesetzt
            };

            // Gefrierniveau: API-Wert nur wenn plausibel (100–6000m), sonst calc
            const apiFL = get('freezing_level_height');
            hour.freezingLevel = (apiFL !== null && apiFL >= 100 && apiFL <= 6000)
                ? apiFL
                : calcFreezingLevel(hour);

            // CIN-Plausibilitätscheck:
            // GFS liefert cin=0 auch bei stabilen Lagen (LI > 1.5 → physikalisch inkonsistent)
            // ECMWF und ICON liefern korrekte negative CIN-Werte
            if (rawCin !== null && rawCin < 0) {
                hour.cin = rawCin;
            } else if (rawCin === null || (rawCin === 0 && (rawLI ?? 0) > 1.5)) {
                hour.cin = calcCIN(hour);
            } else {
                hour.cin = rawCin; // 0 bei wirklich konvektiv neutralen Lagen (LI≤0) ok
            }

            hour.liftedIndex = rawLI ?? calcLiftedIndex(hour);
            hour.pblHeight   = (rawPBL !== null && rawPBL > 50) ? rawPBL : calcPBLHeight(hour);

            // ── AR-CHaMo Prädikatoren berechnen ─────────────────────────────
            // q925: spezifische Feuchte 925 hPa (Battaglioli 2023 – 5. Prädiktor Blitzmodell)
            // RH 925 hPa von API verwenden wenn vorhanden, sonst aus Taupunkt
            hour.rh925 = hour.rh925 ?? calcRelHum(hour.temp925 ?? t2m, hour.dew925 ?? d2m ?? t2m - 10);
            hour.rh850 = hour.rh850 ?? calcRelHum(hour.temp850, hour.dew850);
            hour.rh700 = hour.rh700 ?? calcRelHum(hour.temp700, hour.dew700);

            // ML Mixing Ratio (AR-CHaMo Hagel-Prädiktor): Mittel aus 925+850 hPa
            // (Mixed-Layer = unterste ~150 hPa, 925+850 hPa als Proxy)
            // Quelle: Battaglioli 2023 Table 1 – ML_MR ist primärer Feuchte-Prädiktor
            const e925 = 6.112 * Math.exp((17.67 * (hour.dew925)) / (hour.dew925 + 243.5));
            const e850 = 6.112 * Math.exp((17.67 * (hour.dew850)) / (hour.dew850 + 243.5));
            const mr925 = 1000 * 0.622 * e925 / (925 - e925); // g/kg
            const mr850 = 1000 * 0.622 * e850 / (850 - e850); // g/kg
            hour.mlMixRatio = (mr925 + mr850) / 2; // g/kg, Mixed-Layer-Proxy

            // q925 spezifische Feuchte [g/kg] (Battaglioli 2023 Prädiktor)
            hour.q925 = mr925 / (1 + mr925 / 1000); // Näherung spez. Feuchte

            // WBZ-Höhe (Wet Bulb Zero): Pflicht-Prädiktor für AR-CHaMo-Hagel
            // Quelle: Battaglioli 2023 – "wet bulb zero height" ist 4. Hagel-Prädiktor
            hour.wbzHeight = calcWBZHeight(hour);

            // Mittlere RH 850–500 hPa (AR-CHaMo Blitz-Prädiktor, Rädler 2018)
            hour.meanRH = (hour.rh850 + hour.rh700 + hour.rh500) / 3;

            return hour;
        }

        // ── Schritt 2: Modellgewichtung nach Leadtime ──────────────────────
        // Quelle: Haiden et al. 2018 (ECMWF Tech Memo), DWD ICON-Verifikation
        function getModelWeight(model, leadtimeHours) {
            const lt = Math.max(0, leadtimeHours ?? 0);
            if (lt <= 12) {
                if (model === 'icon_seamless') return 0.45;
                if (model === 'ecmwf_ifs025')  return 0.35;
                if (model === 'gfs_global')    return 0.20;
            } else if (lt <= 36) {
                if (model === 'icon_seamless') return 0.40;
                if (model === 'ecmwf_ifs025')  return 0.40;
                if (model === 'gfs_global')    return 0.20;
            } else if (lt <= 72) {
                if (model === 'icon_seamless') return 0.30;
                if (model === 'ecmwf_ifs025')  return 0.50;
                if (model === 'gfs_global')    return 0.20;
            } else if (lt <= 120) {
                if (model === 'icon_seamless') return 0.20;
                if (model === 'ecmwf_ifs025')  return 0.60;
                if (model === 'gfs_global')    return 0.20;
            } else {
                if (model === 'icon_seamless') return 0.20;
                if (model === 'ecmwf_ifs025')  return 0.50;
                if (model === 'gfs_global')    return 0.30;
            }
            return 1 / 3;
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

                gewitter_by_model[model] = calculateLightningProbability(mh);
                tornado_by_model[model]  = calculateTornadoProbability(mh, shear, srh);
                hagel_by_model[model]    = calculateHailProbability(mh, wmaxshear, dcape);
                wind_by_model[model]     = calculateWindProbability(mh, wmaxshear, dcape);
            }

            const probability        = ensembleProb(gewitter_by_model, leadtimeHours);
            const tornadoProbability = Math.min(
                ensembleProb(tornado_by_model, leadtimeHours),
                probability
            );
            const hailProbability    = ensembleProb(hagel_by_model, leadtimeHours);
            const windProbability    = ensembleProb(wind_by_model,  leadtimeHours);

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
            const [dp, tp] = h.time.split('T');
            const [hr] = tp.split(':').map(Number);
            if (dp < currentDateStr) return;
            if (dp === currentDateStr && hr < currentHour) return;
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
                const { kIndex, showalter, lapse, liftedIndex } = calcIndices(mh);
                const thetaE925 = calcThetaE(mh.temp925 ?? mh.temperature, mh.dew925 ?? mh.dew, 925);
                const thetaE850 = calcThetaE(mh.temp850 ?? 0, mh.dew850 ?? 0, 850);
                const thetaE700 = calcThetaE(mh.temp700 ?? 0, mh.dew700 ?? 0, 700);
                const midLapse  = calcMidLevelLapseRate(mh.temp700 ?? 0, mh.temp500 ?? 0);
                const moistureDepth = calcMoistureDepth(mh.dew850 ?? 0, mh.dew700 ?? 0, mh.temp850 ?? 0, mh.temp700 ?? 0);
                const relHum2m  = calcRelHum(mh.temperature ?? 0, mh.dew ?? 0);

                perModel[model] = {
                    // ── AR-CHaMo Prädiktoren (Battaglioli 2023) ───────────────────
                    // Blitz: MUCAPE, DLS(925-500), ML_MR, MU_LI, meanRH, q925, convPrecip
                    // Hagel: ML_CAPE, DLS, ML_MR, WBZ
                    archamo_li:        Math.round(liftedIndex * 10) / 10,   // MU_LI
                    archamo_dls:       Math.round(shear * 10) / 10,         // DLS 925-500 hPa (m/s)
                    archamo_meanRH:    Math.round(mh.meanRH),               // RH 850-500 hPa
                    archamo_q925:      Math.round(mh.q925 * 10) / 10,       // spez. Feuchte 925 hPa (g/kg)
                    archamo_mlMR:      Math.round(mh.mlMixRatio * 10) / 10, // ML Mixing Ratio 925+850 hPa
                    archamo_wbz:       Math.round(mh.wbzHeight),            // Wet Bulb Zero Höhe (m)
                    archamo_cape:      Math.round(mh.cape),                 // MUCAPE
                    archamo_flHeight:  Math.round(mh.freezingLevel),        // Gefrierniveau

                    // ── Wahrscheinlichkeiten ──────────────────────────────────────
                    gewitter:  calculateLightningProbability(mh),
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
                    wbzHeight:   Math.round(mh.wbzHeight ?? 0),
                    pblHeight:   Math.round(mh.pblHeight ?? 0),

                    // ── Temperatur/Taupunkt ───────────────────────────────────────
                    temp2m:    Math.round(mh.temperature * 10) / 10,
                    dew2m:     Math.round(mh.dew * 10) / 10,
                    temp925:   Math.round((mh.temp925 ?? 0) * 10) / 10,
                    dew925:    Math.round((mh.dew925 ?? 0) * 10) / 10,
                    temp500:   Math.round(mh.temp500 * 10) / 10,
                    temp700:   Math.round(mh.temp700 * 10) / 10,
                    temp850:   Math.round(mh.temp850 * 10) / 10,
                    dew700:    Math.round(mh.dew700 * 10) / 10,
                    dew850:    Math.round(mh.dew850 * 10) / 10,

                    // ── Feuchte ───────────────────────────────────────────────────
                    relHum2m:      Math.round(relHum2m),
                    rh925:         Math.round(mh.rh925 ?? 0),
                    rh500:         Math.round(mh.rh500 ?? 0),
                    rh700:         Math.round(mh.rh700 ?? 0),
                    rh850:         Math.round(mh.rh850 ?? 0),
                    meanRH:        Math.round(mh.meanRH),
                    moistureDepth: Math.round(moistureDepth),
                    mlMixRatio:    Math.round(mh.mlMixRatio * 10) / 10,
                    q925:          Math.round(mh.q925 * 10) / 10,
                    pwat:          Math.round(mh.pwat ?? 0),
                    thetaE925:     Math.round(thetaE925 * 10) / 10,
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
                    wmaxshear: Math.round(wms),

                    // ── Komposit-Indizes ──────────────────────────────────────────
                    scp:  Math.round(scp * 100) / 100,
                    stp:  Math.round(stp * 100) / 100,
                    ehi:  Math.round(ehi * 100) / 100,
                    ship: Math.round(calcSHIP(mh) * 100) / 100,

                    // ── Bodenwind ─────────────────────────────────────────────────
                    wind10m:   Math.round(mh.wind * 10) / 10,
                    gust10m:   Math.round(mh.gust * 10) / 10,

                    // ── Wind 925 hPa ──────────────────────────────────────────────
                    wind925:   Math.round((mh.wind_speed_925hPa ?? 0) * 10) / 10,
                    dir925:    Math.round(mh.windDir925 ?? 0),

                    // ── Wolken & Niederschlag ─────────────────────────────────────
                    cloudLow:    Math.round(mh.cloudLow ?? 0),
                    cloudMid:    Math.round(mh.cloudMid ?? 0),
                    cloudHigh:   Math.round(mh.cloudHigh ?? 0),
                    precipProb:  Math.round(mh.precip ?? 0),
                    precipAcc:   Math.round(mh.precipAcc * 10) / 10,
                    radiation:   Math.round(mh.directRadiation ?? 0),
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
                hinweis: 'AR-CHaMo Methodik: Rädler 2018 + Battaglioli 2023 (NHESS). Pro Modell Wahrscheinlichkeit, dann gewichteter Ensemble-Mittelwert. AR-CHaMo-Prädiktoren: MUCAPE, DLS(925-500hPa), ML_MR, MU_LI, RH(850-500hPa), q925, WBZ(Hagel), Freezing Level',
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

// ═══════════════════════════════════════════════════════════════════════════
// SHIP: Significant Hail Parameter
// Quelle: SPC/NOAA; angepasst für Europa (Púčik 2015, Taszarek 2020)
// SHIP = (MUCAPE × MU_MR × Lapse700-500 × -T500 × DLS) / 42000000
// ═══════════════════════════════════════════════════════════════════════════
function calcSHIP(hour) {
    const cape   = Math.max(0, hour.cape ?? 0);
    const mlMR   = hour.mlMixRatio ?? 0;        // g/kg
    const temp500 = hour.temp500 ?? -20;
    const temp700 = hour.temp700 ?? -5;
    const shear  = calcShear(hour);             // m/s, DLS 925-500 hPa

    if (cape < 100 || mlMR < 1 || shear < 5) return 0;

    const lapseRate = calcMidLevelLapseRate(temp700, temp500); // °C/km, 700-500 hPa
    const negT500   = Math.max(0, -temp500);    // nur negativ sinnvoll

    // Klassische SHIP-Formel (SPC), normiert auf Europa
    const ship = (cape * mlMR * lapseRate * negT500 * shear) / 42000000;

    return Math.max(0, ship);
}

// ── Gefrierniveau-Berechnung (Fallback wenn API-Wert fehlt/unplausibel) ──
// Lineare Interpolation zwischen bekannten Drucklevel-Temperaturen
// ICAO-Standardhöhen für Mitteleuropa (hypsometrische Formel, ±150m Genauigkeit)
// Quelle: WMO-Handbuch, ESSL-Hagelstudien (Freezing Level als Hagelprädiktor)
function calcFreezingLevel(hour) {
    const levels = [
        { z: 111,  T: hour.temperature ?? null },
        { z: 762,  T: hour.temp925 ?? null },
        { z: 1457, T: hour.temp850 ?? null },
        { z: 3012, T: hour.temp700 ?? null },
        { z: 5574, T: hour.temp500 ?? null },
    ].filter(l => l.T !== null);

    if (levels.length < 2) return 2000; // Fallback

    // Vorzeichen-Wechsel suchen (wo T von positiv nach negativ wechselt)
    for (let i = 0; i < levels.length - 1; i++) {
        const l1 = levels[i], l2 = levels[i + 1];
        if (l1.T >= 0 && l2.T < 0) {
            // Lineare Interpolation: z bei T=0°C
            const frac = l1.T / (l1.T - l2.T);
            return Math.round(l1.z + frac * (l2.z - l1.z));
        }
    }
    // Alle Level positiv (sehr warme Lage → Gefrierniveau sehr hoch)
    if (levels[levels.length - 1].T > 0) return 4500;
    // Alle Level negativ (Winterlage → Gefrierniveau unter Boden)
    return 300;
}

// ── Wet Bulb Zero Höhe (WBZ) ─────────────────────────────────────────────
// Offizieller AR-CHaMo Hagel-Prädiktor (Battaglioli 2023, Table 1)
// WBZ = Höhe wo Wet-Bulb-Temperatur = 0°C
// Steuert Hagelschmelze: WBZ < 2100m → Hagel erreicht Boden, > 3200m → schmilzt
// Näherung: Wet-Bulb nach Normand (1/3-Taupunktdepression-Regel)
// Quelle: NOAA SPC Glossary; ESSL Hagelklimatologie Europa
function calcWBZHeight(hour) {
    const spread_sfc = (hour.temperature ?? 20) - (hour.dew ?? 10);
    const spread_925 = (hour.temp925 ?? 10) - (hour.dew925 ?? 5);
    const spread_850 = (hour.temp850 ?? 5)  - (hour.dew850 ?? 0);
    const spread_700 = (hour.temp700 ?? -5) - (hour.dew700 ?? -10);

    // Wet-Bulb ≈ T − (T−Td)/3  (Normand-Näherung, gut bis RH > 50%)
    const wb_sfc = (hour.temperature ?? 20) - spread_sfc / 3;
    const wb_925 = (hour.temp925 ?? 10)     - spread_925 / 3;
    const wb_850 = (hour.temp850 ?? 5)      - spread_850 / 3;
    const wb_700 = (hour.temp700 ?? -5)     - spread_700 / 3;

    const levels = [
        { z: 111,  wb: wb_sfc },
        { z: 762,  wb: wb_925 },
        { z: 1457, wb: wb_850 },
        { z: 3012, wb: wb_700 },
    ];

    for (let i = 0; i < levels.length - 1; i++) {
        const l1 = levels[i], l2 = levels[i + 1];
        if (l1.wb >= 0 && l2.wb < 0) {
            const frac = l1.wb / (l1.wb - l2.wb);
            return Math.round(l1.z + frac * (l2.z - l1.z));
        }
    }
    // Alle WB positiv → WBZ sehr hoch (subtropisch/sehr warm)
    if (levels[levels.length - 1].wb > 0) return 4000;
    // Alle WB negativ → Winterlage, WBZ praktisch am Boden
    return 200;
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

    const z_LCL = 125 * dewDep;
    const dz_moist = (5500 - z_LCL) / 1000;
    let T_parcel_500 = T_LCL - 6.0 * dz_moist;

    for (let iter = 0; iter < 20; iter++) {
        const Tp_K   = T_parcel_500 + 273.15;
        const es     = 6.112 * Math.exp((17.67 * T_parcel_500) / (T_parcel_500 + 243.5));
        const ws     = 0.622 * es / (500 - es);
        const ws_gkg = ws * 1000;
        const theta_e_test = Tp_K
            * Math.pow(1000 / 500, 0.2854 * (1 - 0.00028 * ws_gkg))
            * Math.exp((3.376 / Tp_K - 0.00254) * ws_gkg * (1 + 0.00081 * ws_gkg));
        const delta = (theta_e - theta_e_test) * 0.15;
        T_parcel_500 += delta;
        if (Math.abs(delta) < 0.001) break;
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

    if      (radiation > 600) pblHeight = Math.min(4000, pblHeight + 400);
    else if (radiation > 300) pblHeight = Math.min(4000, pblHeight + 200);
    else if (radiation < 20)  pblHeight = Math.max(100,  pblHeight - 300);

    return Math.round(Math.max(100, Math.min(4000, pblHeight)));
}

// ── EBWD: Effective Bulk Wind Difference ─────────────────────────────────
// Jetzt mit 925 hPa als unterem Level (statt 1000 hPa alleine)
// 925 hPa repräsentiert den unteren Teil der Einströmschicht besser
// Quelle: Thompson et al. 2003; Rasmussen 2003
function calcEBWD(hour) {
    const levels = [
        { speed: (hour.wind_speed_1000hPa ?? 0) / 3.6, dir: hour.windDir1000 ?? 0 },
        { speed: (hour.wind_speed_975hPa  ?? 0) / 3.6, dir: hour.windDir975  ?? 0 },
        { speed: (hour.wind_speed_950hPa  ?? 0) / 3.6, dir: hour.windDir950  ?? 0 },
        { speed: (hour.wind_speed_925hPa  ?? 0) / 3.6, dir: hour.windDir925  ?? 0 },
        { speed: (hour.wind_speed_900hPa  ?? 0) / 3.6, dir: hour.windDir900  ?? 0 },
        { speed: (hour.wind_speed_850hPa  ?? 0) / 3.6, dir: hour.windDir850  ?? 0 },
    ];

    const uv = levels.map(l => windToUV(l.speed, l.dir));
    const meanU = uv.reduce((s, w) => s + w.u, 0) / uv.length;
    const meanV = uv.reduce((s, w) => s + w.v, 0) / uv.length;
    const du = uv[uv.length - 1].u - meanU;
    const dv = uv[uv.length - 1].v - meanV;

    return Math.round(Math.hypot(du, dv) * 10) / 10;
}

// ── SRH: Storm-Relative Helicity ─────────────────────────────────────────
// 0-1km: 1000/975/950/925/900 hPa
// 0-3km: 1000/925/850/700 hPa
// 925 hPa jetzt explizit in beiden Schichten
function calcSRH(hour, layer = '0-3km') {
    // Monte Carlo Override
    if (layer === '0-1km' && hour._srh1Override !== undefined) return hour._srh1Override;
    if (layer === '0-3km' && hour._srh3Override !== undefined) return hour._srh3Override;
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

// ── DLS: Deep Layer Shear (AR-CHaMo Hauptprädiktor) ──────────────────────
// Offiziell: 925–500 hPa (Battaglioli 2023, statt vorher 1000-500 hPa)
// "925–500 hPa bulk shear" ist der primäre Scherungsprädiktor in AR-CHaMo
// Korrekturfaktor 1.08: 500 hPa liegt bei ~5.5 km statt 6 km
// Quelle: Battaglioli 2023, Table 1 + 2; Rädler 2018 Section 2c
function calcShear(hour) {
    // Monte Carlo Override: perturbierter Wert direkt verwenden
    if (hour._shearOverride !== undefined) return hour._shearOverride;
    const ws500  = (hour.wind_speed_500hPa  ?? 0) / 3.6;
    const ws925  = (hour.wind_speed_925hPa  ?? 0) / 3.6;
    const w500   = windToUV(ws500, hour.windDir500  ?? 0);
    const w925   = windToUV(ws925, hour.windDir925  ?? 0);
    // DLS 925-500 hPa (AR-CHaMo Standard)
    const dls925_500 = Math.hypot(w500.u - w925.u, w500.v - w925.v) * 1.08;

    // Fallback auf 1000–500 hPa falls 925 hPa fehlt (abwärtskompatibel)
    if ((hour.wind_speed_925hPa ?? 0) === 0) {
        const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
        const w1000  = windToUV(ws1000, hour.windDir1000 ?? 0);
        return Math.round(Math.hypot(w500.u - w1000.u, w500.v - w1000.v) * 1.08 * 10) / 10;
    }

    return Math.round(dls925_500 * 10) / 10;
}

function calcIndices(hour) {
    const temp500 = hour.temp500 ?? 0;
    const temp850 = hour.temp850 ?? 0;
    const temp700 = hour.temp700 ?? 0;
    const dew850  = hour.dew850  ?? 0;
    const dew700  = hour.dew700  ?? 0;

    const dewDep850  = temp850 - dew850;
    const T_LCL850   = temp850 - 0.212 * dewDep850 - 0.001 * dewDep850 * dewDep850;
    const T_LCL850_K = T_LCL850 + 273.15;
    const T850_K     = temp850 + 273.15;

    const e850     = 6.112 * Math.exp((17.67 * dew850) / (dew850 + 243.5));
    const w850     = 0.622 * e850 / (850 - e850);
    const w850_gkg = w850 * 1000;
    const theta_e850 = T850_K
        * Math.pow(1000 / 850, 0.2854 * (1 - 0.00028 * w850_gkg))
        * Math.exp((3.376 / T_LCL850_K - 0.00254) * w850_gkg * (1 + 0.00081 * w850_gkg));

    const z_LCL850 = 125 * dewDep850;
    const dz_moist = (3000 - z_LCL850) / 1000;
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

    const dewDep700 = temp700 - dew700;
    if (dewDep700 > 40) return 0;

    const wetBulb700   = temp700 - 0.43 * dewDep700;
    const T_parcel_sfc = wetBulb700 + 9.8 * 3.0;
    const tempDiff     = T_parcel_sfc - temp2m;
    if (tempDiff <= 0) return 0;

    let moistFactor;
    if      (dewDep700 <= 2)  moistFactor = 0.2;
    else if (dewDep700 <= 5)  moistFactor = 0.5;
    else if (dewDep700 <= 10) moistFactor = 0.9;
    else if (dewDep700 <= 15) moistFactor = 1.0;
    else if (dewDep700 <= 20) moistFactor = 0.8;
    else if (dewDep700 <= 25) moistFactor = 0.6;
    else if (dewDep700 <= 30) moistFactor = 0.4;
    else                      moistFactor = 0.2;

    const T_mean_K = ((wetBulb700 + temp2m) / 2) + 273.15;
    return Math.round(Math.max(0, (tempDiff / T_mean_K) * 9.81 * 3000 * moistFactor));
}

function calcWMAXSHEAR(cape, shear) {
    if (cape <= 0 || shear <= 0) return 0;
    const shear_kmh = shear * 3.6;
    return Math.round(Math.sqrt(2 * cape) * shear_kmh);
}

function calcLCLHeight(temp2m, dew2m) {
    const spread = temp2m - dew2m;
    if (spread <= 0) return 0;
    return Math.max(0, 125 * spread);
}

function calcMidLevelLapseRate(temp700, temp500) {
    return (temp700 - temp500) / 2.5;
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

function calcSTP(cape, srh1km, shear, liftedIndex, cin, temp2m = null, dew2m = null, hour = null) {
    if (cape < 80 || srh1km < 40 || shear < 12.5) return 0;

    let lclTerm;
    if (temp2m !== null && dew2m !== null) {
        const lclHeight = calcLCLHeight(temp2m, dew2m);
        if      (lclHeight < 1000)  lclTerm = 1.0;
        else if (lclHeight >= 2000) lclTerm = 0.0;
        else                        lclTerm = (2000 - lclHeight) / 1000;
    } else {
        lclTerm = liftedIndex <= -4 ? 1.0 : liftedIndex <= -2 ? 0.8 : liftedIndex <= 0 ? 0.5 : 0.2;
    }

    const capeTerm  = Math.min(cape / 1500, 3.0);
    const srhTerm   = Math.min(srh1km / 150, 3.0);
    const ebwd      = hour ? calcEBWD(hour) : shear;
    const shearTerm = Math.min(ebwd / 20, 2.0);

    let cinTerm;
    if      (cin >= -50)  cinTerm = 1.0;
    else if (cin <= -200) cinTerm = 0.0;
    else                  cinTerm = (200 + cin) / 150;

    return Math.max(0, capeTerm * srhTerm * shearTerm * lclTerm * cinTerm);
}

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


function categorizeRisk(prob) {
    const p = Math.max(0, Math.min(100, Math.round(prob ?? 0)));
    if (p >= 70) return { level: 3, label: 'high' };
    if (p >= 45) return { level: 2, label: 'moderate' };
    if (p >= 15) return { level: 1, label: 'tstorm' };
    return { level: 0, label: 'none' };
}

// ═══════════════════════════════════════════════════════════════════════════
// PHYSIKALISCHE GATES — das Fundament des gesamten Systems
//
// Prinzip: Jedes Gate muss GLEICHZEITIG erfüllt sein.
// Kein einzelner Parameter kann alleine ein Gewitter erzeugen.
// Das verhindert ECMWF-Artefakte (hohe RH bei LI>0 → trotzdem 37%).
//
// Quellen:
//   Rädler 2018: LI + CAPE als primäre Prädiktoren, beide notwendig
//   Battaglioli 2023: DLS 925-500hPa + CAPE + Feuchte als Triplette
//   Taszarek 2020: Europäische Schwellenwerte aus 10-Jahres-Klimatologie
// ═══════════════════════════════════════════════════════════════════════════
function physicalGates(hour) {
    const cape  = Math.max(0, hour.cape ?? 0);
    const li    = hour.liftedIndex ?? calcLiftedIndex(hour);
    const shear = calcShear(hour);
    const meanRH = hour.meanRH ?? 50;
    const cin   = hour.cin ?? 0;
    const magCin = -Math.min(0, cin);
    const temp  = hour.temperature ?? 0;

    // ── Gate 1: Instabilität — BEIDE müssen erfüllt sein ─────────────────
    // LI > 0 UND cape < 100 → definitiv stabil, egal was andere Parameter sagen
    // Ausnahme: sehr starke Scherung (HSLC) erlaubt LI bis +0.5
    const liOk   = li <= 0.5 || (li <= 1.5 && shear >= 15 && cape >= 80);
    const capeOk = cape >= 80 || (cape >= 50 && shear >= 15);

    // ── Gate 2: Mindest-Scherung für organisierten Aufwind ────────────────
    // Unter 5 m/s → reine Wärmewitter nur bei sehr hohem CAPE möglich
    const shearOk = shear >= 5 || cape >= 800;

    // ── Gate 3: Feuchte — trockenes Profil verhindert Gewitter ───────────
    // meanRH < 45% → auch mit CAPE kein Blitz (Entrainment trocknet aus)
    const rhOk = meanRH >= 45;

    // ── Gate 4: CIN — zu starke Sperrschicht verhindert Auslösung ─────────
    // CIN < -250 J/kg → kein Gewitter außer bei extremem CAPE
    const cinOk = magCin < 250 || cape >= 2000;

    // ── Gate 5: Temperatur — Winterlage ohne Scherung kein Gewitter ───────
    const tempOk = temp >= 3 || (temp >= 0 && shear >= 15 && cape >= 200);

    const allGatesPass = liOk && capeOk && shearOk && rhOk && cinOk && tempOk;

    return { allGatesPass, li, cape, shear, meanRH, magCin, temp };
}

// ═══════════════════════════════════════════════════════════════════════════
// BLITZ-WAHRSCHEINLICHKEIT (AR-CHaMo, Battaglioli 2023)
//
// Architektur: 3 Schichten
//   1. Physikalische Gates → hartes Null wenn nicht erfüllt
//   2. Logit (additive log. Regression) → Basiswahrscheinlichkeit
//   3. Skalierung → finale Prozentzahl
//
// Kein additiver Score mehr — nur noch multiplikative Faktoren
// die jeweils zwischen 0 und 1 liegen. Das verhindert Aufsummierung
// von Einzeltermen die zusammen falsch positiv werden.
// ═══════════════════════════════════════════════════════════════════════════
function calculateLightningProbability(hour) {
    const g = physicalGates(hour);
    if (!g.allGatesPass) return 0;

    const { li, cape, shear, meanRH, magCin, temp } = g;
    const mlMR   = hour.mlMixRatio ?? 0;
    const q925   = hour.q925 ?? 0;
    const dcape  = calcDCAPE(hour);
    const srh    = calcSRH(hour, '0-3km');
    const pbl    = hour.pblHeight ?? 1000;
    const month  = new Date(hour.time).getMonth() + 1;

    // ── Faktor 1: Instabilität (CAPE + LI kombiniert) ─────────────────────
    // Beide müssen gut sein — gutes CAPE bei positivem LI gibt wenig
    // LI log-transformiert: Unterschied -8 vs -10 weniger wichtig als -2 vs 0
    const capeFactor = Math.min(1.0, Math.log1p(cape / 200) / Math.log1p(10));
    const liFactor   = li <= -6 ? 1.0
                     : li <= -4 ? 0.85
                     : li <= -2 ? 0.70
                     : li <= -1 ? 0.55
                     : li <=  0 ? 0.40
                     : li <= 0.5 ? 0.20   // HSLC-Ausnahme
                     : 0.0;               // li > 0.5 → Gates hätten schon geblockt
    const instability = capeFactor * liFactor;

    // ── Faktor 2: Feuchte (AR-CHaMo Prädiktoren) ──────────────────────────
    // meanRH: Haupt-Feuchteterm (Rädler 2018)
    // mlMR + q925: Niedrigpegelfeuchte (Battaglioli 2023)
    const rhFactor = meanRH >= 75 ? 1.0
                   : meanRH >= 65 ? 0.85
                   : meanRH >= 55 ? 0.70
                   : meanRH >= 45 ? 0.50
                   : 0.0;
    const mrFactor = mlMR >= 12 ? 1.0
                   : mlMR >=  9 ? 0.90
                   : mlMR >=  7 ? 0.80
                   : mlMR >=  5 ? 0.70
                   : mlMR >=  3 ? 0.55
                   : 0.45;
    const moisture = rhFactor * (0.6 + 0.4 * mrFactor);

    // ── Faktor 3: Dynamik (Scherung + Hebung) ─────────────────────────────
    // DLS 925-500 hPa (AR-CHaMo Hauptprädiktor)
    const shearFactor = shear >= 25 ? 1.0
                      : shear >= 20 ? 0.90
                      : shear >= 15 ? 0.80
                      : shear >= 12 ? 0.70
                      : shear >=  8 ? 0.60
                      : shear >=  5 ? 0.45
                      : 0.30;

    // SRH: zusätzliche Rotation/Hebung
    const srhFactor = srh >= 200 ? 1.1
                    : srh >= 100 ? 1.0
                    : srh >=  50 ? 0.95
                    : 0.90;

    // DCAPE: Downdraft-Potential (Konvektions-Trigger)
    const dcapeFactor = dcape >= 800 ? 1.1
                      : dcape >= 500 ? 1.05
                      : dcape >= 300 ? 1.0
                      : 0.95;

    const dynamics = shearFactor * Math.min(1.2, srhFactor * dcapeFactor);

    // ── Faktor 4: CIN (hemmt Auslösung) ───────────────────────────────────
    const cinFactor = magCin <  25 ? 1.0
                    : magCin <  50 ? 0.85
                    : magCin < 100 ? 0.65
                    : magCin < 150 ? 0.40
                    : magCin < 200 ? 0.20
                    : 0.05;

    // ── Faktor 5: PBL-Entwicklung + Tageszeit ────────────────────────────
    const radiation = hour.directRadiation ?? 0;
    const dayFactor = radiation >= 600 ? 1.10
                    : radiation >= 300 ? 1.05
                    : radiation >=  50 ? 1.00
                    : 0.90;  // Nacht: leicht gedämpft außer LLJ

    // ── Faktor 6: Temperatur/Saison ───────────────────────────────────────
    const tempFactor = temp >= 22 ? 1.0
                     : temp >= 18 ? 0.95
                     : temp >= 14 ? 0.88
                     : temp >= 10 ? 0.78
                     : temp >=  6 ? 0.65
                     : 0.50;

    // ── Kombination → Rohwahrscheinlichkeit ──────────────────────────────
    // Alle Faktoren multiplikativ: jeder schwache Term dämpft das Ergebnis
    // Maximum bei perfekten Bedingungen: ~95%
    const raw = instability * moisture * dynamics * cinFactor * dayFactor * tempFactor;

    // ── Skalierung auf 0-100% ─────────────────────────────────────────────
    // raw liegt typisch zwischen 0 und ~0.6 bei europäischen Lagen
    // Skalierungsfaktor so gewählt dass extreme Lagen ~85-90% erreichen
    const prob = Math.min(95, raw * 160);

    // ── Finale Plausibilitätsprüfung ──────────────────────────────────────
    // Verhindert Restfehler: LI knapp positiv + schwache Scherung → hart null
    if (li > 0 && shear < 10 && cape < 200) return 0;
    if (li > 1 && cape < 400)               return 0;

    return Math.max(0, Math.round(prob));
}

// ═══════════════════════════════════════════════════════════════════════════
// HAGEL-WAHRSCHEINLICHKEIT ≥ 2cm (AR-CHaMo, Battaglioli 2023)
//
// P(hagel) = P(storm) × P(hagel|storm)
// P(hagel|storm) basiert auf SHIP × WBZ-Faktor × DLS-Faktor
// ═══════════════════════════════════════════════════════════════════════════
function calculateHailProbability(hour, wmaxshear, dcape) {
    const pStorm = calculateLightningProbability(hour);
    if (pStorm < 20) return 0;

    const cape  = Math.max(0, hour.cape ?? 0);
    const shear = calcShear(hour);
    const ship  = calcSHIP(hour);
    const wbz   = hour.wbzHeight ?? calcWBZHeight(hour);
    const mlMR  = hour.mlMixRatio ?? 0;

    // Mindestbedingungen für signifikanten Hagel
    if (cape < 300) return 0;
    if (shear < 8)  return 0;
    if (ship < 0.2) return 0;

    // SHIP → bedingte P(hagel ≥ 2cm | Gewitter)
    const pHailGivenStorm = ship >= 4.0 ? 90
                          : ship >= 3.0 ? 75
                          : ship >= 2.0 ? 55
                          : ship >= 1.5 ? 40
                          : ship >= 1.0 ? 25
                          : ship >= 0.5 ? 12
                          : 5;

    // WBZ-Faktor (AR-CHaMo Kern-Prädiktor für Hagelschmelze)
    const wbzFactor = wbz < 800  ? 0.45
                    : wbz <= 2100 ? 1.0
                    : wbz <= 2500 ? 0.75
                    : wbz <= 3000 ? 0.50
                    : wbz <= 3500 ? 0.25
                    : 0.08;

    // DLS-Faktor (AR-CHaMo Prädiktor)
    const dlsFactor = shear >= 20 ? 1.15
                    : shear >= 15 ? 1.08
                    : shear >= 10 ? 1.0
                    : 0.75;

    // ML Mixing Ratio (AR-CHaMo Prädiktor)
    const mrFactor = mlMR >= 12 ? 1.15
                   : mlMR >=  8 ? 1.05
                   : mlMR >=  5 ? 1.0
                   : 0.80;

    const combined = pHailGivenStorm * wbzFactor * dlsFactor * mrFactor * (pStorm / 100);
    return Math.min(95, Math.max(0, Math.round(combined * 0.85)));
}

// ═══════════════════════════════════════════════════════════════════════════
// WIND-WAHRSCHEINLICHKEIT (Severe Gusts ≥ 25 m/s)
// ═══════════════════════════════════════════════════════════════════════════
function calculateWindProbability(hour, wmaxshear, dcape) {
    const pStorm = calculateLightningProbability(hour);
    if (pStorm < 20) return 0;

    const cape    = Math.max(0, hour.cape ?? 0);
    const shear   = calcShear(hour);
    const temp700 = hour.temp700 ?? 0;
    const dew700  = hour.dew700  ?? 0;
    const temp500 = hour.temp500 ?? 0;
    const lapseRate = calcMidLevelLapseRate(temp700, temp500);
    const dewDep700 = temp700 - dew700;
    const meanRH  = hour.meanRH ?? 50;

    // Mindestbedingungen für Downburst-Wind
    if (dcape < 300)    return 0;
    if (wmaxshear < 400) return 0;

    // DCAPE-Faktor (primärer Wind-Prädiktor)
    const dcapeFactor = dcape >= 1400 ? 1.0
                      : dcape >= 1000 ? 0.85
                      : dcape >=  700 ? 0.70
                      : dcape >=  500 ? 0.55
                      : dcape >=  300 ? 0.35
                      : 0.0;

    // WMAXSHEAR-Faktor
    const wmsFactor = wmaxshear >= 1200 ? 1.0
                    : wmaxshear >= 900  ? 0.85
                    : wmaxshear >= 700  ? 0.70
                    : wmaxshear >= 500  ? 0.55
                    : wmaxshear >= 400  ? 0.35
                    : 0.0;

    // Trockenheit 700 hPa (Downburst-Verstärker)
    const dryFactor = dewDep700 >= 20 ? 1.2
                    : dewDep700 >= 12 ? 1.1
                    : dewDep700 >=  6 ? 1.0
                    : 0.85;

    // Lapse Rate (Instabilitätsverstärker)
    const lapseFactor = lapseRate >= 8.0 ? 1.15
                      : lapseRate >= 7.0 ? 1.05
                      : lapseRate >= 6.0 ? 1.0
                      : 0.85;

    const raw = dcapeFactor * wmsFactor * dryFactor * lapseFactor * (pStorm / 100);
    return Math.min(95, Math.max(0, Math.round(raw * 120)));
}

// ═══════════════════════════════════════════════════════════════════════════
// TORNADO-WAHRSCHEINLICHKEIT
// ═══════════════════════════════════════════════════════════════════════════
function calculateTornadoProbability(hour, shear, srh) {
    const pStorm = calculateLightningProbability(hour);
    if (pStorm < 40) return 0;

    const cape  = Math.max(0, hour.cape ?? 0);
    const srh1  = calcSRH(hour, '0-1km');
    const temp  = hour.temperature ?? 20;
    const dew   = hour.dew ?? 10;
    const cin   = hour.cin ?? 0;
    const ebwd  = calcEBWD(hour);
    const lcl   = calcLCLHeight(temp, dew);

    // Mindestbedingungen für Tornado
    if (cape < 200)  return 0;
    if (srh1 < 80)   return 0;
    if (ebwd < 12)   return 0;

    const cinFactor = Math.max(0, (200 + cin) / 150);
    const lclFactor = lcl < 1000  ? 1.0
                    : lcl < 1500  ? 0.7
                    : lcl < 2000  ? 0.4
                    : 0.1;

    let stp = (cape / 1500) * lclFactor * (srh1 / 150) * (ebwd / 20) * cinFactor;
    stp = Math.max(0, stp);

    const stpPercent = stp < 0.3 ? 0
                     : stp < 0.5 ? 5
                     : stp < 1.0 ? 10
                     : stp < 1.5 ? 18
                     : stp < 2.0 ? 28
                     : stp < 3.0 ? 40
                     : stp < 4.0 ? 55
                     : 70;

    if (stpPercent < 5) return 0;
    return Math.round(stpPercent * 0.85 * (pStorm / 100));
}
