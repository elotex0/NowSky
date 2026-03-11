export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'lat und lon Parameter sind erforderlich' });

    const latitude  = parseFloat(lat);
    const longitude = parseFloat(lon);
    if (isNaN(latitude) || isNaN(longitude)) return res.status(400).json({ error: 'Ungültige Koordinaten' });

    try {
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
            `direct_radiation,total_column_integrated_water_vapour&forecast_days=16&models=icon_eu,ecmwf_ifs025,gfs_global&timezone=auto`;

        const response = await fetch(url);
        const data     = await response.json();

        if (data.error) return res.status(500).json({ error: 'API-Fehler: ' + (data.reason || data.error.message || 'Unbekannt') });
        if (!data?.hourly?.time?.length) return res.status(500).json({ error: 'Keine Daten verfügbar' });

        const timezone = data.timezone || 'UTC';
        const region   = getRegion(latitude, longitude);
        if (region !== 'europe') {
            return res.status(400).json({ error: 'Vorhersage nur für Europa verfügbar', region, onlyEurope: true });
        }

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

        // ═══════════════════════════════════════════════════════════════════
        // SCHRITT 1: Pro Modell Stunden extrahieren
        // ═══════════════════════════════════════════════════════════════════
        function extractModelHour(hourly, i, model) {
            function get(field) {
                const arr = hourly[`${field}_${model}`];
                if (Array.isArray(arr) && arr[i] !== undefined && arr[i] !== null) return arr[i];
                return null;
            }

            const t2m  = get('temperature_2m');
            const d2m  = get('dew_point_2m');
            const t925 = get('temperature_925hPa');
            const d925 = get('dew_point_925hPa');
            const t850 = get('temperature_850hPa');
            const d850 = get('dew_point_850hPa');
            const t700 = get('temperature_700hPa');
            const d700 = get('dew_point_700hPa');
            const t500 = get('temperature_500hPa');

            if (t2m === null || t850 === null || t500 === null) return null;

            const rawCin = get('convective_inhibition');
            const rawLI  = get('lifted_index');
            const rawPBL = get('boundary_layer_height');

            const hour = {
                time:               hourly.time[i],
                temperature:        t2m,
                dew:                d2m ?? t2m - 10,
                cloudLow:           get('cloud_cover_low')  ?? 0,
                cloudMid:           get('cloud_cover_mid')  ?? 0,
                cloudHigh:          get('cloud_cover_high') ?? 0,
                precip:             get('precipitation_probability') ?? 0,
                wind:               get('wind_speed_10m')   ?? 0,
                gust:               get('wind_gusts_10m')   ?? 0,

                windDir1000: get('wind_direction_1000hPa') ?? 0,
                windDir975:  get('wind_direction_975hPa')  ?? 0,
                windDir950:  get('wind_direction_950hPa')  ?? 0,
                windDir925:  get('wind_direction_925hPa')  ?? 0,
                windDir900:  get('wind_direction_900hPa')  ?? 0,
                windDir850:  get('wind_direction_850hPa')  ?? 0,
                windDir700:  get('wind_direction_700hPa')  ?? 0,
                windDir500:  get('wind_direction_500hPa')  ?? 0,
                windDir300:  get('wind_direction_300hPa')  ?? 0,

                wind_speed_1000hPa: get('wind_speed_1000hPa') ?? 0,
                wind_speed_975hPa:  get('wind_speed_975hPa')  ?? 0,
                wind_speed_950hPa:  get('wind_speed_950hPa')  ?? 0,
                wind_speed_925hPa:  get('wind_speed_925hPa')  ?? 0,
                wind_speed_900hPa:  get('wind_speed_900hPa')  ?? 0,
                wind_speed_850hPa:  get('wind_speed_850hPa')  ?? 0,
                wind_speed_700hPa:  get('wind_speed_700hPa')  ?? 0,
                wind_speed_500hPa:  get('wind_speed_500hPa')  ?? 0,
                wind_speed_300hPa:  get('wind_speed_300hPa')  ?? 0,

                temp925: t925 ?? (t2m * 0.4 + t850 * 0.6),
                temp850: t850,
                temp700: t700 ?? (t850 + t500) / 2,
                temp500: t500,
                dew925:  d925 ?? (d2m ?? t2m - 10),
                dew850:  d850 ?? (d2m ?? t2m - 10),
                dew700:  d700 ?? (d2m ?? t2m - 10),

                rh925: get('relative_humidity_925hPa') ?? null,
                rh850: get('relative_humidity_850hPa') ?? null,
                rh700: get('relative_humidity_700hPa') ?? null,
                rh500: get('relative_humidity_500hPa') ?? 50,

                cape:            Math.max(0, get('cape') ?? 0),
                directRadiation: get('direct_radiation') ?? 0,
                precipAcc:       get('precipitation') ?? 0,
                pwat:            get('total_column_integrated_water_vapour') ?? 25,

                freezingLevel: null,
                cin:           null,
                liftedIndex:   null,
                pblHeight:     null,
            };

            // Gefrierniveau
            const apiFL = get('freezing_level_height');
            hour.freezingLevel = (apiFL !== null && apiFL >= 100 && apiFL <= 6000)
                ? apiFL : calcFreezingLevel(hour);

            // CIN-Strategie nach Modell:
            // GFS:          API-Wert direkt nutzen (GFS CIN ist akkurat wenn negativ,
            //               und GFS gibt korrekterweise 0 bei LI ≤ 0 zurück)
            // ICON/ECMWF:   Immer berechnen – beide Modelle geben über die Open-Meteo-API
            //               häufig CIN=0 zurück auch bei stabilen Lagen (API-Artefakt),
            //               die eigene theta-e-basierte Berechnung ist zuverlässiger
            if (model === 'gfs_global') {
                // GFS: API-Wert nehmen, null-Fallback auf Berechnung
                hour.cin = rawCin !== null ? rawCin : calcCIN(hour, rawLI ?? 99);
            } else {
                // ICON / ECMWF: immer berechnen, API-Wert ignorieren
                hour.cin = calcCIN(hour, rawLI ?? 99);
            }

            hour.liftedIndex = rawLI ?? calcLiftedIndex(hour);
            hour.pblHeight   = (rawPBL !== null && rawPBL > 50) ? rawPBL : calcPBLHeight(hour);

            // Relative Feuchte
            hour.rh925 = hour.rh925 ?? calcRelHum(hour.temp925, hour.dew925);
            hour.rh850 = hour.rh850 ?? calcRelHum(hour.temp850, hour.dew850);
            hour.rh700 = hour.rh700 ?? calcRelHum(hour.temp700, hour.dew700);

            // ML Mixing Ratio (925+850 hPa Mittel, AR-CHaMo)
            const e925 = svp(hour.dew925);
            const e850 = svp(hour.dew850);
            hour.mlMixRatio = ((mixingRatio(e925, 925) + mixingRatio(e850, 850)) / 2);
            hour.q925       = hour.mlMixRatio * 925 / (hour.mlMixRatio + 622); // spez. Feuchte g/kg Näherung

            // WBZ und meanRH
            hour.wbzHeight = calcWBZHeight(hour);
            hour.meanRH    = (hour.rh850 + hour.rh700 + hour.rh500) / 3;

            return hour;
        }

        // ═══════════════════════════════════════════════════════════════════
        // SCHRITT 2: Modellgewichtung nach Leadtime
        // ═══════════════════════════════════════════════════════════════════
        function getModelWeight(model, lt) {
            lt = Math.max(0, lt ?? 0);
            const W = {
                icon_eu:      [0.45, 0.40, 0.30, 0.20, 0.20],
                ecmwf_ifs025: [0.35, 0.40, 0.50, 0.60, 0.50],
                gfs_global:   [0.20, 0.20, 0.20, 0.20, 0.30],
            };
            const idx = lt <= 12 ? 0 : lt <= 36 ? 1 : lt <= 72 ? 2 : lt <= 120 ? 3 : 4;
            return W[model]?.[idx] ?? (1/3);
        }

        function ensembleProb(probsByModel, lt) {
            let ws = 0, tw = 0;
            for (const [model, prob] of Object.entries(probsByModel)) {
                if (prob === null) continue;
                const w = getModelWeight(model, lt);
                ws += prob * w;
                tw += w;
            }
            return tw === 0 ? 0 : Math.round(ws / tw);
        }

        function ensembleMean(values) {
            const v = values.filter(x => x !== null && !isNaN(x));
            return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
        }

        // ═══════════════════════════════════════════════════════════════════
        // SCHRITT 3: Stunden verarbeiten
        // ═══════════════════════════════════════════════════════════════════
        const hours = data.hourly.time.map((t, i) => {
            const forecastTime  = new Date(t);
            const lt            = Math.round((forecastTime - now) / 3600000);
            const modelHours    = {};

            for (const model of MODELS) {
                modelHours[model] = extractModelHour(data.hourly, i, model);
            }

            const gw = {}, tw = {}, hw = {}, ww = {};
            for (const model of MODELS) {
                const mh = modelHours[model];
                if (!mh) { gw[model] = tw[model] = hw[model] = ww[model] = null; continue; }
                const shear     = calcShear(mh);
                const srh3      = calcSRH(mh, '0-3km');
                const dcape     = calcDCAPE(mh);
                const wmaxshear = calcWMAXSHEAR(mh.cape, shear);
                gw[model] = calculateLightningProbability(mh);
                tw[model] = calculateTornadoProbability(mh, shear, srh3);
                hw[model] = calculateHailProbability(mh, wmaxshear, dcape);
                ww[model] = calculateWindProbability(mh, wmaxshear, dcape);
            }

            const probability        = ensembleProb(gw, lt);
            const tornadoProbability = Math.min(ensembleProb(tw, lt), probability);
            const hailProbability    = ensembleProb(hw, lt);
            const windProbability    = ensembleProb(ww, lt);

            const vMH = Object.values(modelHours).filter(Boolean);
            return {
                time: t,
                probability,
                tornadoProbability,
                hailProbability,
                windProbability,
                temperature: Math.round(ensembleMean(vMH.map(m => m.temperature)) * 10) / 10,
                cape:        Math.round(ensembleMean(vMH.map(m => m.cape))),
                shear:       Math.round(ensembleMean(vMH.map(m => calcShear(m))) * 10) / 10,
                srh:         Math.round(ensembleMean(vMH.map(m => calcSRH(m, '0-3km'))) * 10) / 10,
                dcape:       Math.round(ensembleMean(vMH.map(m => calcDCAPE(m)))),
                wmaxshear:   Math.round(ensembleMean(vMH.map(m => calcWMAXSHEAR(m.cape, calcShear(m))))),
            };
        });

        const nextHours = hours.filter(h => {
            const [dp, tp] = h.time.split('T');
            const hr = parseInt(tp);
            return dp > currentDateStr || (dp === currentDateStr && hr >= currentHour);
        }).slice(0, 24);

        const daysMap = new Map();
        hours.forEach(h => {
            const [dp, tp] = h.time.split('T');
            const hr = parseInt(tp);
            if (dp < currentDateStr || (dp === currentDateStr && hr < currentHour)) return;
            if (!daysMap.has(dp)) {
                daysMap.set(dp, { date: dp, maxProbability: h.probability, maxTornadoProbability: h.tornadoProbability, maxHailProbability: h.hailProbability, maxWindProbability: h.windProbability });
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

        const tage = Array.from(daysMap.values()).sort((a, b) => a.date.localeCompare(b.date)).map(day => ({
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

        // Debug
        const debugStunden = nextHours.slice(0, 20).map(h => {
            const i = data.hourly.time.indexOf(h.time);
            const perModel = {};
            for (const model of MODELS) {
                const mh = extractModelHour(data.hourly, i, model);
                if (!mh) { perModel[model] = null; continue; }
                const shear  = calcShear(mh);
                const srh3   = calcSRH(mh, '0-3km');
                const srh1   = calcSRH(mh, '0-1km');
                const dcape  = calcDCAPE(mh);
                const wms    = calcWMAXSHEAR(mh.cape, shear);
                const ebwd   = calcEBWD(mh);
                const scp    = calcSCP(mh.cape, shear, srh3, mh.cin);
                const stp    = calcSTP(mh, shear, srh1);
                const ehi    = (mh.cape * srh1) / 160000;
                const lcl    = calcLCLHeight(mh.temperature, mh.dew);
                const eli    = calcELI(mh.cape, mh.cin, mh.pblHeight);
                const ki     = calcKIndex(mh);
                const si     = calcShowalter(mh);
                const midLap = calcMidLapseRate(mh.temp700, mh.temp500);
                perModel[model] = {
                    archamo_li:       Math.round(mh.liftedIndex * 10) / 10,
                    archamo_dls:      Math.round(shear * 10) / 10,
                    archamo_meanRH:   Math.round(mh.meanRH),
                    archamo_q925:     Math.round(mh.q925 * 10) / 10,
                    archamo_mlMR:     Math.round(mh.mlMixRatio * 10) / 10,
                    archamo_wbz:      Math.round(mh.wbzHeight),
                    archamo_cape:     Math.round(mh.cape),
                    archamo_flHeight: Math.round(mh.freezingLevel),
                    gewitter: calculateLightningProbability(mh),
                    tornado:  calculateTornadoProbability(mh, shear, srh3),
                    hagel:    calculateHailProbability(mh, wms, dcape),
                    wind:     calculateWindProbability(mh, wms, dcape),
                    cape: Math.round(mh.cape), cin: Math.round(mh.cin ?? 0),
                    dcape: Math.round(dcape), eli: Math.round(eli), lcl: Math.round(lcl),
                    freezingLevel: Math.round(mh.freezingLevel), wbzHeight: Math.round(mh.wbzHeight),
                    pblHeight: Math.round(mh.pblHeight),
                    temp2m: mh.temperature, dew2m: mh.dew,
                    temp925: mh.temp925, dew925: mh.dew925,
                    temp500: mh.temp500, temp700: mh.temp700, temp850: mh.temp850,
                    dew700: mh.dew700, dew850: mh.dew850,
                    relHum2m: Math.round(calcRelHum(mh.temperature, mh.dew)),
                    rh925: Math.round(mh.rh925), rh500: Math.round(mh.rh500),
                    rh700: Math.round(mh.rh700), rh850: Math.round(mh.rh850),
                    meanRH: Math.round(mh.meanRH),
                    mlMixRatio: Math.round(mh.mlMixRatio * 10) / 10,
                    q925: Math.round(mh.q925 * 10) / 10,
                    pwat: Math.round(mh.pwat),
                    liftedIndex: Math.round(mh.liftedIndex * 10) / 10,
                    kIndex: Math.round(ki * 10) / 10,
                    showalter: Math.round(si * 10) / 10,
                    midLapse: Math.round(midLap * 10) / 10,
                    shear: Math.round(shear * 10) / 10,
                    srh1km: Math.round(srh1 * 10) / 10,
                    srh3km: Math.round(srh3 * 10) / 10,
                    ebwd: Math.round(ebwd * 10) / 10,
                    wmaxshear: Math.round(wms),
                    scp: Math.round(scp * 100) / 100,
                    stp: Math.round(stp * 100) / 100,
                    ehi: Math.round(ehi * 100) / 100,
                    ship: Math.round(calcSHIP(mh) * 100) / 100,
                    wind10m: Math.round(mh.wind * 10) / 10,
                    gust10m: Math.round(mh.gust * 10) / 10,
                    wind925: Math.round((mh.wind_speed_925hPa ?? 0) * 10) / 10,
                    dir925:  Math.round(mh.windDir925 ?? 0),
                    cloudLow: Math.round(mh.cloudLow), cloudMid: Math.round(mh.cloudMid),
                    cloudHigh: Math.round(mh.cloudHigh),
                    precipProb: Math.round(mh.precip), precipAcc: Math.round(mh.precipAcc * 10) / 10,
                    radiation: Math.round(mh.directRadiation),
                };
            }
            return { timestamp: h.time, ensemble_gewitter: h.probability, ensemble_tornado: h.tornadoProbability, ensemble_hagel: h.hailProbability, ensemble_wind: h.windProbability, per_modell: perModel };
        });

        return res.status(200).json({
            timezone, region, stunden, tage,
            debug: {
                hinweis: 'AR-CHaMo v2 Methodik: Rädler 2018 + Battaglioli 2023 + ESSL/ESTOFEX/AStrop-Ansatz. Multiplikatives Gating statt additiver Scores. Alle Jahreszeiten kalibriert.',
                stunden: debugStunden,
            },
        });

    } catch (err) {
        console.error('Fehler:', err);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// HILFSFUNKTIONEN
// ═══════════════════════════════════════════════════════════════════════════

function getRegion(lat, lon) {
    return (lat >= 35 && lat <= 70 && lon >= -10 && lon <= 40) ? 'europe' : 'outside_europe';
}

function windToUV(speed, dir) {
    const r = dir * Math.PI / 180;
    return { u: -speed * Math.sin(r), v: -speed * Math.cos(r) };
}

function calcRelHum(temp, dew) {
    const es = svp(temp), e = svp(dew);
    return Math.min(100, Math.max(0, (e / es) * 100));
}

function svp(T) {
    // Magnus-Formel (Tetens)
    return 6.112 * Math.exp((17.67 * T) / (T + 243.5));
}

function mixingRatio(e, p) {
    // g/kg
    return 1000 * 0.622 * e / (p - e);
}

// ── Sigmoid-Normierung (0→1) ─────────────────────────────────────────────
// Kernwerkzeug für multiplikatives Gating:
// linear zwischen low (→0) und high (→1), geclamped
function linNorm(value, low, high) {
    if (high === low) return value >= high ? 1 : 0;
    return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

// Smooth sigmoid-Variante für sanftere Übergänge
function sigmoidNorm(value, center, scale) {
    return 1 / (1 + Math.exp(-(value - center) / scale));
}

// ── Gefrierniveau ────────────────────────────────────────────────────────
function calcFreezingLevel(hour) {
    const levels = [
        { z: 111,  T: hour.temperature },
        { z: 762,  T: hour.temp925 },
        { z: 1457, T: hour.temp850 },
        { z: 3012, T: hour.temp700 },
        { z: 5574, T: hour.temp500 },
    ].filter(l => l.T !== null);
    if (levels.length < 2) return 2000;
    for (let i = 0; i < levels.length - 1; i++) {
        const l1 = levels[i], l2 = levels[i+1];
        if (l1.T >= 0 && l2.T < 0) {
            return Math.round(l1.z + (l1.T / (l1.T - l2.T)) * (l2.z - l1.z));
        }
    }
    return levels[levels.length-1].T > 0 ? 4500 : 300;
}

// ── WBZ (Wet Bulb Zero) ──────────────────────────────────────────────────
function calcWBZHeight(hour) {
    const wb = level => level.T - (level.T - level.Td) / 3;
    const levels = [
        { z: 111,  T: hour.temperature, Td: hour.dew },
        { z: 762,  T: hour.temp925,     Td: hour.dew925 },
        { z: 1457, T: hour.temp850,     Td: hour.dew850 },
        { z: 3012, T: hour.temp700,     Td: hour.dew700 },
    ].map(l => ({ z: l.z, wb: wb(l) }));
    for (let i = 0; i < levels.length - 1; i++) {
        const l1 = levels[i], l2 = levels[i+1];
        if (l1.wb >= 0 && l2.wb < 0) {
            return Math.round(l1.z + (l1.wb / (l1.wb - l2.wb)) * (l2.z - l1.z));
        }
    }
    return levels[levels.length-1].wb > 0 ? 4000 : 200;
}

// ── CIN Berechnung ───────────────────────────────────────────────────────
// Vollständige theta-e-basierte Berechnung, unabhängig vom Modell-CIN
// rawLI als Plausibilitätshilfe (wenn sehr negativ → CIN wahrscheinlich 0)
function calcCIN(hour, rawLI = 99) {
    const t2m  = hour.temperature ?? 0;
    const d2m  = hour.dew ?? t2m - 10;
    const t850 = hour.temp850 ?? 0;
    const t700 = hour.temp700 ?? 0;

    // Wenn LI sehr negativ → echte Konvektion, CIN minimal
    if (rawLI < -2) return 0;

    const dd2m   = t2m - d2m;
    const T_LCL  = t2m - 0.212 * dd2m - 0.001 * dd2m * dd2m;
    const z_LCL  = 125 * dd2m;
    const T2m_K  = t2m + 273.15;
    const TLCL_K = T_LCL + 273.15;
    const w2m    = mixingRatio(svp(d2m), 1013.25);
    const theta_e_sfc = T2m_K
        * Math.pow(1000 / 1013.25, 0.2854 * (1 - 0.00028 * w2m))
        * Math.exp((3.376 / TLCL_K - 0.00254) * w2m * (1 + 0.00081 * w2m));

    const z850 = 1500, DALR = 9.8;
    let T_p850;
    if (z_LCL >= z850) {
        T_p850 = t2m - DALR * 1.5;
    } else {
        T_p850 = T_LCL - 4;
        for (let n = 0; n < 8; n++) {
            const Tp_K = T_p850 + 273.15;
            const ws   = mixingRatio(svp(T_p850), 850);
            const te_t = Tp_K * Math.pow(1000/850, 0.2854*(1-0.00028*ws))
                * Math.exp((3.376/Tp_K - 0.00254)*ws*(1+0.00081*ws));
            T_p850 += (theta_e_sfc - te_t) * 0.3;
        }
    }

    const dT850 = T_p850 - t850;
    const g = 9.81;
    const cin_low = dT850 < 0 ? (dT850/2 / ((t2m+t850)/2+273.15)) * g * z850 : 0;

    let cin_mid = 0;
    if (dT850 < 0) {
        let T_p700 = T_p850;
        for (let n = 0; n < 8; n++) {
            const Tp_K = T_p700 + 273.15;
            const ws   = mixingRatio(svp(T_p700), 700);
            const te_t = Tp_K * Math.pow(1000/700, 0.2854*(1-0.00028*ws))
                * Math.exp((3.376/Tp_K - 0.00254)*ws*(1+0.00081*ws));
            T_p700 += (theta_e_sfc - te_t) * 0.3;
        }
        const dT700 = T_p700 - t700;
        if (dT700 < 0) {
            cin_mid = ((dT850+dT700)/2 / ((t850+t700)/2+273.15)) * g * 1500;
        } else {
            const frac = dT850 / (dT850 - dT700);
            cin_mid = (dT850/2 / (t850+273.15)) * g * (frac * 1500);
        }
    }

    return Math.round(Math.max(-500, Math.min(0, cin_low + cin_mid)));
}

// ── Lifted Index ─────────────────────────────────────────────────────────
function calcLiftedIndex(hour) {
    const t2m = hour.temperature ?? 0, d2m = hour.dew ?? t2m-10, t500 = hour.temp500 ?? 0;
    const dd  = t2m - d2m;
    const TLCL_K = (t2m - 0.212*dd - 0.001*dd*dd) + 273.15;
    const w2m    = mixingRatio(svp(d2m), 1013.25);
    const theta_e = (t2m+273.15)
        * Math.pow(1000/1013.25, 0.2854*(1-0.00028*w2m))
        * Math.exp((3.376/TLCL_K - 0.00254)*w2m*(1+0.00081*w2m));
    let Tp500 = (t2m - 0.212*dd) - 6.0 * ((5500 - 125*dd) / 1000);
    for (let n = 0; n < 25; n++) {
        const Tp_K = Tp500 + 273.15;
        const ws   = mixingRatio(svp(Tp500), 500);
        const te_t = Tp_K * Math.pow(1000/500, 0.2854*(1-0.00028*ws))
            * Math.exp((3.376/Tp_K - 0.00254)*ws*(1+0.00081*ws));
        const d = (theta_e - te_t) * 0.15;
        Tp500 += d;
        if (Math.abs(d) < 0.001) break;
    }
    return Math.round((t500 - Tp500) * 10) / 10;
}

// ── PBL-Höhe ─────────────────────────────────────────────────────────────
function calcPBLHeight(hour) {
    const t2m = hour.temperature ?? 0, t850 = hour.temp850 ?? 0, t700 = hour.temp700 ?? 0;
    const rad = hour.directRadiation ?? 0;
    const DALR = 9.8, z850 = 1500, z700 = 3000;
    const Tp850 = t2m - DALR * 1.5, Tp700 = t2m - DALR * 3.0;
    let pbl;
    if (Tp850 >= t850) {
        if (Tp700 >= t700) {
            const le = (t850 - t700) / (z700 - z850) * 1000;
            pbl = le >= DALR ? 3500 : Math.min(4000, z700 + (Tp700 - t700) / (DALR - le) * 1000);
        } else {
            pbl = z850 + ((Tp850-t850) / ((Tp850-t850) - (Tp700-t700))) * (z700 - z850);
        }
    } else {
        const le = (t2m - t850) / z850 * 1000;
        pbl = le <= 0 ? 200 : Math.max(200, Math.min((t2m-t850)/(DALR-le)*1000, z850));
    }
    if      (rad > 600) pbl = Math.min(4000, pbl + 400);
    else if (rad > 300) pbl = Math.min(4000, pbl + 200);
    else if (rad < 20)  pbl = Math.max(100,  pbl - 300);
    return Math.round(Math.max(100, Math.min(4000, pbl)));
}

// ── Scherung 925–500 hPa (AR-CHaMo DLS) ──────────────────────────────────
function calcShear(hour) {
    const ws500 = (hour.wind_speed_500hPa ?? 0) / 3.6;
    const ws925 = (hour.wind_speed_925hPa ?? 0) / 3.6;
    const w500  = windToUV(ws500, hour.windDir500 ?? 0);
    const w925  = windToUV(ws925, hour.windDir925 ?? 0);
    if (ws925 === 0) {
        const ws1000 = (hour.wind_speed_1000hPa ?? 0) / 3.6;
        const w1000  = windToUV(ws1000, hour.windDir1000 ?? 0);
        return Math.round(Math.hypot(w500.u-w1000.u, w500.v-w1000.v) * 1.08 * 10) / 10;
    }
    return Math.round(Math.hypot(w500.u-w925.u, w500.v-w925.v) * 1.08 * 10) / 10;
}

// ── SRH ──────────────────────────────────────────────────────────────────
function calcSRH(hour, layer = '0-3km') {
    const levels = layer === '0-1km'
        ? ['1000','975','950','925','900'].map(p => ({ ws: (hour[`wind_speed_${p}hPa`]??0)/3.6, wd: hour[`windDir${p}`]??0 }))
        : ['1000','925','850','700'].map(p => ({ ws: (hour[`wind_speed_${p}hPa`]??0)/3.6, wd: hour[`windDir${p}`]??0 }));
    const winds = levels.map(l => windToUV(l.ws, l.wd));
    const mU = winds.reduce((s,w)=>s+w.u,0)/winds.length;
    const mV = winds.reduce((s,w)=>s+w.v,0)/winds.length;
    const dU = winds[winds.length-1].u - winds[0].u;
    const dV = winds[winds.length-1].v - winds[0].v;
    const sm = Math.hypot(dU,dV) || 1;
    const sU = mU + 7.5*(dV/sm), sV = mV - 7.5*(dU/sm);
    let srh = 0;
    for (let i = 0; i < winds.length-1; i++) {
        const u1=winds[i].u-sU, v1=winds[i].v-sV, u2=winds[i+1].u-sU, v2=winds[i+1].v-sV;
        srh += u1*v2 - u2*v1;
    }
    return Math.round(Math.abs(srh) * 10) / 10;
}

// ── EBWD ──────────────────────────────────────────────────────────────────
function calcEBWD(hour) {
    const levels = ['1000','975','950','925','900','850'].map(p => ({
        speed: (hour[`wind_speed_${p}hPa`]??0)/3.6, dir: hour[`windDir${p}`]??0
    }));
    const uv = levels.map(l => windToUV(l.speed, l.dir));
    const mU = uv.reduce((s,w)=>s+w.u,0)/uv.length;
    const mV = uv.reduce((s,w)=>s+w.v,0)/uv.length;
    return Math.round(Math.hypot(uv[uv.length-1].u-mU, uv[uv.length-1].v-mV) * 10) / 10;
}

// ── DCAPE ─────────────────────────────────────────────────────────────────
function calcDCAPE(hour) {
    const t700 = hour.temp700 ?? 0, d700 = hour.dew700 ?? 0, t2m = hour.temperature ?? 0;
    const dd700 = t700 - d700;
    if (dd700 > 40) return 0;
    const wb700     = t700 - 0.43 * dd700;
    const Tp_sfc    = wb700 + 9.8 * 3.0;
    const tempDiff  = Tp_sfc - t2m;
    if (tempDiff <= 0) return 0;
    const mf = dd700 <= 2 ? 0.2 : dd700 <= 5 ? 0.5 : dd700 <= 10 ? 0.9 : dd700 <= 15 ? 1.0 : dd700 <= 20 ? 0.8 : dd700 <= 25 ? 0.6 : dd700 <= 30 ? 0.4 : 0.2;
    return Math.round(Math.max(0, (tempDiff / ((wb700+t2m)/2+273.15)) * 9.81 * 3000 * mf));
}

function calcWMAXSHEAR(cape, shear) {
    return (cape > 0 && shear > 0) ? Math.round(Math.sqrt(2*cape) * shear * 3.6) : 0;
}

function calcLCLHeight(temp, dew) {
    return Math.max(0, 125 * Math.max(0, temp - dew));
}

function calcMidLapseRate(t700, t500) {
    return (t700 - t500) / 2.5;
}

function calcKIndex(hour) {
    return (hour.temp850??0) - (hour.temp500??0) + (hour.dew850??0) - ((hour.temp700??0) - (hour.dew700??0));
}

function calcShowalter(hour) {
    // Vereinfachter Showalter: Parcel von 850 hPa nach 500 hPa
    const t850 = hour.temp850??0, d850 = hour.dew850??0, t500 = hour.temp500??0;
    const dd   = t850 - d850;
    const TLCL = t850 - 0.212*dd - 0.001*dd*dd;
    const TLCL_K = TLCL + 273.15;
    const w850   = mixingRatio(svp(d850), 850);
    const theta_e = (t850+273.15) * Math.pow(1000/850, 0.2854*(1-0.00028*w850))
        * Math.exp((3.376/TLCL_K - 0.00254)*w850*(1+0.00081*w850));
    let Tp500 = TLCL - 6.0 * ((3000 - 125*dd) / 1000);
    for (let n = 0; n < 20; n++) {
        const Tp_K = Tp500 + 273.15;
        const ws   = mixingRatio(svp(Tp500), 500);
        const te_t = Tp_K * Math.pow(1000/500, 0.2854*(1-0.00028*ws))
            * Math.exp((3.376/Tp_K - 0.00254)*ws*(1+0.00081*ws));
        const d = (theta_e - te_t) * 0.15;
        Tp500 += d;
        if (Math.abs(d) < 0.001) break;
    }
    return Math.round((t500 - Tp500) * 10) / 10;
}

function calcSCP(cape, shear, srh, cin) {
    if (cape < 100 || shear < 12.5 || srh < 40) return 0;
    const magCin = -Math.min(0, cin);
    const cinT   = magCin < 40 ? 1.0 : Math.max(0.1, 1 - (magCin-40)/200);
    return Math.max(0, (cape/1000) * Math.min(srh/50,4) * Math.min(shear/12,1.5) * cinT);
}

function calcSTP(hour, shear, srh1) {
    const cape = hour.cape ?? 0, cin = hour.cin ?? 0;
    if (cape < 80 || srh1 < 40 || shear < 12.5) return 0;
    const lcl = calcLCLHeight(hour.temperature, hour.dew);
    const lclT = lcl < 1000 ? 1.0 : lcl >= 2000 ? 0.0 : (2000-lcl)/1000;
    const cinT = cin >= -50 ? 1.0 : cin <= -200 ? 0.0 : (200+cin)/150;
    const ebwd = calcEBWD(hour);
    return Math.max(0, Math.min(cape/1500,3) * Math.min(srh1/150,3) * Math.min(ebwd/20,2) * lclT * cinT);
}

function calcELI(cape, cin, pbl) {
    if (cape < 50) return 0;
    const pblF = pbl > 1500 ? 1.2 : pbl > 1000 ? 1.0 : pbl > 500 ? 0.8 : 0.6;
    const cinF = (-Math.min(0,cin)) < 25 ? 1.0 : (-Math.min(0,cin)) < 50 ? 0.9 : (-Math.min(0,cin)) < 100 ? 0.7 : (-Math.min(0,cin)) < 150 ? 0.5 : 0.3;
    return cape * pblF * cinF;
}

function calcThetaE(tempC, dewC, p) {
    const T_K    = tempC + 273.15;
    const w      = mixingRatio(svp(dewC), p);
    const TLCL_K = (dewC + 273.15) - 0.212 * (tempC - dewC);
    return T_K * Math.pow(1000/p, 0.2854*(1-0.00028*w))
        * Math.exp((3.376/TLCL_K - 0.00254)*w*(1+0.00081*w));
}

function calcSHIP(hour) {
    const cape = hour.cape ?? 0, t500 = hour.temp500 ?? 0, shear = calcShear(hour);
    const mlMR = hour.mlMixRatio ?? 0, lapse = calcMidLapseRate(hour.temp700??0, hour.temp500??0);
    if (cape < 100 || t500 >= -5 || mlMR < 5 || shear < 7 || lapse < 5.5) return 0;
    return Math.max(0, (cape * mlMR * lapse * Math.abs(t500) * shear) / 28000000);
}

function categorizeRisk(prob) {
    const p = Math.max(0, Math.min(100, Math.round(prob ?? 0)));
    if (p >= 70) return { level: 3, label: 'high' };
    if (p >= 45) return { level: 2, label: 'moderate' };
    if (p >= 15) return { level: 1, label: 'tstorm' };
    return { level: 0, label: 'none' };
}

// ═══════════════════════════════════════════════════════════════════════════
// KERN: MULTIPLIKATIVES GEWITTERMODELL
//
// Architektur nach ESSL/ESTOFEX/AStrop v1.3 Prinzipien:
//
// P(Gewitter) = f_instabil × f_feuchte × f_ausloesung × f_organisation × f_saison
//
// Jeder Faktor ist [0, 1]. Ein einziger Faktor = 0 → P = 0.
// Keine additiven "Gates" mehr nötig. Physikalisch inkonsistente
// Modellprofile (GFS CIN=0 + LI=0 + DLS=3) werden automatisch durch
// schwache f_organisation (WMAXSHEAR niedrig) und f_instabil (LI≈0 → 0.5)
// auf ein realistisches Niveau reduziert.
//
// Quellen:
//   Rädler et al. 2018 (JAMC 57, 569-587) – AR-CHaMo Original
//   Battaglioli et al. 2023 (NHESS 23, 3651-3669) – AR-CHaMo ERA5
//   Taszarek et al. 2020 (MWR 148, 4775-4797) – Europa-Klimatologie
//   Púčik et al. 2015 (MWR 143, 4166-4188) – Severe Environments
//   ECMWF AStrop v1.3 – Multiplicative convective proxy framework
//   ESSL ESTOFEX methodology – Probabilistic outlook guidelines
// ═══════════════════════════════════════════════════════════════════════════
function calculateLightningProbability(hour) {
    const cape   = Math.max(0, hour.cape ?? 0);
    const li     = hour.liftedIndex ?? calcLiftedIndex(hour);
    const cin    = hour.cin ?? 0;
    const magCin = -Math.min(0, cin);
    const shear  = calcShear(hour);
    const meanRH = hour.meanRH ?? 50;
    const mlMR   = hour.mlMixRatio ?? 0;
    const q925   = hour.q925 ?? 0;
    const temp   = hour.temperature ?? 0;
    const dew    = hour.dew ?? 0;
    const wbz    = hour.wbzHeight ?? calcWBZHeight(hour);
    const pbl    = hour.pblHeight ?? 1000;
    const month  = new Date(hour.time).getMonth() + 1;

    // ── FAKTOR 1: Instabilität ────────────────────────────────────────────
    // Kernprädiktor nach Battaglioli 2023: MU LI
    // LI < 0 → instabil, LI > 3 → stabil, LI > 5 → sehr stabil
    // Saisonale Kalibrierung: Im Winter sind bereits LI < 1 konvektiv relevant
    // (Wintergewitter bei WBZ < 1000m, starker Scherung)
    const winterMode = month <= 3 || month >= 11; // Nov–Mär
    const springMode = month === 4 || month === 5 || month === 9 || month === 10;

    // LI-Schwelle: Im Winter schon bei LI < 2 relevant (flache Konvektion)
    const liThreshHigh = winterMode ? 1.5 : springMode ? 2.5 : 3.0; // ab hier stark gedämpft
    const liThreshLow  = winterMode ? -1.0 : springMode ? -2.0 : -3.0; // ab hier voll instabil

    // Instabilitätsfaktor: sigmoid zwischen liThreshHigh (→0) und liThreshLow (→1)
    const f_instabil = linNorm(li, liThreshHigh, liThreshLow);

    // CAPE-Zusatzfaktor: Verstärkt Signal bei vorhandenem CAPE
    // Logarithmisch sättigend (Westermayer 2017)
    const capeFactor = cape > 0 ? Math.min(1.0, Math.log1p(cape / 200) / Math.log1p(5)) : 0;

    // Kombinierter Instabilitätsfaktor: min. 30% aus LI alleine (für HSLC-Fälle)
    // Bei CAPE = 0 strikter: LI muss deutlich negativ sein
    const f_inst = cape < 50
        ? linNorm(li, liThreshHigh, liThreshLow - 1.0)  // strenger ohne CAPE
        : Math.max(f_instabil, capeFactor * 0.4) * (0.6 + 0.4 * capeFactor);

    // ── FAKTOR 2: Atmosphärische Feuchte ─────────────────────────────────
    // Battaglioli 2023: meanRH (850–500 hPa) ist zweitstärkster Prädiktor
    // + ML Mixing Ratio als Niedrigpegel-Feuchteindikator
    // + q925 spezifische Feuchte

    // Mittlere RH 850–500 hPa: < 40% → kaum Blitze (Rädler 2018)
    const f_meanRH = linNorm(meanRH, 35, 70);

    // ML Mixing Ratio: < 4 g/kg → trocken, > 8 g/kg → feucht
    // Saisonal: Im Winter reichen 3–5 g/kg für Konvektion
    const mrLow  = winterMode ? 2.0 : 4.0;
    const mrHigh = winterMode ? 6.0 : 9.0;
    const f_mlMR = linNorm(mlMR, mrLow, mrHigh);

    // Kombiniert: geometrisches Mittel bevorzugt konsistente Feuchteprofile
    const f_feuchte = Math.sqrt(f_meanRH * f_mlMR);

    // ── FAKTOR 3: Auslösung (CIN + PBL + Tagesgang) ──────────────────────
    // CIN: Haupthemmnis für Auslösung (Battaglioli 2023)
    // Bei starker PBL-Entwicklung oder Frontauslösung wird CIN überwunden
    // Frontauslösung: starke Scherung + zyklonale Feuchte → kein Tagesgang nötig
    const isFrontal = shear >= 12 && meanRH >= 65 && (hour.precip ?? 0) >= 30;

    // CIN-Faktor: 0 bei CIN < -200 J/kg, 1 bei CIN > -25 J/kg
    // Im Winter: CIN spielt kleinere Rolle (oft keine thermische Auslösung nötig)
    const cinLow  = winterMode ? -250 : -200;
    const cinHigh = winterMode ? -15  : -25;
    let f_cin = linNorm(cin, cinLow, cinHigh);

    // Bei frontaler Auslösung: CIN-Hemmnis reduziert
    if (isFrontal) f_cin = Math.max(f_cin, 0.5);

    // Tagesgang: Thermische Auslösung tagsüber, LLJ-Auslösung nachts
    const rad       = hour.directRadiation ?? 0;
    const isDay     = rad >= 150;
    const isNight   = rad < 20;
    const llj_night = (calcSRH(hour,'0-1km') >= 80) && shear >= 12;

    let f_tagesgang = 0.7; // Basiswert (Nacht ohne LLJ, früh morgens)
    if (isDay)            f_tagesgang = 0.7 + 0.3 * linNorm(rad, 150, 700);
    else if (llj_night)   f_tagesgang = 0.75; // LLJ-Nachtgewitter
    else if (isNight && !winterMode) f_tagesgang = 0.55;

    // Im Winter spielt Tagesgang kaum eine Rolle (frontale Systeme dominieren)
    if (winterMode) f_tagesgang = isFrontal ? 0.85 : 0.70;

    const f_ausloesung = f_cin * f_tagesgang;

    // ── FAKTOR 4: Organisation (Shear + WMAXSHEAR) ───────────────────────
    // DLS 925–500 hPa: Primärer Scherungsprädiktor in AR-CHaMo
    // Ohne ausreichende Scherung: nur schwache isolierte Konvektion möglich
    // WMAXSHEAR = kombinierter CAPE×Shear-Parameter (Übergang schwach→organisiert)

    const wmaxshear = calcWMAXSHEAR(cape, shear);

    // DLS-Faktor: < 5 m/s schwach, > 15 m/s organisiert
    // Im Winter: schon ab 8 m/s organisiert (flachere Gewitter)
    const shearLow  = winterMode ? 5.0  : 6.0;
    const shearHigh = winterMode ? 12.0 : 18.0;
    const f_shear = linNorm(shear, shearLow, shearHigh);

    // WMAXSHEAR-Faktor: < 200 schwach, > 600 stark
    const f_wms = linNorm(wmaxshear, 150, 550);

    // Organisations-Faktor: Maximum aus Shear und WMAXSHEAR
    // (entweder hohe Scherung ODER starkes CAPE×Shear reicht)
    const f_organisation = Math.max(f_shear, f_wms * 0.9);

    // ── FAKTOR 5: Saisonale Kalibrierung ─────────────────────────────────
    // Europa-Klimatologie (Taszarek 2020):
    // Sommer (Jun–Aug): hohe thermische Energie → moderate Schwellen
    // Frühling (Apr–Mai): steilere Lapserate begünstigt → leicht erhöht
    // Winter (Nov–Mär): hauptsächlich frontale HSLC-Gewitter → eigene Skalierung
    // Herbst (Sep–Okt): wie Frühling aber feuchter
    let f_saison;
    if      (month >= 6 && month <= 8)  f_saison = 1.00; // Sommer: Referenz
    else if (month === 5 || month === 9) f_saison = 0.90; // Mai/Sep
    else if (month === 4 || month === 10) f_saison = 0.80; // Apr/Okt
    else if (month === 3 || month === 11) f_saison = 0.70; // Mär/Nov
    else                                  f_saison = 0.60; // Dez/Jan/Feb: nur starke Fälle

    // ── WINTERGEWITTER-PFAD ────────────────────────────────────────────────
    // HSLC: High Shear Low CAPE (typisch Winter/Frühling Europa)
    // Quelle: Rädler 2018 – HSLC-Environments; ESSL Wintergewitter-Studie
    // Anforderungen: Scherung hoch, CAPE niedrig aber vorhanden, gute Feuchte
    const isHSLC = cape >= 30 && cape < 400 && shear >= 12 && meanRH >= 55;

    if (isHSLC && winterMode) {
        // Wintergewitter direkt berechnen: hauptsächlich scherungsgetrieben
        // WBZ < 1200m: günstiger für Wintergewitter (Schauer mit Graupel)
        const wbzBonus = wbz < 1200 ? 1.2 : wbz < 1800 ? 1.0 : 0.7;
        const shearScore = linNorm(shear, 12, 25);
        const moistScore = linNorm(meanRH, 55, 80);
        const instScore  = linNorm(li, 2.0, -1.0);
        const cinScore   = linNorm(cin, -150, -10);
        let pWinter = shearScore * moistScore * Math.max(instScore, 0.3) * cinScore * wbzBonus * 55;
        pWinter *= f_saison;
        return Math.min(60, Math.max(0, Math.round(pWinter)));
    }

    // ── ABSOLUTE MINDESTANFORDERUNGEN (vor jeder Berechnung) ─────────────
    // Diese Checks eliminieren physikalisch unmögliche Kombinationen.
    // Reihenfolge: von striktest nach laxest, Frühausstieg bevorzugt.

    // 1. Vollständig trockenes Profil → niemals Gewitter
    if (f_feuchte < 0.06) return 0;

    // 2. Vollständig stabile Atmosphäre → niemals Gewitter
    //    (im Wintermodus etwas laxer, da HSLC bereits abgefangen)
    if (f_inst < 0.06) return 0;

    // 3. CIN zu stark UND kein Frontalsystem UND kein starker Shear
    //    → Konvektion kann nicht ausgelöst werden
    //    Dies ist der Kern-Fix für GFS CIN=-180 + DLS=6 + LI=-0.5:
    //    CIN=-180 → f_cin ≈ 0.11, kein Frontal (shear<12), f_ausloesung ≈ 0.08
    //    → Produkt zu klein, aber sigmoid würde es noch strecken → hier stoppen
    if (magCin > 120 && !isFrontal && shear < 15) return 0;

    // 4. Kein CAPE + schwache Instabilität + schwache Scherung → kein Signal
    if (cape < 50 && li > 1.0 && shear < 10) return 0;

    // ── HAUPTBERECHNUNG: Multiplikatives Modell ───────────────────────────
    // Basiswahrscheinlichkeit = Produkt aller physikalischen Faktoren [0,1]
    const pBase = f_inst * f_feuchte * f_ausloesung * f_organisation * f_saison;

    // Produkt-Gate: Zu kleines Produkt bedeutet mehrere Faktoren gleichzeitig schwach
    // → kein konsistentes Gewitterprofil vorhanden
    // Schwelle 0.04: entspricht z.B. vier Faktoren à 0.45 (alle schwach)
    if (pBase < 0.04) return 0;

    // Transferfunktion: lineares Mapping pBase → Prozent
    // Kalibrierung (Taszarek 2020 / EUCLID-Verifikation):
    //   pBase = 0.04 →  0% (Mindestgrenze)
    //   pBase = 0.10 →  8%
    //   pBase = 0.20 → 18%
    //   pBase = 0.35 → 35%
    //   pBase = 0.55 → 60%
    //   pBase = 0.75 → 85%
    //   pBase = 0.90 → 95%
    // Sigmoid würde kleine Werte zu stark strecken → stattdessen power-Funktion:
    // p = 100 * (pBase / 0.9)^0.65  (sublinear, sättigt bei hohen Werten)
    const pRaw = 100 * Math.pow(Math.min(pBase, 0.9) / 0.9, 0.65);

    const p = Math.round(Math.max(0, Math.min(100, pRaw)));
    // Anzeige-Schwelle: < 5% → 0 (kein sinnvolles Signal)
    return p < 5 ? 0 : p;
}

// ═══════════════════════════════════════════════════════════════════════════
// HAGEL ≥ 2cm
// P(hail) = P(storm) × P(hail|storm)
// P(hail|storm) via SHIP (Johnson & Sugier 2014, ESSL-kalibriert)
// Modifiziert durch WBZ-Faktor (Battaglioli 2023) × MR-Faktor × DLS-Faktor
// ═══════════════════════════════════════════════════════════════════════════
function calculateHailProbability(hour, wmaxshear, dcape) {
    const thunderProb = calculateLightningProbability(hour);
    if (thunderProb < 15) return 0;

    const shear = calcShear(hour);
    const mlMR  = hour.mlMixRatio ?? 0;
    const wbz   = hour.wbzHeight ?? calcWBZHeight(hour);
    const ship  = calcSHIP(hour);

    let hailCond;
    if      (ship >= 4.0) hailCond = 0.95;
    else if (ship >= 3.0) hailCond = 0.80;
    else if (ship >= 2.0) hailCond = 0.60;
    else if (ship >= 1.5) hailCond = 0.45;
    else if (ship >= 1.0) hailCond = 0.30;
    else if (ship >= 0.5) hailCond = 0.15;
    else if (ship >= 0.2) hailCond = 0.06;
    else                  hailCond = 0;

    // WBZ-Faktor: optimal 800–2100m (Battaglioli 2023)
    const wbzF = wbz < 800 ? 0.5 : wbz <= 2100 ? 1.0 : wbz <= 2500 ? 0.80 : wbz <= 3000 ? 0.55 : wbz <= 3500 ? 0.30 : 0.10;
    const mrF  = mlMR >= 12 ? 1.15 : mlMR >= 8 ? 1.05 : mlMR < 5 ? 0.80 : mlMR < 4 ? 0.65 : 1.0;
    const dlsF = shear >= 20 ? 1.15 : shear >= 15 ? 1.08 : shear < 8 ? 0.75 : 1.0;

    return Math.min(100, Math.round(hailCond * wbzF * mrF * dlsF * (thunderProb / 100) * 100 * 0.8));
}

// ═══════════════════════════════════════════════════════════════════════════
// WIND ≥ 25 m/s
// P(wind) = P(storm) × P(wind|storm)
// Hauptprädiktoren: DCAPE × WMAXSHEAR × Trockenluft 700 hPa
// ═══════════════════════════════════════════════════════════════════════════
function calculateWindProbability(hour, wmaxshear, dcape) {
    const thunderProb = calculateLightningProbability(hour);
    if (thunderProb < 15) return 0;
    if (dcape < 200 && wmaxshear < 400) return 0;

    const cape     = hour.cape ?? 0;
    const shear    = calcShear(hour);
    const t700     = hour.temp700 ?? 0, d700 = hour.dew700 ?? 0;
    const t500     = hour.temp500 ?? 0;
    const meanRH   = hour.meanRH ?? 50;
    const pwat     = hour.pwat ?? 25;
    const lapse    = calcMidLapseRate(t700, t500);
    const dd700    = t700 - d700;

    // Multiplikativer Ansatz für Wind-Bedingungswahrscheinlichkeit:
    // Trockene Luft + starker Abstiegsantrieb + CAPE×Shear
    const f_dcape  = linNorm(dcape,  200, 1200);
    const f_wms    = linNorm(wmaxshear, 300, 1100);
    const f_dry700 = linNorm(dd700, 2, 18); // Trockene Einmischung 700 hPa
    const f_lapse  = linNorm(lapse, 5.5, 8.5);

    const pCond = f_dcape * f_wms * Math.max(f_dry700, f_lapse) * 0.85;
    const p = Math.round(pCond * (thunderProb / 100) * 90);
    return Math.min(100, Math.max(0, p));
}

// ═══════════════════════════════════════════════════════════════════════════
// TORNADO
// P(tornado) = P(storm ≥ Superzelle) × P(tornado|Superzelle)
// via STP (Europa-kalibriert, Púčik 2015)
// ═══════════════════════════════════════════════════════════════════════════
function stpToProb(stp) {
    // Europa-Kalibrierung (Púčik 2015, ESSL): deutlich konservativer als USA
    if (stp < 0.3) return 0;
    if (stp < 0.5) return 5;
    if (stp < 1.0) return 10;
    if (stp < 1.5) return 18;
    if (stp < 2.0) return 28;
    if (stp < 2.5) return 38;
    if (stp < 3.0) return 48;
    if (stp < 4.0) return 62;
    if (stp < 5.0) return 75;
    return 90;
}

function calculateTornadoProbability(hour, shear, srh3) {
    const thunderProb = calculateLightningProbability(hour);
    if (thunderProb < 50) return 0;

    const cape  = hour.cape ?? 0;
    const srh1  = calcSRH(hour, '0-1km');
    const stp   = calcSTP(hour, shear, srh1);
    const p     = stpToProb(stp);
    if (p < 10) return 0;
    return Math.round(p * 0.85 * (thunderProb / 100));
}