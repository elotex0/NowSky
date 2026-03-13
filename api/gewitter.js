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

            if (model === 'gfs_global') {
                hour.cin = rawCin !== null ? rawCin : calcCIN(hour, rawLI ?? 99);
            } else {
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
            hour.q925       = hour.mlMixRatio * 925 / (hour.mlMixRatio + 622);

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
            const entries = Object.entries(probsByModel).filter(([, p]) => p !== null);
            if (entries.length === 0) return { prob: 0, konsens: 'niedrig', stddev: 0 };

            const probs  = entries.map(([, p]) => p);
            const sorted = [...probs].sort((a, b) => a - b);
            const median = sorted.length % 2 === 1
                ? sorted[Math.floor(sorted.length / 2)]
                : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

            let ws = 0, tw = 0;
            for (const [model, prob] of entries) {
                let w = getModelWeight(model, lt);
                const abweichung = Math.abs(prob - median);
                const schwelle   = Math.max(2, median * 2);
                if (abweichung > schwelle) w *= 0.5;
                ws += prob * w;
                tw += w;
            }
            const mean = tw === 0 ? 0 : ws / tw;

            const variance = probs.reduce((s, p) => s + (p - mean) ** 2, 0) / probs.length;
            const stddev   = Math.sqrt(variance);

            const konsensFaktor = stddev <= 15
                ? 1.15 - (stddev / 15) * 0.15
                : 1.00 - ((stddev - 15) / 25) * 0.35;
            const kf = Math.max(0.65, Math.min(1.15, konsensFaktor));

            const prob = Math.round(Math.max(0, Math.min(100, mean * kf)));
            const konsens = stddev <= 10 ? 'hoch' : stddev <= 22 ? 'mittel' : 'niedrig';

            return { prob, konsens, stddev: Math.round(stddev * 10) / 10 };
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

            const gw = {};
            for (const model of MODELS) {
                const mh = modelHours[model];
                if (!mh) { gw[model] = null; continue; }
                gw[model] = calculateLightningProbability(mh);
            }

            const ens = ensembleProb(gw, lt);

            const vMH = Object.values(modelHours).filter(Boolean);

            // ── FIX 1: Ensemble-hour-Objekt für categorizeRisk ──────────────
            const ensHour = vMH.length > 0 ? {
                time:               t,
                cape:               ensembleMean(vMH.map(m => m.cape)),
                cin:                ensembleMean(vMH.map(m => m.cin ?? 0)),
                liftedIndex:        ensembleMean(vMH.map(m => m.liftedIndex ?? 0)),
                temperature:        ensembleMean(vMH.map(m => m.temperature)),
                dew:                ensembleMean(vMH.map(m => m.dew)),
                wind_speed_1000hPa: ensembleMean(vMH.map(m => m.wind_speed_1000hPa ?? 0)),
                wind_speed_975hPa:  ensembleMean(vMH.map(m => m.wind_speed_975hPa  ?? 0)),
                wind_speed_950hPa:  ensembleMean(vMH.map(m => m.wind_speed_950hPa  ?? 0)),
                wind_speed_925hPa:  ensembleMean(vMH.map(m => m.wind_speed_925hPa  ?? 0)),
                wind_speed_900hPa:  ensembleMean(vMH.map(m => m.wind_speed_900hPa  ?? 0)),
                wind_speed_850hPa:  ensembleMean(vMH.map(m => m.wind_speed_850hPa  ?? 0)),
                wind_speed_700hPa:  ensembleMean(vMH.map(m => m.wind_speed_700hPa  ?? 0)),
                wind_speed_500hPa:  ensembleMean(vMH.map(m => m.wind_speed_500hPa  ?? 0)),
                windDir1000:        ensembleMean(vMH.map(m => m.windDir1000 ?? 0)),
                windDir975:         ensembleMean(vMH.map(m => m.windDir975  ?? 0)),
                windDir950:         ensembleMean(vMH.map(m => m.windDir950  ?? 0)),
                windDir925:         ensembleMean(vMH.map(m => m.windDir925  ?? 0)),
                windDir900:         ensembleMean(vMH.map(m => m.windDir900  ?? 0)),
                windDir850:         ensembleMean(vMH.map(m => m.windDir850  ?? 0)),
                windDir700:         ensembleMean(vMH.map(m => m.windDir700  ?? 0)),
                windDir500:         ensembleMean(vMH.map(m => m.windDir500  ?? 0)),
            } : null;

            return {
                time:           t,
                probability:    ens.prob,
                modell_konsens: ens.konsens,
                modell_stddev:  ens.stddev,
                modell_probs:   gw,
                ensHour,
                temperature: Math.round(ensembleMean(vMH.map(m => m.temperature)) * 10) / 10,
                cape:        Math.round(ensembleMean(vMH.map(m => m.cape))),
                shear:       Math.round(ensembleMean(vMH.map(m => calcShear(m))) * 10) / 10,
                srh:         Math.round(ensembleMean(vMH.map(m => calcSRH(m, '0-3km'))) * 10) / 10,
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
                daysMap.set(dp, { date: dp, maxProbability: h.probability, peakKonsens: h.modell_konsens, peakStddev: h.modell_stddev, ensHour: h.ensHour });
            } else {
                const d = daysMap.get(dp);
                if (h.probability > d.maxProbability) {
                    d.maxProbability = h.probability;
                    d.peakKonsens    = h.modell_konsens;
                    d.peakStddev     = h.modell_stddev;
                    d.ensHour        = h.ensHour;
                }
            }
        });

        // ── FIX 2: categorizeRisk mit ensHour aufrufen ──────────────────────
        const stunden = nextHours.map(h => ({
            timestamp:      h.time,
            gewitter:       h.probability,
            gewitter_risk:  categorizeRisk(h.probability, h.ensHour),
            modell_konsens: h.modell_konsens,
            modell_stddev:  h.modell_stddev,
            modell_probs:   h.modell_probs,
        }));

        const tage = Array.from(daysMap.values()).sort((a, b) => a.date.localeCompare(b.date)).map(day => ({
            date:           day.date,
            gewitter:       day.maxProbability,
            gewitter_risk:  categorizeRisk(day.maxProbability, day.ensHour),
            modell_konsens: day.peakKonsens,
            modell_stddev:  day.peakStddev,
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
                const lcl    = calcLCLHeight(mh.temperature, mh.dew);
                const ki     = calcKIndex(mh);
                const si     = calcShowalter(mh);
                const midLap = calcMidLapseRate(mh.temp700, mh.temp500);
                // ── FIX 3: calcSCP korrekt aufrufen (4 Parameter, shear in m/s) ──
                const shearMS = shear / 3.6;
                const scpVal  = calcSCP(mh.cape, shearMS, srh3, mh.cin ?? 0);
                const ehiVal  = calcEHI(mh);
                const stpVal  = calcSTP(mh);
                perModel[model] = {
                    archamo_li:       Math.round(mh.liftedIndex * 10) / 10,
                    archamo_dls:      Math.round(shear * 10) / 10,
                    archamo_meanRH:   Math.round(mh.meanRH),
                    archamo_q925:     Math.round(mh.q925 * 10) / 10,
                    archamo_mlMR:     Math.round(mh.mlMixRatio * 10) / 10,
                    archamo_wbz:      Math.round(mh.wbzHeight),
                    archamo_cape:     Math.round(mh.cape),
                    archamo_flHeight: Math.round(mh.freezingLevel),
                    scp: Math.round(scpVal * 100) / 100,
                    ehi: Math.round(ehiVal * 100) / 100,
                    stp: Math.round(stpVal * 100) / 100,
                    gewitter: calculateLightningProbability(mh),
                    cape: Math.round(mh.cape), cin: Math.round(mh.cin ?? 0),
                    lcl: Math.round(lcl),
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
            return {
                timestamp:         h.time,
                ensemble_gewitter: h.probability,
                modell_konsens:    h.modell_konsens,
                modell_stddev:     h.modell_stddev,
                modell_probs:      h.modell_probs,
                per_modell:        perModel,
            };
        });

        return res.status(200).json({
            timezone, region, stunden, tage,
            debug: {
                hinweis: 'AR-CHaMo v2 Methodik: Rädler 2018 + Battaglioli 2023 + ESSL/ESTOFEX/AStrop-Ansatz. Multiplikatives Gating statt additiver Scores. Alle Jahreszeiten kalibriert. Ensemble: Ausreißer-Dämpfung (>2× Median → halbes Gewicht) + Konsens-Faktor (σ=0: +15%, σ=15: neutral, σ≥30: -25%).',
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
    return 6.112 * Math.exp((17.67 * T) / (T + 243.5));
}

function mixingRatio(e, p) {
    return 1000 * 0.622 * e / (p - e);
}

function linNorm(value, low, high) {
    if (high === low) return value >= high ? 1 : 0;
    return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

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

function calcCIN(hour, rawLI = 99) {
    const t2m  = hour.temperature ?? 0;
    const d2m  = hour.dew        ?? t2m - 10;
    const t850 = hour.temp850    ?? 0;
    const t700 = hour.temp700    ?? 0;
    const t925 = hour.temp925    ?? (t2m * 0.4 + t850 * 0.6);
    const d925 = hour.dew925     ?? d2m;
    const d850 = hour.dew850     ?? d2m;
    const d700 = hour.dew700     ?? d2m;

    function T_v(T_c, dew_c, p_hPa) {
        const e  = svp(dew_c);
        const w  = 0.622 * e / (p_hPa - e);
        return (T_c + 273.15) * (1 + 0.608 * w);
    }

    function T_v_parcel(T_p_c, p_hPa) {
        const ws = 0.622 * svp(T_p_c) / (p_hPa - svp(T_p_c));
        return (T_p_c + 273.15) * (1 + 0.608 * ws);
    }

    const dd2m    = t2m - d2m;
    const T_LCL   = t2m - 0.212 * dd2m - 0.001 * dd2m * dd2m;
    const z_LCL   = Math.max(0, 125 * dd2m);
    const TLCL_K  = T_LCL + 273.15;
    const w2m     = mixingRatio(svp(d2m), 1013.25) / 1000;
    const theta_e = (t2m + 273.15)
        * Math.pow(1000 / 1013.25, 0.2854 * (1 - 0.00028 * w2m * 1000))
        * Math.exp((3.376 / TLCL_K - 0.00254) * w2m * 1000 * (1 + 0.00081 * w2m * 1000));

    function parcelTemp(p_hPa, T_first_guess) {
        let Tp = T_first_guess;
        for (let n = 0; n < 30; n++) {
            const Tp_K = Tp + 273.15;
            const ws   = mixingRatio(svp(Tp), p_hPa) / 1000;
            const te   = Tp_K
                * Math.pow(1000 / p_hPa, 0.2854 * (1 - 0.00028 * ws * 1000))
                * Math.exp((3.376 / Tp_K - 0.00254) * ws * 1000 * (1 + 0.00081 * ws * 1000));
            const d = (theta_e - te) * 0.25;
            Tp += d;
            if (Math.abs(d) < 0.001) break;
        }
        return Tp;
    }

    const DALR = 9.8;
    function parcelTempDry(z_m) {
        return t2m - DALR * (z_m / 1000);
    }

    const levels = [
        { z:    0, p: 1013.25, T_env: t2m,  dew_env: d2m  },
        { z:  762, p:  925,    T_env: t925, dew_env: d925 },
        { z: 1457, p:  850,    T_env: t850, dew_env: d850 },
        { z: 3012, p:  700,    T_env: t700, dew_env: d700 },
    ];

    const parcels = levels.map(lv => {
        let Tp_c;
        if (lv.z <= z_LCL) {
            Tp_c = parcelTempDry(lv.z);
        } else {
            const dz_from_LCL = lv.z - z_LCL;
            const guess = T_LCL - 6.0 * (dz_from_LCL / 1000);
            Tp_c = parcelTemp(lv.p, guess);
        }
        return Tp_c;
    });

    const g = 9.81;
    const buoyancy = levels.map((lv, i) => {
        const tv_p = T_v_parcel(parcels[i], lv.p);
        const tv_e = T_v(lv.T_env, lv.dew_env, lv.p);
        return g * (tv_p - tv_e) / tv_e;
    });

    let cin = 0;
    for (let i = 0; i < levels.length - 1; i++) {
        const b1 = buoyancy[i];
        const b2 = buoyancy[i + 1];
        const dz = levels[i + 1].z - levels[i].z;

        if (b1 <= 0 && b2 <= 0) {
            cin += 0.5 * (b1 + b2) * dz;
        } else if (b1 < 0 && b2 > 0) {
            const frac = b1 / (b1 - b2);
            cin += 0.5 * b1 * (frac * dz);
        } else if (b1 > 0 && b2 < 0) {
            const frac = b1 / (b1 - b2);
            cin += 0.5 * b2 * ((1 - frac) * dz);
        }
    }

    return Math.round(Math.max(-500, Math.min(0, cin)));
}

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

function calcLCLHeight(temp, dew) {
    return Math.max(0, 125 * Math.max(0, temp - dew));
}

function calcMidLapseRate(t700, t500) {
    return (t700 - t500) / 2.5;
}

function calcKIndex(hour) {
    return ((hour.temp850??0) - (hour.temp500??0)) + (hour.dew850??0) - ((hour.temp700??0) - (hour.dew700??0));
}

function calcShowalter(hour) {
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

function calcSTP(hour) {
    const cape = hour.cape ?? 0;
    if (cape < 100) return 0;

    const cin = hour.cin ?? calcCIN(hour);

    // Windgeschwindigkeiten km/h → m/s
    const ws10  = (hour.wind          ?? 0) / 3.6;
    const ws925 = (hour.wind_speed_925hPa ?? 0) / 3.6;
    const ws850 = (hour.wind_speed_850hPa ?? 0) / 3.6;
    const ws500 = (hour.wind_speed_500hPa ?? 0) / 3.6;

    const wd925 = hour.windDir925 ?? 0;
    const wd850 = hour.windDir850 ?? 0;

    // EBWD: vektorielle Scherung 925–500 hPa in m/s
    const du   = ws500 * Math.cos(wd850 * Math.PI / 180) - ws925 * Math.cos(wd925 * Math.PI / 180);
    const dv   = ws500 * Math.sin(wd850 * Math.PI / 180) - ws925 * Math.sin(wd925 * Math.PI / 180);
    const ebwd = Math.sqrt(du * du + dv * dv);

    // SRH-Näherung in m²/s² (ws bereits in m/s)
    const srh = Math.max(0, ((ws925 - ws10) * 50 + (ws850 - ws10) * 30));

    const t2m        = hour.temperature ?? 15;
    const td2m       = hour.dew ?? 5;
    const lcl_height = Math.max(0, (t2m - td2m) * 122);

    const cape_term = Math.min(cape / 1500, 1.5);
    const srh_term  = Math.min(srh / 150, 3.0);
    const ebwd_term = ebwd >= 12 ? Math.min(ebwd / 12, 1.5) : ebwd / 12;
    const lcl_term  = lcl_height <= 1000 ? 1.0 : Math.max(0, (2000 - lcl_height) / 1000);
    const cin_term  = cin >= -50 ? 1.0 : cin <= -200 ? 0 : (cin + 200) / 150;

    const stp = cape_term * srh_term * ebwd_term * lcl_term * cin_term;
    return Math.round(stp * 100) / 100;
}

// FIX: shear erwartet m/s — Aufrufer muss calcShear(hour) / 3.6 übergeben
function calcSCP(cape, shearMS, srh, cin) {
    if (cape < 100 || shearMS < 12.5 || srh < 40) return 0;
    const magCin = -Math.min(0, cin);
    const cinT   = magCin < 40 ? 1.0 : Math.max(0.1, 1 - (magCin-40)/200);
    return Math.max(0, (cape/1000) * Math.min(srh/50,4) * Math.min(shearMS/12,1.5) * cinT);
}

function calcEHI(hour) {
    const cape = hour.cape ?? 0;
    const srh1 = calcSRH(hour, '0-1km');
    return Math.max(0, (cape * srh1) / 160000);
}

function categorizeRisk(prob, hour = null) {
    const p = Math.max(0, Math.min(100, Math.round(prob ?? 0)));

    if (!hour) {
        if (p >= 70) return { level: 5, label: 'high' };
        if (p >= 55) return { level: 4, label: 'moderate' };
        if (p >= 35) return { level: 3, label: 'enhanced' };
        if (p >= 20) return { level: 2, label: 'slight' };
        if (p >=  5) return { level: 1, label: 'marginal' };
        return       { level: 0, label: 'none' };
    }

    // FIX: calcSCP korrekt mit 4 Parametern + shear in m/s aufrufen
    const shearMS = calcShear(hour) / 3.6;
    const srh3    = calcSRH(hour, '0-3km');
    const scp     = calcSCP(hour.cape ?? 0, shearMS, srh3, hour.cin ?? 0);
    const ehi     = calcEHI(hour);
    const stp     = calcSTP(hour);
    const cape    = hour.cape ?? 0;

    if (p >= 60 && (scp >= 4 || ehi >= 2.5))                                 return { level: 5, label: 'high',     scp, ehi, stp };
    if (p >= 70)                                                               return { level: 5, label: 'high',     scp, ehi, stp };
    if (p >= 45 && (scp >= 2 || ehi >= 1.5 || (cape >= 1500 && shearMS >= 15))) return { level: 4, label: 'moderate', scp, ehi, stp };
    if (p >= 60)                                                               return { level: 4, label: 'moderate', scp, ehi, stp };
    if (p >= 30 && (scp >= 1 || ehi >= 0.8 || cape >= 800))                   return { level: 3, label: 'enhanced', scp, ehi, stp };
    if (p >= 45)                                                               return { level: 3, label: 'enhanced', scp, ehi, stp };
    if (p >= 15 && (scp >= 0.3 || cape >= 300 || shearMS >= 10))              return { level: 2, label: 'slight',   scp, ehi, stp };
    if (p >= 30)                                                               return { level: 2, label: 'slight',   scp, ehi, stp };
    if (p >=  5)                                                               return { level: 1, label: 'marginal', scp, ehi, stp };

    return { level: 0, label: 'none', scp, ehi, stp };
}

// ═══════════════════════════════════════════════════════════════════════════
// KERN: MULTIPLIKATIVES GEWITTERMODELL (AR-CHaMo v2)
// ═══════════════════════════════════════════════════════════════════════════
function calculateLightningProbability(hour) {
    const cape   = Math.max(0, hour.cape ?? 0);
    const li     = hour.liftedIndex ?? calcLiftedIndex(hour);
    const cin    = hour.cin ?? 0;
    const magCin = -Math.min(0, cin);
    const shear  = calcShear(hour);
    const meanRH = hour.meanRH ?? 50;
    const mlMR   = hour.mlMixRatio ?? 0;
    const wbz    = hour.wbzHeight ?? calcWBZHeight(hour);
    const month  = new Date(hour.time).getMonth() + 1;

    const winterMode = month <= 3 || month >= 11;
    const springMode = month === 4 || month === 5 || month === 9 || month === 10;

    const liThreshHigh = winterMode ? 1.5 : springMode ? 2.5 : 3.0;
    const liThreshLow  = winterMode ? -1.0 : springMode ? -2.0 : -3.0;

    const f_instabil = linNorm(li, liThreshHigh, liThreshLow);
    const capeFactor = cape > 0 ? Math.min(1.0, Math.log1p(cape / 200) / Math.log1p(5)) : 0;

    const f_inst = cape < 50
        ? linNorm(li, liThreshHigh, liThreshLow - 1.0)
        : Math.max(f_instabil, capeFactor * 0.4) * (0.6 + 0.4 * capeFactor);

    const f_meanRH = linNorm(meanRH, 35, 70);
    const mrLow  = winterMode ? 2.0 : 4.0;
    const mrHigh = winterMode ? 6.0 : 9.0;
    const f_mlMR = linNorm(mlMR, mrLow, mrHigh);
    const f_feuchte = Math.sqrt(f_meanRH * f_mlMR);

    const isFrontal = shear >= 12 && meanRH >= 65 && (hour.precip ?? 0) >= 30;

    const cinLow  = winterMode ? -250 : -200;
    const cinHigh = winterMode ? -15  : -25;
    let f_cin = linNorm(cin, cinLow, cinHigh);
    if (isFrontal) f_cin = Math.max(f_cin, 0.5);

    const rad       = hour.directRadiation ?? 0;
    const isDay     = rad >= 150;
    const isNight   = rad < 20;
    const llj_night = (calcSRH(hour,'0-1km') >= 80) && shear >= 12;

    let f_tagesgang = 0.7;
    if (isDay)            f_tagesgang = 0.7 + 0.3 * linNorm(rad, 150, 700);
    else if (llj_night)   f_tagesgang = 0.75;
    else if (isNight && !winterMode) f_tagesgang = 0.55;

    if (winterMode) f_tagesgang = isFrontal ? 0.85 : 0.70;

    const f_ausloesung = f_cin * f_tagesgang;

    const wmaxshear = calcWMAXSHEAR(cape, shear);
    const shearLow  = winterMode ? 5.0  : 6.0;
    const shearHigh = winterMode ? 12.0 : 18.0;
    const f_shear = linNorm(shear, shearLow, shearHigh);
    const f_wms = linNorm(wmaxshear, 150, 550);
    const f_organisation = Math.max(f_shear, f_wms * 0.9);

    let f_saison;
    if      (month >= 6 && month <= 8)   f_saison = 1.00;
    else if (month === 5 || month === 9)  f_saison = 0.90;
    else if (month === 4 || month === 10) f_saison = 0.80;
    else if (month === 3 || month === 11) f_saison = 0.70;
    else                                  f_saison = 0.60;

    const isHSLC = cape >= 30 && cape < 400 && shear >= 12 && meanRH >= 55;
    if (isHSLC && winterMode) {
        const wbzBonus = wbz < 1200 ? 1.2 : wbz < 1800 ? 1.0 : 0.7;
        const shearScore = linNorm(shear, 12, 25);
        const moistScore = linNorm(meanRH, 55, 80);
        const instScore  = linNorm(li, 2.0, -1.0);
        const cinScore   = linNorm(cin, -150, -10);
        let pWinter = shearScore * moistScore * Math.max(instScore, 0.3) * cinScore * wbzBonus * 55;
        pWinter *= f_saison;
        return Math.min(60, Math.max(0, Math.round(pWinter)));
    }

    if (f_feuchte < 0.06) return 0;
    if (f_inst < 0.06) return 0;
    if (magCin > 120 && !isFrontal && shear < 15) return 0;
    if (cape < 50 && li > 1.0 && shear < 10) return 0;

    const pBase = f_inst * f_feuchte * f_ausloesung * f_organisation * f_saison;
    if (pBase < 0.04) return 0;

    const pRaw = 100 * Math.pow(Math.min(pBase, 0.9) / 0.9, 0.65);
    const p = Math.round(Math.max(0, Math.min(100, pRaw)));
    return p < 5 ? 0 : p;
}

function calcWMAXSHEAR(cape, shear) {
    return (cape > 0 && shear > 0) ? Math.round(Math.sqrt(2*cape) * shear * 3.6) : 0;
}