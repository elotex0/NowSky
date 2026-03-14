// ═══════════════════════════════════════════════════════════════════════════
// AR-CHaMo v3 – Europäisches Gewittermodell
// Wissenschaftliche Grundlage:
//   • Rädler et al. 2018 (J. Appl. Meteor. Climatol.)
//   • Battaglioli et al. 2023 (NHESS – ARlig/ARhail)
//   • Taszarek et al. 2020 (J. Climate – EU/US-Klimatologie)
//   • Taszarek et al. 2017 (MWR – Proximity Soundings Europa)
//   • Matczak et al. 2026 (GRL – Pre/Post-Konvektiv, Zentraleuropa)
//   • Westermayer et al. 2017 (EL-Temperatur-Gate)
//   • ESTOFEX-Methodik (HSLC-Wintergewitter)
//
// Kernverbesserungen gegenüber v2:
//   1. Additive logistische Regression statt rein multiplikativer Gates
//      → kein vollständiges Blocken bei kleinem CAPE oder schwachem Shear
//   2. Europa-spezifisches CIN-Regime: niedrige CIN → hohe Auslöseeffizienz
//   3. EL-Temperatur als Sekundärprädikator (Westermayer 2017)
//   4. q925 (spezif. Feuchte 925 hPa) als eigenständiger Feuchteprädikator
//   5. Konvektiver Niederschlag (precipAcc) als direktes Konvektionssignal
//   6. HSLC-Winterpfad vollständig überarbeitet (frontale Scherung)
//   7. Schwellenwerte und Skalierung nach europäischer Klimatologie
// ═══════════════════════════════════════════════════════════════════════════

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
            // Spezifische Feuchte 925 hPa (ARlig-Prädikator nach Battaglioli 2023)
            hour.q925 = calcSpecificHumidity(hour.dew925, 925);

            // WBZ und meanRH
            hour.wbzHeight = calcWBZHeight(hour);
            // Mittlere RH 850–500 hPa (Battaglioli 2023 Schlüsselprädikator)
            hour.meanRH = (hour.rh850 + hour.rh700 + hour.rh500) / 3;

            // EL-Temperatur (Westermayer 2017: Lightning wahrscheinlicher wenn EL < -10°C)
            hour.elTemp = calcELTemperature(hour);

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
                const shearMS = shear / 3.6;
                const scpVal  = calcSCP(mh.cape, shearMS, srh3, mh.cin ?? 0);
                const ehiVal  = calcEHI(mh);
                const stpVal  = calcSTP(mh);
                perModel[model] = {
                    // AR-CHaMo v3 Kernprädiktoren (Battaglioli 2023)
                    archamo_li:       Math.round(mh.liftedIndex * 10) / 10,
                    archamo_dls:      Math.round(shear * 10) / 10,
                    archamo_meanRH:   Math.round(mh.meanRH),
                    archamo_q925:     Math.round(mh.q925 * 10) / 10,
                    archamo_mlMR:     Math.round(mh.mlMixRatio * 10) / 10,
                    archamo_wbz:      Math.round(mh.wbzHeight),
                    archamo_cape:     Math.round(mh.cape),
                    archamo_flHeight: Math.round(mh.freezingLevel),
                    archamo_elTemp:   Math.round((mh.elTemp ?? -99) * 10) / 10,
                    scp: Math.round(scpVal * 100) / 100,
                    ehi: Math.round(ehiVal * 100) / 100,
                    stp: Math.round(stpVal * 100) / 100,
                    gewitter: calculateLightningProbability(mh),
                    // Detailfelder
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
                hinweis: 'AR-CHaMo v3 Methodik: Rädler 2018 + Battaglioli 2023 (ARlig) + Taszarek 2020 + Matczak 2026. ' +
                    'Additive logistische Regression (kein hartes CAPE/Shear-Blocking). ' +
                    'Europa-spezifisches CIN-Regime (niedriger CIN → hohe Auslöseeffizienz). ' +
                    'EL-Temperatur-Gate (Westermayer 2017). ' +
                    'HSLC-Winterpfad mit Frontalscherung. ' +
                    'Ensemble: Ausreißer-Dämpfung (>2× Median → halbes Gewicht) + Konsens-Faktor.',
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

// Spezifische Feuchte [g/kg] (Battaglioli 2023 ARlig-Prädikator)
function calcSpecificHumidity(dewC, p_hPa) {
    const e = svp(dewC);
    const w = 0.622 * e / (p_hPa - e); // Mischungsverhältnis kg/kg
    return 1000 * w / (1 + w);          // g/kg
}

function linNorm(value, low, high) {
    if (high === low) return value >= high ? 1 : 0;
    return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

// EL-Temperatur schätzen (Westermayer 2017: Lightning wahrscheinlicher bei EL < -10°C)
// Wir nähern EL-Temp über 500-hPa-Temperatur als Proxy (typisch ~-20 bis -45°C)
function calcELTemperature(hour) {
    // Wenn CAPE > 0, ist EL oberhalb von 500 hPa → nutze 500-hPa-Temp als obere Grenze
    // Bei niedriger Energie kann EL im 700-hPa-Bereich liegen
    const cape = hour.cape ?? 0;
    if (cape < 10) return hour.temp700 ?? -15;  // bei sehr wenig CAPE: EL tief
    if (cape < 100) return (hour.temp700 + hour.temp500) / 2; // EL zwischen 700 und 500 hPa
    // Bei mehr CAPE: EL deutlich im 500-hPa-Bereich oder höher
    const elEst = hour.temp500 - Math.min(10, cape / 200);
    return Math.min(-5, elEst); // EL nie wärmer als -5°C wenn CAPE>0
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
    const ws10  = (hour.wind          ?? 0) / 3.6;
    const ws925 = (hour.wind_speed_925hPa ?? 0) / 3.6;
    const ws850 = (hour.wind_speed_850hPa ?? 0) / 3.6;
    const ws500 = (hour.wind_speed_500hPa ?? 0) / 3.6;
    const wd925 = hour.windDir925 ?? 0;
    const wd850 = hour.windDir850 ?? 0;
    const du   = ws500 * Math.cos(wd850 * Math.PI / 180) - ws925 * Math.cos(wd925 * Math.PI / 180);
    const dv   = ws500 * Math.sin(wd850 * Math.PI / 180) - ws925 * Math.sin(wd925 * Math.PI / 180);
    const ebwd = Math.sqrt(du * du + dv * dv);
    const srh = Math.max(0, ((ws925 - ws10) * 50 + (ws850 - ws10) * 30));
    const t2m        = hour.temperature ?? 15;
    const td2m       = hour.dew ?? 5;
    const lcl_height = Math.max(0, (t2m - td2m) * 122);
    const cape_term = Math.min(cape / 1500, 1.5);
    const srh_term  = Math.min(srh / 150, 3.0);
    const ebwd_term = ebwd >= 12 ? Math.min(ebwd / 12, 1.5) : ebwd / 12;
    const lcl_term  = lcl_height <= 1000 ? 1.0 : Math.max(0, (2000 - lcl_height) / 1000);
    const cin_term  = cin >= -50 ? 1.0 : cin <= -200 ? 0 : (cin + 200) / 150;
    return Math.round(cape_term * srh_term * ebwd_term * lcl_term * cin_term * 100) / 100;
}

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

function calcWMAXSHEAR(cape, shear) {
    return (cape > 0 && shear > 0) ? Math.round(Math.sqrt(2*cape) * shear * 3.6) : 0;
}

function categorizeRisk(prob, hour = null) {
    const p = Math.max(0, Math.min(100, Math.round(prob ?? 0)));

    if (!hour) {
        if (p >= 70) return { level: 5, label: 'high' };
        if (p >= 55) return { level: 4, label: 'moderate' };
        if (p >= 40) return { level: 3, label: 'enhanced' };
        if (p >= 20) return { level: 2, label: 'slight' };
        if (p >=  5) return { level: 1, label: 'marginal' };
        return       { level: 0, label: 'none' };
    }

    const shearMS = calcShear(hour) / 3.6;
    const srh3    = calcSRH(hour, '0-3km');
    const srh1    = calcSRH(hour, '0-1km');
    const scp     = calcSCP(hour.cape ?? 0, shearMS, srh3, hour.cin ?? 0);
    const ehi     = calcEHI(hour);
    const stp     = calcSTP(hour);
    const cape    = hour.cape ?? 0;

    if (p >= 60 && (scp >= 8 || ehi >= 3.0 || stp >= 4.0))
        return { level: 5, label: 'high', scp, ehi, stp };

    if (p >= 45 && (scp >= 4 || ehi >= 2.0 || stp >= 2.0 || (cape >= 2000 && shearMS >= 18 && srh3 >= 150)))
        return { level: 4, label: 'moderate', scp, ehi, stp };

    if (p >= 35 && (scp >= 2 || ehi >= 1.0 || stp >= 1.0 || (cape >= 1000 && shearMS >= 15 && srh3 >= 100)))
        return { level: 3, label: 'enhanced', scp, ehi, stp };

    if (p >= 20 && (scp >= 0.5 || ehi >= 0.3 || stp >= 0.2 || (cape >= 500 && shearMS >= 12 && srh3 >= 60)))
        return { level: 2, label: 'slight', scp, ehi, stp };

    if (p >= 5)
        return { level: 1, label: 'marginal', scp, ehi, stp };

    return { level: 0, label: 'none', scp, ehi, stp };
}


// ═══════════════════════════════════════════════════════════════════════════
// KERN: AR-CHaMo v3 – ADDITIVE LOGISTISCHE REGRESSION für Europa
//
// Wissenschaftliche Grundlage:
//   Battaglioli et al. 2023 (NHESS): ARlig-Prädiktoren:
//     - MUCAPE (→ unsere cape)
//     - 925–500 hPa Bulk Shear (→ calcShear)
//     - ML Mixing Ratio (→ mlMixRatio)
//     - Most Unstable Lifted Index (→ liftedIndex)
//     - Mittlere RH 850–500 hPa (→ meanRH)
//     - Spezifische Feuchte 925 hPa (→ q925)
//     - Konvektiver Niederschlag (→ precipAcc)
//
//   Europa-Anpassungen (Taszarek 2020, Matczak 2026):
//     - Niedrigerer CIN → höhere Auslöseeffizienz als USA
//     - LI robustester Einzel-Prädikator (Matczak 2026)
//     - EL-Temperatur < -10°C (Westermayer 2017)
//     - HSLC-Wintergewitter mit Frontalscherung
//
// KERNANSATZ: Additive logistische Funktion
//   logit(p) = β₀ + β_cape*f(CAPE) + β_li*f(LI) + β_rh*f(meanRH)
//              + β_mr*f(mlMR) + β_q925*f(q925) + β_shear*f(shear)
//              + β_cin*f(CIN_eu) + β_el*f(EL-Temp)
//              + β_precip*f(precipAcc)
//   P = sigmoid(logit) × Tagesgang-Faktor × Saison-Faktor
// ═══════════════════════════════════════════════════════════════════════════

function calculateLightningProbability(hour) {
    const cape   = Math.max(0, hour.cape ?? 0);
    const li     = hour.liftedIndex ?? calcLiftedIndex(hour);
    const cin    = hour.cin ?? 0;
    const shear  = calcShear(hour);       // km/h, 925–500 hPa
    const shearMS = shear / 3.6;          // m/s
    const meanRH = hour.meanRH ?? 50;     // mittlere RH 850–500 hPa
    const mlMR   = hour.mlMixRatio ?? 0;  // ML Mixing Ratio [g/kg]
    const q925   = hour.q925 ?? 0;        // spezif. Feuchte 925 hPa [g/kg]
    const wbz    = hour.wbzHeight ?? calcWBZHeight(hour);
    const precipAcc = hour.precipAcc ?? 0; // stündlicher Niederschlag [mm]
    const month  = new Date(hour.time).getMonth() + 1;
    const elTemp = hour.elTemp ?? calcELTemperature(hour);

    const winterMode = month <= 3 || month >= 11;
    const springMode = month === 4 || month === 5 || month === 9 || month === 10;
    const summerMode = month >= 6 && month <= 8;

    // ─────────────────────────────────────────────────────────────────────
    // PRÄPRÜFUNG: Vollständig stabile Atmosphäre (kein MUCAPE, stark pos. LI)
    // Wichtig: Europa hat niedrigen CIN → CIN allein blockt NICHT
    // ─────────────────────────────────────────────────────────────────────
    if (cape < 5 && li > 3.5) return 0;
    // Sehr trockene Atmosphäre ohne jegliches Konvektionspotential
    if (meanRH < 20 && mlMR < 1.5 && cape < 20) return 0;

    // ─────────────────────────────────────────────────────────────────────
    // SAISON-FAKTOR (kalibriert auf europäische Klimatologie)
    // Taszarek et al. 2020: Hauptsaison Juni–August, Minimum Winter
    // ─────────────────────────────────────────────────────────────────────
    const f_saison = summerMode ? 1.00
        : (month === 5 || month === 9)  ? 0.88
        : (month === 4 || month === 10) ? 0.75
        : (month === 3 || month === 11) ? 0.65
        : 0.55;

    // ─────────────────────────────────────────────────────────────────────
    // HSLC-WINTERPFAD (High Shear Low CAPE)
    // Typisch für frontale Wintergewitter in Europa
    // Kalibriert nach ESTOFEX-Methodik + Matczak 2026 (Kaltumgebung)
    // ─────────────────────────────────────────────────────────────────────
    const midLap = calcMidLapseRate(hour.temp700, hour.temp500);
    const isHSLC = cape >= 15 && cape < 400 && shear >= 15 && meanRH >= 55;

    if (isHSLC && (winterMode || springMode)) {
        // EL-Temperatur Gate: Westermayer 2017
        if (li > 2.5 && elTemp > -5) return 0;  // zu stabil, EL zu warm
        // Muss labile Mittelschicht haben (midLapse > 5.5°C/km)
        if (midLap < 5.0 && li > 1.5) return 0;

        // Scherung 925–500 hPa als Hauptprädikator (Matczak 2026: Kaltumgebung)
        const shearScore  = linNorm(shear, 15, 30);       // 15–30 km/h normiert
        const moistScore  = linNorm(meanRH, 55, 85);
        const instScore   = linNorm(li, 2.5, -2.0);       // LI: robustester Prädikator
        const elScore     = linNorm(elTemp, -5, -25);     // EL kälter = besser
        // CIN bei Frontalgewitter weniger hemmend (Matczak 2026)
        const isFrontal   = shearMS >= 10 && meanRH >= 65 && precipAcc >= 0.05;
        const cinScore    = isFrontal ? Math.max(0.5, linNorm(cin, -200, -10))
                                      : linNorm(cin, -150, -10);
        const wbzBonus    = wbz < 1200 ? 1.25 : wbz < 1800 ? 1.0 : 0.75;
        const precipBonus = precipAcc > 0.1 ? 1.2 : precipAcc > 0.02 ? 1.1 : 1.0;

        let pHSLC = shearScore * moistScore * instScore * elScore * cinScore * wbzBonus * precipBonus * 65;
        pHSLC *= f_saison;
        const result = Math.min(65, Math.max(0, Math.round(pHSLC)));
        return result < 5 ? 0 : result;
    }

    // ─────────────────────────────────────────────────────────────────────
    // HAUPTPFAD: ADDITIVE LOGISTISCHE REGRESSION (AR-CHaMo v3)
    //
    // Basierend auf Battaglioli 2023 (Tabelle 1+2 Prädiktoren):
    //   - MUCAPE, LI, meanRH, mlMixRatio, q925, DLS, CIN (Europa), precipAcc
    //
    // Logit = β₀ + Σ(βᵢ × fᵢ)
    // wobei fᵢ normierte [0,1]-Prädiktorfunktionen
    //
    // Koeffizienten sind Europa-kalibriert (nicht US-Werte!):
    //   Europa: niedrigere CAPE-Schwellen, mehr Effizienz bei LI und RH
    // ─────────────────────────────────────────────────────────────────────

    // ── PRÄDIKATOR 1: CAPE (Haupttreiber nach Westermayer 2017, Taszarek 2017)
    // Europa: CAPE-Tail 3000–4000 J/kg (vs. 6000–8000 USA)
    // Bereits kleine CAPE-Werte relevant (10–25% Stürme mit CAPE<100 J/kg in Europa)
    const capeNorm = cape > 0
        ? Math.min(1.0, Math.log1p(cape / 100) / Math.log1p(20))  // Sättigung bei ~2000 J/kg
        : 0.0;

    // ── PRÄDIKATOR 2: Lifted Index (ROBUSTESTER Prädikator, Matczak 2026)
    // Skalierend: LI < 0 zunehmend positiv, LI > 2 zunehmend negativ
    // Saisonale Schwellen
    const liThreshHigh = winterMode ? 1.5 : springMode ? 2.0 : 2.5;
    const liThreshLow  = winterMode ? -1.5 : springMode ? -2.5 : -4.0;
    const liNorm = linNorm(li, liThreshHigh, liThreshLow);

    // ── PRÄDIKATOR 3: Mittlere RH 850–500 hPa (Battaglioli 2023, Matczak 2026)
    // Schlüsselprädikator für warme Umgebungen
    const rhNorm = linNorm(meanRH, 30, 72);

    // ── PRÄDIKATOR 4: ML Mixing Ratio (ARlig Battaglioli 2023)
    // Niedrige Schwellen für Europa (kühler/feuchter als USA)
    const mrLow  = winterMode ? 1.5 : springMode ? 3.0 : 5.0;
    const mrHigh = winterMode ? 5.0 : springMode ? 7.5 : 10.0;
    const mrNorm = linNorm(mlMR, mrLow, mrHigh);

    // ── PRÄDIKATOR 5: Spezifische Feuchte 925 hPa (ARlig Battaglioli 2023)
    // q925 als eigenständiger Feuchteprädikator, ergänzt mlMR
    const q925Norm = linNorm(q925, 2.0, 8.0);

    // Kombinierter Feuchteterm (geometrisches Mittel aus 3 Feuchteprädiktoren)
    // Wenn alle drei übereinstimmen: starkes Feuchtesignal
    const f_feuchte = Math.cbrt(rhNorm * mrNorm * q925Norm);

    // ── PRÄDIKATOR 6: 925–500 hPa Bulk Shear (ARlig Battaglioli 2023)
    // Auch bei niedrigem Shear können Gewitter entstehen (thermische Konvektion)
    // Shear steigert Wahrscheinlichkeit additiv, nicht multiplikativ
    const shearLow  = winterMode ? 5 : 4;
    const shearHigh = winterMode ? 20 : 25;
    const shearNorm = linNorm(shear, shearLow, shearHigh);
    // WMAXSHEAR als kombinierter Parameter (Taszarek 2020)
    const wms = calcWMAXSHEAR(cape, shear);
    const wmsNorm = linNorm(wms, 100, 600);
    // Organisations-Term: Shear und WMS kombiniert
    const f_org = Math.max(shearNorm, wmsNorm * 0.9,
        cape > 800 ? linNorm(cape, 800, 2500) * 0.5 : 0);

    // ── PRÄDIKATOR 7: CIN – Europa-spezifisch kalibriert
    // Taszarek 2020: Europa hat niedrigeres CIN → höhere Auslöseeffizienz
    // KEIN hartes Blocking bei moderatem CIN!
    const magCin = -Math.min(0, cin);
    // Europäische CIN-Schwelle deutlich niedriger als US-Schwellen
    // Frontalgewitter: CIN weniger hemmend (Matczak 2026)
    const isFrontal = shearMS >= 8 && meanRH >= 60 && (precipAcc >= 0.02 || hour.precip >= 40);
    let f_cin;
    if (isFrontal) {
        f_cin = Math.max(0.55, linNorm(cin, -180, -15));
    } else if (cape > 500) {
        // Bei hohem CAPE: CIN-Hemmung reduziert (Energie überwältigt Deckel)
        f_cin = Math.max(0.2, linNorm(cin, -200 - cape * 0.15, -20));
    } else {
        // Niedrig-CAPE: CIN hemmender, aber immer noch EU-Schwelle
        f_cin = Math.max(0.1, linNorm(cin, -120, -15));
    }

    // ── PRÄDIKATOR 8: EL-Temperatur (Westermayer 2017)
    // Lightning wahrscheinlicher wenn EL-Temp < -10°C
    // Wirkt als Verstärkungsfaktor, kein hard gate
    const elNorm = linNorm(elTemp, -5, -20);  // -5°C=0, -20°C=1

    // ── PRÄDIKATOR 9: Konvektiver Niederschlag als direktes Konvektionssignal
    // (ARlig Battaglioli 2023: convective precip als eigenständiger Prädikator)
    const precipNorm = linNorm(precipAcc, 0.0, 2.0);  // 0–2 mm/h

    // ── TAGESGANG-FAKTOR
    const rad     = hour.directRadiation ?? 0;
    const isDay   = rad >= 100;
    const isNight = rad < 15;
    const llj_night = calcSRH(hour, '0-1km') >= 70 && shear >= 10;

    let f_tagesgang;
    if (winterMode) {
        f_tagesgang = isFrontal ? 0.88 : 0.72;
    } else if (isDay) {
        f_tagesgang = 0.68 + 0.32 * linNorm(rad, 100, 700);
    } else if (llj_night) {
        f_tagesgang = 0.78;  // Nacht-LLJ kann Gewitterauslösung ermöglichen
    } else if (isNight) {
        f_tagesgang = summerMode ? 0.58 : 0.52;
    } else {
        f_tagesgang = 0.65;
    }

    // ── ADDITIVE LOGIT-BERECHNUNG
    // Koeffizienten nach Battaglioli 2023 Prädikatorwichtigkeit kalibriert:
    //   CAPE und LI primär; RH, mlMR, q925 sekundär; Shear tertiär
    //
    // logit(p) = -2.5 (Intercept, entspricht ~7.6% Basiswahrscheinlichkeit)
    //           + β_cape × capeNorm   (Gewicht 2.2 – primär)
    //           + β_li   × liNorm     (Gewicht 2.4 – primär, Matczak 2026)
    //           + β_rh   × f_feuchte  (Gewicht 1.6 – sekundär)
    //           + β_org  × f_org      (Gewicht 1.0 – tertiär)
    //           + β_el   × elNorm     (Gewicht 0.6 – Westermayer 2017)
    //           + β_prec × precipNorm (Gewicht 0.8 – direktes Signal)
    //
    // Dann: rohe p = sigmoid(logit)
    // Ausgabe = rohe_p × f_cin × f_tagesgang × f_saison

    const logit = -2.5
        + 2.2 * capeNorm
        + 2.4 * liNorm
        + 1.6 * f_feuchte
        + 1.0 * f_org
        + 0.6 * elNorm
        + 0.8 * precipNorm;

    // Sigmoid-Funktion → Wahrscheinlichkeit [0, 1]
    const pRaw = 1.0 / (1.0 + Math.exp(-logit));

    // Auslöse-Faktor (Europa: CIN moderat hemmend, nicht blockend)
    const pKonv = pRaw * f_cin * f_tagesgang * f_saison;

    // Finale Skalierung auf [0, 100]
    // Sigmoid gibt max ~0.88 zurück bei extremen Parametern
    // → Normierung auf realistischen Maximalwert 0.85
    const p = Math.round(Math.min(100, pKonv / 0.85 * 100));

    // Minimaler Ausgabeschwellenwert: < 5% wird als 0 ausgegeben
    return p < 5 ? 0 : Math.min(95, p);
}
