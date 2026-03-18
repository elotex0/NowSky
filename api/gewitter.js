// ═══════════════════════════════════════════════════════════════════════════
// AR-CHaMo v3 – GEFS Ensemble Edition (Request-Split Fix)
// Problem: 31 Member × 37 Vars = ~1150 Felder → URL zu lang → HTML-Fehler
// Lösung:  3 parallele Requests via Promise.all(), dann mergen
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
        const MEMBER_COUNT = 30;
        const BASE = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${latitude}&longitude=${longitude}&forecast_days=16&models=ncep_gefs05&timezone=auto`;

        // ── Hilfsfunktion: Member-Suffixe für eine Basis-Variable erzeugen
        function withMembers(vars) {
            const out = [];
            for (const v of vars) {
                out.push(v);
                for (let m = 1; m <= MEMBER_COUNT; m++) {
                    out.push(`${v}_member${String(m).padStart(2, '0')}`);
                }
            }
            return out.join(',');
        }

        // ── Request 1: Instabilitäts-/Konvektionsparameter (mit Membern)
        const vars1 = withMembers([
            'cape',
            'lifted_index',
            'convective_inhibition',
            'precipitation',
            'freezing_level_height',
            'total_column_integrated_water_vapour',
        ]);

        // ── Request 2: Wind, Temperatur, Feuchte aller Druckniveaus (mit Membern)
        const vars2 = withMembers([
            'wind_speed_1000hPa','wind_speed_925hPa','wind_speed_850hPa',
            'wind_speed_700hPa','wind_speed_500hPa','wind_speed_300hPa',
            'wind_direction_1000hPa','wind_direction_925hPa','wind_direction_850hPa',
            'wind_direction_700hPa','wind_direction_500hPa','wind_direction_300hPa',
            'temperature_2m','dew_point_2m',
            'temperature_925hPa','temperature_850hPa','temperature_700hPa','temperature_500hPa',
            'dew_point_925hPa','dew_point_850hPa','dew_point_700hPa',
            'relative_humidity_925hPa','relative_humidity_850hPa',
            'relative_humidity_700hPa','relative_humidity_500hPa',
        ]);

        // ── Request 3: Einzel-Variablen (KEIN Member-Suffix – GEFS liefert nur Control)
        const vars3 = [
            'wind_gusts_10m',
            'wind_speed_10m',
            'cloud_cover_low','cloud_cover_mid','cloud_cover_high',
            'precipitation_probability',
            'wind_direction_975hPa','wind_direction_950hPa','wind_direction_900hPa',
            'wind_speed_975hPa','wind_speed_950hPa','wind_speed_900hPa',
            'boundary_layer_height',
            'direct_radiation',
        ].join(',');

        // ── Alle 3 Requests parallel feuern
        const [r1, r2, r3] = await Promise.all([
            fetch(`${BASE}&hourly=${vars1}`).then(r => r.json()),
            fetch(`${BASE}&hourly=${vars2}`).then(r => r.json()),
            fetch(`${BASE}&hourly=${vars3}`).then(r => r.json()),
        ]);

        // Fehlerprüfung für jeden Request
        for (const [idx, d] of [[1,r1],[2,r2],[3,r3]]) {
            if (d.error) return res.status(500).json({ error: `API-Fehler Request ${idx}: ${d.reason || 'Unbekannt'}` });
            if (!d?.hourly?.time?.length) return res.status(500).json({ error: `Keine Daten in Request ${idx}` });
        }

        // ── Hourly-Daten mergen: einfach alle Felder in ein Objekt zusammenführen
        const mergedHourly = {
            time: r1.hourly.time,
            ...r1.hourly,
            ...r2.hourly,
            ...r3.hourly,
        };

        const timezone = r1.timezone || 'UTC';
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

        // ── Member-Suffixe: '' = Control, '_member01'..'_member30'
        const memberSuffixes = [
            '',
            ...Array.from({ length: MEMBER_COUNT }, (_, i) =>
                `_member${String(i + 1).padStart(2, '0')}`)
        ];

        // ═══════════════════════════════════════════════════════════════════
        // Pro Member eine hour-Struktur aus dem gemergten Hourly extrahieren
        // ═══════════════════════════════════════════════════════════════════
        function extractMemberHour(hourly, i, suffix) {
            // suffix = '' (Control) oder '_member01' etc.
            function get(field) {
                const key = `${field}${suffix}`;
                const arr = hourly[key];
                if (Array.isArray(arr) && arr[i] !== null && arr[i] !== undefined) return arr[i];
                // Fallback auf Control (für Single-Vars wie direct_radiation)
                if (suffix !== '') {
                    const arr2 = hourly[field];
                    if (Array.isArray(arr2) && arr2[i] !== null && arr2[i] !== undefined) return arr2[i];
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
            const rawPBL = get('boundary_layer_height'); // nur Control

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
                freezingLevel:   null,
                cin:             null,
                liftedIndex:     null,
                pblHeight:       null,
            };

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
        // Alle 31 Member pro Zeitstempel verarbeiten
        // ═══════════════════════════════════════════════════════════════════
        const hours = mergedHourly.time.map((t, i) => {
            const memberProbs = [];
            let ctrlHour = null;

            for (const suffix of memberSuffixes) {
                const mh = extractMemberHour(mergedHourly, i, suffix);
                if (!mh) continue;
                if (suffix === '') ctrlHour = mh;
                memberProbs.push(calculateLightningProbability(mh));
            }

            if (memberProbs.length === 0) {
                return { time: t, probability: 0, modell_konsens: 'niedrig', modell_stddev: 0 };
            }

            const mean   = memberProbs.reduce((s, p) => s + p, 0) / memberProbs.length;
            const sorted = [...memberProbs].sort((a, b) => a - b);
            const median = sorted.length % 2 === 1
                ? sorted[Math.floor(sorted.length / 2)]
                : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
            const variance = memberProbs.reduce((s, p) => s + (p - mean) ** 2, 0) / memberProbs.length;
            const stddev   = Math.sqrt(variance);

            const kf = stddev <= 15
                ? Math.max(0.65, Math.min(1.15, 1.15 - (stddev / 15) * 0.15))
                : Math.max(0.65, Math.min(1.15, 1.00 - ((stddev - 15) / 25) * 0.35));

            const prob    = Math.round(Math.max(0, Math.min(100, mean * kf)));
            const konsens = stddev <= 10 ? 'hoch' : stddev <= 22 ? 'mittel' : 'niedrig';

            return {
                time:           t,
                probability:    prob,
                modell_konsens: konsens,
                modell_stddev:  Math.round(stddev * 10) / 10,
                member_probs:   memberProbs,
                member_mean:    Math.round(mean * 10) / 10,
                member_median:  Math.round(median * 10) / 10,
                ensHour:        ctrlHour,
                temperature:    ctrlHour ? Math.round(ctrlHour.temperature * 10) / 10 : null,
                cape:           ctrlHour ? Math.round(ctrlHour.cape) : null,
                shear:          ctrlHour ? Math.round(calcShear(ctrlHour) * 10) / 10 : null,
                srh:            ctrlHour ? Math.round(calcSRH(ctrlHour, '0-3km') * 10) / 10 : null,
            };
        });

        // ── Filter: aktuelle + zukünftige Stunden
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

        // ── Debug (erste 20 Stunden, Control-Member)
        const debugStunden = nextHours.slice(0, 20).map(h => {
            const i  = mergedHourly.time.indexOf(h.time);
            const mh = extractMemberHour(mergedHourly, i, '');
            if (!mh) return { timestamp: h.time, error: 'no data' };

            const shear  = calcShear(mh);
            const srh3   = calcSRH(mh, '0-3km');
            const srh1   = calcSRH(mh, '0-1km');
            const scpVal = calcSCP(mh.cape, shear / 3.6, srh3, mh.cin ?? 0);
            const ehiVal = calcEHI(mh);
            const stpVal = calcSTP(mh);

            // CAPE-Spread: Standardabweichung über alle Member
            const capeValues = memberSuffixes
                .map(s => mergedHourly[`cape${s}`]?.[i])
                .filter(v => v !== null && v !== undefined);
            const capeMean = capeValues.reduce((s, v) => s + v, 0) / (capeValues.length || 1);
            const capeSpread = Math.round(Math.sqrt(
                capeValues.reduce((s, v) => s + (v - capeMean) ** 2, 0) / (capeValues.length || 1)
            ));

            return {
                timestamp:         h.time,
                ensemble_gewitter: h.probability,
                member_mean:       h.member_mean,
                member_median:     h.member_median,
                modell_konsens:    h.modell_konsens,
                modell_stddev:     h.modell_stddev,
                member_probs:      h.member_probs,
                control_member: {
                    cape:         Math.round(mh.cape),
                    cape_spread:  capeSpread,
                    cin:          Math.round(mh.cin ?? 0),
                    liftedIndex:  Math.round(mh.liftedIndex * 10) / 10,
                    meanRH:       Math.round(mh.meanRH),
                    q925:         Math.round(mh.q925 * 10) / 10,
                    mlMixRatio:   Math.round(mh.mlMixRatio * 10) / 10,
                    wbzHeight:    Math.round(mh.wbzHeight),
                    elTemp:       Math.round((mh.elTemp ?? -99) * 10) / 10,
                    shear:        Math.round(shear * 10) / 10,
                    srh1km:       Math.round(srh1 * 10) / 10,
                    srh3km:       Math.round(srh3 * 10) / 10,
                    scp:          Math.round(scpVal * 100) / 100,
                    ehi:          Math.round(ehiVal * 100) / 100,
                    stp:          Math.round(stpVal * 100) / 100,
                    temp2m:       mh.temperature,
                    dew2m:        mh.dew,
                    temp850:      mh.temp850,
                    temp500:      mh.temp500,
                    rh850:        Math.round(mh.rh850),
                    rh700:        Math.round(mh.rh700),
                    precipAcc:    Math.round(mh.precipAcc * 10) / 10,
                    radiation:    Math.round(mh.directRadiation),
                },
            };
        });

        return res.status(200).json({
            timezone,
            region,
            modell:        'ncep_gefs05',
            member_count:  memberSuffixes.length,
            stunden,
            tage,
            debug: {
                hinweis: 'AR-CHaMo v3 + GEFS Ensemble (ncep_gefs05, 31 Member). ' +
                    'URL-Split: 3 parallele Requests via Promise.all(). ' +
                    'Request 1: Instabilität+Konvektion, Request 2: Wind+Temp+Feuchte, ' +
                    'Request 3: Einzel-Variablen (Control only).',
                stunden: debugStunden,
            },
        });

    } catch (err) {
        console.error('Fehler:', err);
        return res.status(500).json({ error: err.message || 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}
