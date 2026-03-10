// Severe Weather Multi-Model Analysis API
// Supports: SHIP (Hail), STP (Tornado), Severe Wind
// Models: ICON Seamless, ECMWF IFS025, GFS Global (weighted ensemble)

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

    // Europa Begrenzung
    if (latitude < 34.0 || latitude > 71.5 || longitude < -25.0 || longitude > 45.0) {
        return res.status(400).json({ error: 'Koordinaten außerhalb Europas. Nur europäische Koordinaten sind erlaubt.' });
    }

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
            `freezing_level_height,precipitation,boundary_layer_height,convective_inhibition,lifted_index` +
            `&forecast_days=16&models=icon_seamless,ecmwf_ifs025,gfs_global&timezone=auto`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Open-Meteo API Fehler: ${response.status}`);
        const data = await response.json();

        const result = processMultiModelData(data, latitude, longitude);
        return res.status(200).json(result);
    } catch (err) {
        console.error('API Error:', err);
        return res.status(500).json({ error: 'Interner Serverfehler', details: err.message });
    }
}

// ─── Berechnungsfunktionen ────────────────────────────────────────────────────

function calcDewPoint(temp_c, rh) {
    if (temp_c == null || rh == null) return null;
    const a = 17.27, b = 237.7;
    const alpha = ((a * temp_c) / (b + temp_c)) + Math.log(Math.max(rh, 1) / 100);
    return (b * alpha) / (a - alpha);
}

function calcCIN(hour) {
    // CIN Näherung aus CAPE, LI und Bodenbedingungen
    const cape = hour.cape ?? 0;
    const li = hour.liftedIndex ?? 0;
    const blh = hour.boundary_layer_height ?? 1000;
    if (cape === 0 && li >= 0) return 0;
    // Näherung: negative Energie unterhalb LFC
    const cin_est = li > 0 ? 0 : Math.max(-500, li * 15 - (blh / 100));
    return Math.round(cin_est);
}

function calcLiftedIndex(hour) {
    // LI = T500 - T_parcel500
    // T_parcel folgt Pseudoadiabate vom Boden
    const t2m = hour.temperature_2m;
    const td2m = hour.dew_point_2m;
    const t500 = hour.temperature_500hPa;
    if (t2m == null || td2m == null || t500 == null) return null;

    // Hebungskondensniveau (LCL)
    const lcl_t = t2m - ((t2m - td2m) / 8.0);
    // Pseudoadiabatischer Anstieg: ~6.5°C/km bis LCL, dann ~5°C/km
    // 500hPa liegt ca. auf 5500m
    const lcl_height = (t2m - lcl_t) * 122; // m
    const above_lcl = 5500 - lcl_height;
    const t_parcel_500 = lcl_t - (above_lcl / 1000) * 5.5;
    return Math.round((t500 - t_parcel_500) * 10) / 10;
}

function calcDCAPE(hour) {
    // DCAPE = Downdraft CAPE (Näherung nach Gilmore & Wicker 1998)
    const t700 = hour.temperature_700hPa;
    const td700 = hour.dew_point_700hPa ?? calcDewPoint(t700, hour.relative_humidity_700hPa);
    const t850 = hour.temperature_850hPa;
    const td850 = hour.dew_point_850hPa ?? calcDewPoint(t850, hour.relative_humidity_850hPa);
    const t500 = hour.temperature_500hPa;
    if (t700 == null || t850 == null || t500 == null) return null;

    // Feuchttemperatur im Absinkbereich (700–500 hPa)
    const wb700 = td700 != null ? (t700 + td700) / 2 : t700;
    const wb850 = td850 != null ? (t850 + td850) / 2 : t850;

    // DCAPE ~ Integral der negativen Auftriebsenergie beim Absinken
    // Einfache Trapez-Näherung zwischen 850 und 500 hPa
    const lapse_env_850_500 = (t850 - t500) / 3.5; // °C/km
    const lapse_parcel = 6.5; // trockenadiabatisch absteigendes gesättigtes Parcel
    const dcape = Math.max(0, (lapse_parcel - lapse_env_850_500) * 50 + Math.max(0, (wb700 - t700) * 30));
    return Math.round(dcape);
}

// ─── Composite-Indizes ────────────────────────────────────────────────────────

function calcSHIP(hour) {
    // Significant Hail Parameter (SHIP)
    // SHIP = (MUCAPE * MU_mixr * lapse_rate_700-500 * (-T500) * (-MUSHI)) / 44,000,000
    const cape = hour.cape ?? 0;
    if (cape < 100) return 0;

    const t500 = hour.temperature_500hPa;
    const t700 = hour.temperature_700hPa;
    const td850 = hour.dew_point_850hPa ?? calcDewPoint(hour.temperature_850hPa, hour.relative_humidity_850hPa);
    const li = hour.liftedIndex ?? calcLiftedIndex(hour);

    if (t500 == null || t700 == null) return null;

    // Mischungsverhältnis ~850hPa aus Taupunkt
    const mixr = td850 != null ? Math.max(0, 6.112 * Math.exp((17.67 * td850) / (td850 + 243.5)) * 0.622 / 1013) * 1000 : 10;

    // Lapserate 700–500 hPa in °C/km (ca. 3 km Schicht)
    const lapse = (t700 - t500) / 3.0;

    // T500 muss negativ sein für Hagel
    const t500_factor = Math.max(0, -t500);

    // LI als Proxy für SHIP-Shear-Term
    const shi = li != null ? Math.max(0, -li) : 5;

    const ship = (cape * Math.max(0, mixr) * Math.max(0, lapse) * t500_factor * shi) / 44000000;
    return Math.round(ship * 100) / 100;
}

function calcSTP(hour) {
    // Significant Tornado Parameter (STP)
    // STP = (CAPE/1500) * (SRH/150) * (EBWD/12) * ((2000-LCL)/1000) * ((CIN+200)/150)
    const cape = hour.cape ?? 0;
    if (cape < 100) return 0;

    const li = hour.liftedIndex ?? calcLiftedIndex(hour);
    const cin = hour.cin ?? calcCIN(hour);

    // SRH Näherung aus Windscherung 0-1km (925-850 hPa)
    const ws925 = hour.wind_speed_925hPa ?? 0;
    const wd925 = hour.wind_direction_925hPa ?? 0;
    const ws850 = hour.wind_speed_850hPa ?? 0;
    const wd850 = hour.wind_direction_850hPa ?? 0;
    const ws500 = hour.wind_speed_500hPa ?? 0;

    // Vektorielle Windscherung 925-500 hPa als EBWD-Proxy (m/s)
    const du = ws500 * Math.cos(wd850 * Math.PI / 180) - ws925 * Math.cos(wd925 * Math.PI / 180);
    const dv = ws500 * Math.sin(wd850 * Math.PI / 180) - ws925 * Math.sin(wd925 * Math.PI / 180);
    const ebwd = Math.sqrt(du * du + dv * dv);

    // SRH Näherung (0–3km) aus Scherungsvektor
    const ws10 = hour.wind_speed_10m ?? 0;
    const ws1km = ws925;
    const ws3km = ws850;
    const srh = Math.max(0, ((ws1km - ws10) * 50 + (ws3km - ws10) * 30));

    // LCL-Höhe Näherung (m)
    const t2m = hour.temperature_2m ?? 15;
    const td2m = hour.dew_point_2m ?? 5;
    const lcl_height = Math.max(0, (t2m - td2m) * 122);

    const cape_term = Math.min(cape / 1500, 1.5);
    const srh_term = Math.min(srh / 150, 3.0);
    const ebwd_term = ebwd >= 12 ? Math.min(ebwd / 12, 1.5) : ebwd / 12;
    const lcl_term = lcl_height <= 1000 ? 1.0 : Math.max(0, (2000 - lcl_height) / 1000);
    const cin_term = cin >= -50 ? 1.0 : cin <= -200 ? 0 : (cin + 200) / 150;

    const stp = cape_term * srh_term * ebwd_term * lcl_term * cin_term;
    return Math.round(stp * 100) / 100;
}

function calcSevereWindProb(hour) {
    // Severe Wind Wahrscheinlichkeit (>25 m/s Böen)
    const gusts = hour.wind_gusts_10m ?? 0;
    const dcape = hour.dcape ?? calcDCAPE(hour);
    const cape = hour.cape ?? 0;
    const blh = hour.boundary_layer_height ?? 1000;
    const ws500 = hour.wind_speed_500hPa ?? 0;

    let prob = 0;

    // Direkte Böenkomponente
    if (gusts >= 25) prob += 40;
    else if (gusts >= 20) prob += 20;
    else if (gusts >= 15) prob += 10;

    // DCAPE-Komponente (Downburst-Potenzial)
    if (dcape != null) {
        if (dcape >= 1000) prob += 30;
        else if (dcape >= 500) prob += 15;
        else if (dcape >= 200) prob += 5;
    }

    // Instabilität
    if (cape >= 1000) prob += 15;
    else if (cape >= 500) prob += 8;

    // Höhenwind
    if (ws500 >= 30) prob += 15;
    else if (ws500 >= 20) prob += 8;

    return Math.min(100, Math.round(prob));
}

// ─── Wahrscheinlichkeits-Klassen ──────────────────────────────────────────────

function shipProbabilities(ship) {
    if (ship == null) return { low: 0, moderate: 0, high: 0, extreme: 0 };
    return {
        low:      ship >= 0.5 ? Math.min(100, Math.round(ship * 30 + 20)) : 0,
        moderate: ship >= 1.0 ? Math.min(100, Math.round((ship - 1) * 35 + 30)) : 0,
        high:     ship >= 2.0 ? Math.min(100, Math.round((ship - 2) * 40 + 40)) : 0,
        extreme:  ship >= 4.0 ? Math.min(100, Math.round((ship - 4) * 25 + 60)) : 0,
    };
}

function stpProbabilities(stp) {
    if (stp == null) return { low: 0, moderate: 0, high: 0, extreme: 0 };
    return {
        low:      stp >= 0.5 ? Math.min(100, Math.round(stp * 25 + 15)) : 0,
        moderate: stp >= 1.0 ? Math.min(100, Math.round((stp - 1) * 30 + 25)) : 0,
        high:     stp >= 3.0 ? Math.min(100, Math.round((stp - 3) * 20 + 50)) : 0,
        extreme:  stp >= 6.0 ? Math.min(100, Math.round((stp - 6) * 10 + 65)) : 0,
    };
}

function windProbabilities(prob, gusts) {
    const g = gusts ?? 0;
    return {
        low:      g >= 15 ? Math.min(100, Math.round(prob * 0.8)) : 0,
        moderate: g >= 20 ? Math.min(100, Math.round(prob * 0.65)) : 0,
        high:     g >= 25 ? Math.min(100, Math.round(prob * 0.5)) : 0,
        extreme:  g >= 33 ? Math.min(100, Math.round(prob * 0.35)) : 0,
    };
}

// ─── Modell-Gewichtung ────────────────────────────────────────────────────────
// Gewichtung: ICON 40%, ECMWF 40%, GFS 20% (ICON+ECMWF besser für Europa)
const MODEL_WEIGHTS = { icon_seamless: 0.40, ecmwf_ifs025: 0.40, gfs_global: 0.20 };

function weightedMean(values) {
    // values: [{model, value}]
    let sumW = 0, sumWV = 0;
    for (const { model, value } of values) {
        if (value == null || isNaN(value)) continue;
        const w = MODEL_WEIGHTS[model] ?? 0.33;
        sumW += w;
        sumWV += w * value;
    }
    return sumW > 0 ? sumWV / sumW : null;
}

// ─── Daten-Extraktion & Verarbeitung ─────────────────────────────────────────

function extractModelHours(data, modelSuffix) {
    const h = data.hourly;
    if (!h) return [];
    const times = h.time ?? [];
    const suffix = modelSuffix ? `_${modelSuffix}` : '';

    const getArr = (key) => h[`${key}${suffix}`] ?? h[key] ?? [];

    return times.map((time, i) => {
        const hour = {
            time,
            model: modelSuffix,
            cape:                        getArr('cape')[i],
            convective_inhibition:       getArr('convective_inhibition')[i],
            lifted_index:                getArr('lifted_index')[i],
            wind_gusts_10m:              getArr('wind_gusts_10m')[i],
            wind_speed_10m:              getArr('wind_speed_10m')[i],
            temperature_2m:              getArr('temperature_2m')[i],
            dew_point_2m:                getArr('dew_point_2m')[i],
            temperature_500hPa:          getArr('temperature_500hPa')[i],
            temperature_700hPa:          getArr('temperature_700hPa')[i],
            temperature_850hPa:          getArr('temperature_850hPa')[i],
            dew_point_700hPa:            getArr('dew_point_700hPa')[i],
            dew_point_850hPa:            getArr('dew_point_850hPa')[i],
            relative_humidity_500hPa:    getArr('relative_humidity_500hPa')[i],
            relative_humidity_700hPa:    getArr('relative_humidity_700hPa')[i],
            relative_humidity_850hPa:    getArr('relative_humidity_850hPa')[i],
            wind_speed_500hPa:           getArr('wind_speed_500hPa')[i],
            wind_speed_850hPa:           getArr('wind_speed_850hPa')[i],
            wind_speed_925hPa:           getArr('wind_speed_925hPa')[i],
            wind_direction_850hPa:       getArr('wind_direction_850hPa')[i],
            wind_direction_925hPa:       getArr('wind_direction_925hPa')[i],
            wind_speed_10m:              getArr('wind_speed_10m')[i],
            boundary_layer_height:       getArr('boundary_layer_height')[i],
            freezing_level_height:       getArr('freezing_level_height')[i],
            precipitation:               getArr('precipitation')[i],
            precipitation_probability:   getArr('precipitation_probability')[i],
        };

        // CIN & LI: aus API oder berechnen (wie estefex/essl Pattern)
        hour.cin         = hour.convective_inhibition ?? calcCIN(hour);
        hour.liftedIndex = hour.lifted_index          ?? calcLiftedIndex(hour);
        hour.dcape       = calcDCAPE(hour);

        return hour;
    });
}

function processHour(hour) {
    const ship = calcSHIP(hour);
    const stp  = calcSTP(hour);
    const windProb = calcSevereWindProb(hour);

    return {
        ship,
        ship_probs: shipProbabilities(ship),
        stp,
        stp_probs:  stpProbabilities(stp),
        severe_wind_prob: windProb,
        wind_probs: windProbabilities(windProb, hour.wind_gusts_10m),
        // Rohdaten für Transparenz
        raw: {
            cape:               hour.cape,
            cin:                hour.cin,
            lifted_index:       hour.liftedIndex,
            dcape:              hour.dcape,
            wind_gusts_10m:     hour.wind_gusts_10m,
            wind_speed_10m:     hour.wind_speed_10m,
            temperature_2m:     hour.temperature_2m,
            dew_point_2m:       hour.dew_point_2m,
            freezing_level_height: hour.freezing_level_height,
            boundary_layer_height: hour.boundary_layer_height,
        }
    };
}

function processMultiModelData(data, latitude, longitude) {
    const MODELS = ['icon_seamless', 'ecmwf_ifs025', 'gfs_global'];

    // Stunden extrahieren pro Modell
    const modelHours = {};
    for (const model of MODELS) {
        modelHours[model] = extractModelHours(data, model);
    }

    // Zeitachse vom ersten Modell
    const allTimes = modelHours[MODELS[0]].map(h => h.time);
    const nowISO = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH

    // Aktuelle Stunde finden
    const nowIdx = allTimes.findIndex(t => t.startsWith(nowISO));
    const startIdx = nowIdx >= 0 ? nowIdx : 0;

    // ── Stündliche Ausgabe: aktuelle Stunde + nächste 23h ──
    const hourlyOutput = [];
    for (let i = startIdx; i < Math.min(startIdx + 24, allTimes.length); i++) {
        const time = allTimes[i];
        const perModel = {};

        for (const model of MODELS) {
            const hour = modelHours[model][i];
            if (!hour) continue;
            perModel[model] = processHour(hour);
        }

        // Gewichteter Ensemble-Mittelwert
        const ensemble = buildEnsemble(perModel, MODELS);
        hourlyOutput.push({ time, models: perModel, ensemble });
    }

    // ── Tägliche Ausgabe: 16 Tage, Maximalwert pro Tag ──
    const dailyOutput = buildDailyMax(allTimes, modelHours, MODELS, startIdx);

    return {
        latitude,
        longitude,
        generated_at: new Date().toISOString(),
        models_used: MODELS,
        model_weights: MODEL_WEIGHTS,
        hourly: hourlyOutput,
        daily:  dailyOutput,
    };
}

function buildEnsemble(perModel, models) {
    const fields = ['ship', 'stp', 'severe_wind_prob'];
    const probFields = ['ship_probs', 'stp_probs', 'wind_probs'];
    const probKeys   = ['low', 'moderate', 'high', 'extreme'];

    const ens = {};

    for (const f of fields) {
        const vals = models.map(m => ({ model: m, value: perModel[m]?.[f] }));
        ens[f] = roundVal(weightedMean(vals));
    }

    for (const pf of probFields) {
        ens[pf] = {};
        for (const pk of probKeys) {
            const vals = models.map(m => ({ model: m, value: perModel[m]?.[pf]?.[pk] }));
            ens[pf][pk] = roundVal(weightedMean(vals));
        }
    }

    return ens;
}

function buildDailyMax(allTimes, modelHours, models, startIdx) {
    const dailyMap = {};

    for (let i = startIdx; i < allTimes.length; i++) {
        const day = allTimes[i].slice(0, 10); // YYYY-MM-DD

        for (const model of models) {
            const hour = modelHours[model][i];
            if (!hour) continue;
            const processed = processHour(hour);

            if (!dailyMap[day]) dailyMap[day] = {};
            if (!dailyMap[day][model]) dailyMap[day][model] = [];
            dailyMap[day][model].push(processed);
        }
    }

    const days = Object.keys(dailyMap).slice(0, 16);

    return days.map(day => {
        const perModel = {};
        for (const model of models) {
            const hours = dailyMap[day][model] ?? [];
            if (hours.length === 0) continue;
            perModel[model] = {
                ship:             Math.max(...hours.map(h => h.ship ?? 0)),
                stp:              Math.max(...hours.map(h => h.stp  ?? 0)),
                severe_wind_prob: Math.max(...hours.map(h => h.severe_wind_prob ?? 0)),
                ship_probs:       maxProbs(hours.map(h => h.ship_probs)),
                stp_probs:        maxProbs(hours.map(h => h.stp_probs)),
                wind_probs:       maxProbs(hours.map(h => h.wind_probs)),
            };
        }
        const ensemble = buildEnsemble(perModel, models);
        return { date: day, models: perModel, ensemble };
    });
}

function maxProbs(probsArr) {
    const keys = ['low', 'moderate', 'high', 'extreme'];
    const result = {};
    for (const k of keys) {
        result[k] = Math.max(...probsArr.map(p => p?.[k] ?? 0));
    }
    return result;
}

function roundVal(v) {
    return v != null ? Math.round(v * 100) / 100 : null;
}