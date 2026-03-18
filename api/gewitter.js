// ═══════════════════════════════════════════════════════════════════════════
// AR-CHaMo v3 – GEFS Ensemble Edition
// Modell: ncep_gefs05 (31 Member: control + member01–member30)
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
        // ── GEFS hat 31 Member (control = kein Suffix, member01–member30)
        const MEMBER_COUNT = 30;
        const MEMBERS = ['', ...Array.from({ length: MEMBER_COUNT }, (_, i) =>
            `_member${String(i + 1).padStart(2, '0')}`)];

        // Variablen die GEFS als Member liefert
        const gefsVars = [
            'wind_gusts_10m',
            'wind_speed_10m',
            'temperature_2m',
            'dew_point_2m',
            'cloud_cover_low',
            'cloud_cover_mid',
            'cloud_cover_high',
            'precipitation_probability',
            'wind_direction_1000hPa',
            'wind_direction_925hPa',
            'wind_direction_850hPa',
            'wind_direction_700hPa',
            'wind_direction_500hPa',
            'wind_direction_300hPa',
            'wind_speed_1000hPa',
            'wind_speed_925hPa',
            'wind_speed_850hPa',
            'wind_speed_700hPa',
            'wind_speed_500hPa',
            'wind_speed_300hPa',
            'temperature_925hPa',
            'temperature_850hPa',
            'temperature_700hPa',
            'temperature_500hPa',
            'dew_point_925hPa',
            'dew_point_850hPa',
            'dew_point_700hPa',
            'relative_humidity_925hPa',
            'relative_humidity_850hPa',
            'relative_humidity_700hPa',
            'relative_humidity_500hPa',
            'cape',
            'lifted_index',
            'convective_inhibition',
            'precipitation',
            'freezing_level_height',
            'total_column_integrated_water_vapour',
        ];

        // Alle Member-Varianten für den API-Request aufbauen
        // GEFS liefert: cape, cape_member01, cape_member02, ... cape_member30
        const memberVarList = [];
        for (const v of gefsVars) {
            memberVarList.push(v); // control (kein Suffix)
            for (let m = 1; m <= MEMBER_COUNT; m++) {
                memberVarList.push(`${v}_member${String(m).padStart(2, '0')}`);
            }
        }

        // Variablen die GEFS NICHT als Member hat (nur control)
        const singleVars = [
            'boundary_layer_height',
            'direct_radiation',
            'wind_direction_975hPa',
            'wind_direction_950hPa',
            'wind_direction_900hPa',
            'wind_speed_975hPa',
            'wind_speed_950hPa',
            'wind_speed_900hPa',
        ];

        const allVars = [...memberVarList, ...singleVars].join(',');

        const url = `https://ensemble-api.open-meteo.com/v1/ensemble?` +
            `latitude=${latitude}&longitude=${longitude}` +
            `&hourly=${allVars}` +
            `&forecast_days=16&models=ncep_gefs05&timezone=auto`;

        const response = await fetch(url);
        const data     = await response.json();

        if (data.error) return res.status(500).json({ error: 'API-Fehler: ' + (data.reason || 'Unbekannt') });
        if (!data?.hourly?.time?.length) return res.status(500).json({ error: 'Keine Daten verfügbar' });

        const timezone = data.timezone || 'UTC';
        const region   = getRegion(latitude, longitude);
        if (region !== 'europe') {
            return res.status(400).json({ error: 'Vorhersage nur für Europa verfügbar', region, onlyEurope: true });
        }

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
        // HILFSFUNKTION: Ensemble-Mittelwert eines Feldes über alle Member
        // ═══════════════════════════════════════════════════════════════════
        function getMemberMean(hourly, fieldBase, i) {
            const values = [];
            // Control Member (kein Suffix)
            const ctrl = hourly[fieldBase]?.[i];
            if (ctrl !== null && ctrl !== undefined) values.push(ctrl);
            // Member 01–30
            for (let m = 1; m <= MEMBER_COUNT; m++) {
                const key = `${fieldBase}_member${String(m).padStart(2, '0')}`;
                const v = hourly[key]?.[i];
                if (v !== null && v !== undefined) values.push(v);
            }
            if (values.length === 0) return null;
            return values.reduce((s, x) => s + x, 0) / values.length;
        }

        // Ensemble-Spread (Standardabweichung) – für Konsens-Berechnung
        function getMemberSpread(hourly, fieldBase, i) {
            const values = [];
            const ctrl = hourly[fieldBase]?.[i];
            if (ctrl !== null && ctrl !== undefined) values.push(ctrl);
            for (let m = 1; m <= MEMBER_COUNT; m++) {
                const key = `${fieldBase}_member${String(m).padStart(2, '0')}`;
                const v = hourly[key]?.[i];
                if (v !== null && v !== undefined) values.push(v);
            }
            if (values.length < 2) return 0;
            const mean = values.reduce((s, x) => s + x, 0) / values.length;
            return Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length);
        }

        // ─── Pro Member eine vollständige "hour"-Struktur extrahieren
        function extractMemberHour(hourly, i, memberSuffix) {
            function get(field) {
                const key = memberSuffix ? `${field}${memberSuffix}` : field;
                const arr = hourly[key];
                if (Array.isArray(arr) && arr[i] !== undefined && arr[i] !== null) return arr[i];
                // Fallback: versuche ohne Suffix (single-var Felder)
                if (memberSuffix) {
                    const arr2 = hourly[field];
                    if (Array.isArray(arr2) && arr2[i] !== undefined && arr2[i] !== null) return arr2[i];
                }
                return null;
            }

            const t2m  = get('temperature_2m');
            const t850 = get('temperature_850hPa');
            const t500 = get('temperature_500hPa');
            if (t2m === null || t850 === null || t500 === null) return null;

            const d2m  = get('dew_point_2m');
            const t925 = get('temperature_925hPa');
            const d925 = get('dew_point_925hPa');
            const d850 = get('dew_point_850hPa');
            const t700 = get('temperature_700hPa');
            const d700 = get('dew_point_700hPa');
            const rawCin = get('convective_inhibition');
            const rawLI  = get('lifted_index');
            const rawPBL = get('boundary_layer_height'); // nur im Control

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
                directRadiation: get('direct_radiation') ?? 0, // nur Control
                precipAcc:       get('precipitation') ?? 0,
                pwat:            get('total_column_integrated_water_vapour') ?? 25,
                freezingLevel:   null,
                cin:             null,
                liftedIndex:     null,
                pblHeight:       null,
            };

            // Gefrierniveau
            const apiFL = get('freezing_level_height');
            hour.freezingLevel = (apiFL !== null && apiFL >= 100 && apiFL <= 6000)
                ? apiFL : calcFreezingLevel(hour);

            hour.cin         = rawCin !== null ? rawCin : calcCIN(hour, rawLI ?? 99);
            hour.liftedIndex = rawLI  ?? calcLiftedIndex(hour);
            hour.pblHeight   = (rawPBL !== null && rawPBL > 50) ? rawPBL : calcPBLHeight(hour);

            hour.rh925 = hour.rh925 ?? calcRelHum(hour.temp925, hour.dew925);
            hour.rh850 = hour.rh850 ?? calcRelHum(hour.temp850, hour.dew850);
            hour.rh700 = hour.rh700 ?? calcRelHum(hour.temp700, hour.dew700);

            const e925 = svp(hour.dew925);
            const e850 = svp(hour.dew850);
            hour.mlMixRatio = (mixingRatio(e925, 925) + mixingRatio(e850, 850)) / 2;
            hour.q925       = calcSpecificHumidity(hour.dew925, 925);
            hour.wbzHeight  = calcWBZHeight(hour);
            hour.meanRH     = (hour.rh850 + hour.rh700 + hour.rh500) / 3;
            hour.elTemp     = calcELTemperature(hour);

            return hour;
        }

        // ═══════════════════════════════════════════════════════════════════
        // SCHRITT: Alle 31 Member pro Stunde verarbeiten
        // ═══════════════════════════════════════════════════════════════════
        const memberSuffixes = [
            '',  // control
            ...Array.from({ length: MEMBER_COUNT }, (_, i) =>
                `_member${String(i + 1).padStart(2, '0')}`)
        ];

        const hours = data.hourly.time.map((t, i) => {
            const forecastTime = new Date(t);
            const lt = Math.round((forecastTime - now) / 3600000);

            // Alle Member berechnen
            const memberProbs = [];
            for (const suffix of memberSuffixes) {
                const mh = extractMemberHour(data.hourly, i, suffix);
                if (!mh) continue;
                const p = calculateLightningProbability(mh);
                memberProbs.push(p);
            }

            if (memberProbs.length === 0) {
                return { time: t, probability: 0, modell_konsens: 'niedrig', modell_stddev: 0 };
            }

            // Ensemble-Statistik der Blitzwahrscheinlichkeiten
            const mean   = memberProbs.reduce((s, p) => s + p, 0) / memberProbs.length;
            const sorted = [...memberProbs].sort((a, b) => a - b);
            const median = sorted.length % 2 === 1
                ? sorted[Math.floor(sorted.length / 2)]
                : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
            const variance = memberProbs.reduce((s, p) => s + (p - mean) ** 2, 0) / memberProbs.length;
            const stddev   = Math.sqrt(variance);

            // Konsens-Faktor (wie bisher, jetzt über Member-Spread)
            const kf = stddev <= 15
                ? Math.max(0.65, Math.min(1.15, 1.15 - (stddev / 15) * 0.15))
                : Math.max(0.65, Math.min(1.15, 1.00 - ((stddev - 15) / 25) * 0.35));

            const prob    = Math.round(Math.max(0, Math.min(100, mean * kf)));
            const konsens = stddev <= 10 ? 'hoch' : stddev <= 22 ? 'mittel' : 'niedrig';

            // Kontroll-Member für ensHour (Shear/SRH-Berechnung)
            const ctrlHour = extractMemberHour(data.hourly, i, '');

            return {
                time:           t,
                probability:    prob,
                modell_konsens: konsens,
                modell_stddev:  Math.round(stddev * 10) / 10,
                member_probs:   memberProbs,  // alle 31 Member-Wahrscheinlichkeiten
                member_mean:    Math.round(mean * 10) / 10,
                member_median:  Math.round(median * 10) / 10,
                ensHour:        ctrlHour,
                temperature:    ctrlHour ? Math.round(ctrlHour.temperature * 10) / 10 : null,
                cape:           ctrlHour ? Math.round(getMemberMean(data.hourly, 'cape', i) ?? 0) : null,
                shear:          ctrlHour ? Math.round(calcShear(ctrlHour) * 10) / 10 : null,
                srh:            ctrlHour ? Math.round(calcSRH(ctrlHour, '0-3km') * 10) / 10 : null,
            };
        });

        // ── Filter auf aktuelle und zukünftige Stunden
        const nextHours = hours.filter(h => {
            const [dp, tp] = h.time.split('T');
            const hr = parseInt(tp);
            return dp > currentDateStr || (dp === currentDateStr && hr >= currentHour);
        }).slice(0, 24);

        // ── Tages-Aggregation
        const daysMap = new Map();
        hours.forEach(h => {
            const [dp, tp] = h.time.split('T');
            const hr = parseInt(tp);
            if (dp < currentDateStr || (dp === currentDateStr && hr < currentHour)) return;
            if (!daysMap.has(dp)) {
                daysMap.set(dp, {
                    date:           dp,
                    maxProbability: h.probability,
                    peakKonsens:    h.modell_konsens,
                    peakStddev:     h.modell_stddev,
                    ensHour:        h.ensHour,
                });
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
            member_median:  h.member_median,
        }));

        const tage = Array.from(daysMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(day => ({
                date:           day.date,
                gewitter:       day.maxProbability,
                gewitter_risk:  categorizeRisk(day.maxProbability, day.ensHour),
                modell_konsens: day.peakKonsens,
                modell_stddev:  day.peakStddev,
            }));

        // ── Debug-Ausgabe (erste 20 Stunden, Control-Member)
        const debugStunden = nextHours.slice(0, 20).map(h => {
            const i  = data.hourly.time.indexOf(h.time);
            const mh = extractMemberHour(data.hourly, i, ''); // Control
            if (!mh) return { timestamp: h.time, error: 'no data' };

            const shear   = calcShear(mh);
            const srh3    = calcSRH(mh, '0-3km');
            const srh1    = calcSRH(mh, '0-1km');
            const lcl     = calcLCLHeight(mh.temperature, mh.dew);
            const ki      = calcKIndex(mh);
            const si      = calcShowalter(mh);
            const midLap  = calcMidLapseRate(mh.temp700, mh.temp500);
            const shearMS = shear / 3.6;
            const scpVal  = calcSCP(mh.cape, shearMS, srh3, mh.cin ?? 0);
            const ehiVal  = calcEHI(mh);
            const stpVal  = calcSTP(mh);

            // CAPE-Spread über alle Member (Unsicherheitsmaß)
            const capeSpread = Math.round(getMemberSpread(data.hourly, 'cape', i));

            return {
                timestamp:         h.time,
                ensemble_gewitter: h.probability,
                member_mean:       h.member_mean,
                member_median:     h.member_median,
                modell_konsens:    h.modell_konsens,
                modell_stddev:     h.modell_stddev,
                member_probs:      h.member_probs,  // alle 31 Member-Wahrscheinlichkeiten
                control_member: {
                    archamo_li:       Math.round(mh.liftedIndex * 10) / 10,
                    archamo_dls:      Math.round(shear * 10) / 10,
                    archamo_meanRH:   Math.round(mh.meanRH),
                    archamo_q925:     Math.round(mh.q925 * 10) / 10,
                    archamo_mlMR:     Math.round(mh.mlMixRatio * 10) / 10,
                    archamo_wbz:      Math.round(mh.wbzHeight),
                    archamo_cape:     Math.round(mh.cape),
                    archamo_elTemp:   Math.round((mh.elTemp ?? -99) * 10) / 10,
                    cape_spread:      capeSpread,
                    scp: Math.round(scpVal * 100) / 100,
                    ehi: Math.round(ehiVal * 100) / 100,
                    stp: Math.round(stpVal * 100) / 100,
                    cape: Math.round(mh.cape), cin: Math.round(mh.cin ?? 0),
                    lcl: Math.round(lcl),
                    liftedIndex: Math.round(mh.liftedIndex * 10) / 10,
                    kIndex: Math.round(ki * 10) / 10,
                    showalter: Math.round(si * 10) / 10,
                    midLapse: Math.round(midLap * 10) / 10,
                    shear: Math.round(shear * 10) / 10,
                    srh1km: Math.round(srh1 * 10) / 10,
                    srh3km: Math.round(srh3 * 10) / 10,
                    meanRH: Math.round(mh.meanRH),
                    mlMixRatio: Math.round(mh.mlMixRatio * 10) / 10,
                    q925: Math.round(mh.q925 * 10) / 10,
                    pwat: Math.round(mh.pwat),
                    temp2m: mh.temperature, dew2m: mh.dew,
                    temp850: mh.temp850, temp700: mh.temp700, temp500: mh.temp500,
                    rh850: Math.round(mh.rh850), rh700: Math.round(mh.rh700),
                    rh500: Math.round(mh.rh500),
                    wind10m: Math.round(mh.wind * 10) / 10,
                    gust10m: Math.round(mh.gust * 10) / 10,
                    precipAcc: Math.round(mh.precipAcc * 10) / 10,
                    radiation: Math.round(mh.directRadiation),
                },
            };
        });

        return res.status(200).json({
            timezone,
            region,
            modell: 'ncep_gefs05',
            member_count: memberProbs?.length ?? MEMBER_COUNT + 1,
            stunden,
            tage,
            debug: {
                hinweis: 'AR-CHaMo v3 + GEFS Ensemble (ncep_gefs05, 31 Member). ' +
                    'Blitzwahrscheinlichkeit wird pro Member berechnet, dann Ensemble-Statistik. ' +
                    'Konsens-Faktor basiert auf Member-Spread der Blitzwahrscheinlichkeit.',
                stunden: debugStunden,
            },
        });

    } catch (err) {
        console.error('Fehler:', err);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}
