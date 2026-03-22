// ═══════════════════════════════════════════════════════════════════════════
// LIGHTNING PROBABILITY API HANDLER
// Methodik: ESSL AR-CHaMo (Rädler 2018) + thundeR-Prädiktoren (Taszarek 2020)
// Prädiktoren: vollständiges thundeR sounding_compute()-Set soweit via
//              Open-Meteo Druckniveaus rekonstruierbar
// Druckniveaus Open-Meteo: 1000/975/950/925/900/850/800/700/600/500/400/300/250/200 hPa
// Variablen pro Level:  temperature, dewpoint, relative_humidity,
//                       wind_speed, wind_direction, geopotential_height
// ═══════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'lat und lon Parameter sind erforderlich' });

    const latitude  = parseFloat(lat);
    const longitude = parseFloat(lon);
    if (isNaN(latitude) || isNaN(longitude))
        return res.status(400).json({ error: 'Ungültige Koordinaten' });

    if (!isEurope(latitude, longitude))
        return res.status(400).json({ error: 'Vorhersage nur für Europa verfügbar', onlyEurope: true });

    // ── Open-Meteo Druckniveaus ─────────────────────────────────────────────
    // Alle verfügbaren Levels die thundeR-Parameter ermöglichen:
    // 1000/975/950/925/900/850/800/700/600/500/400/300/250/200 hPa
    // Variablen: temperature, dewpoint, relative_humidity,
    //            wind_speed (km/h), wind_direction, geopotential_height
    const LEVELS    = [1000,975,950,925,900,850,800,700,600,500,400,300,250,200];
    const LEV_VARS  = ['temperature','dewpoint','relative_humidity','wind_speed','wind_direction','geopotential_height'];
    const MODELS    = ['icon_eu','ecmwf_ifs025','gfs_global'];

    // Surface-Variablen
    const surfaceVars = [
        'temperature_2m',
        'dew_point_2m',
        'wind_speed_10m',
        'wind_gusts_10m',
        'wind_direction_10m',
        'cape',
        'convective_inhibition',
        'lifted_index',
        'freezing_level_height',
        'boundary_layer_height',
        'precipitation',
        'precipitation_probability',
        'total_column_integrated_water_vapour',
        'direct_radiation',
        'cloud_cover_low',
        'cloud_cover_mid',
        'cloud_cover_high',
    ].join(',');

    // Druckniveau-Variablen dynamisch aufbauen
    const pressureVars = LEVELS.flatMap(lv =>
        LEV_VARS.map(v => `${v}_${lv}hPa`)
    ).join(',');

    const apiUrl =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${latitude}&longitude=${longitude}` +
        `&hourly=${surfaceVars},${pressureVars}` +
        `&forecast_days=16` +
        `&models=${MODELS.join(',')}` +
        `&timezone=auto`;

    try {
        const response = await fetch(apiUrl);
        const data     = await response.json();

        if (data.error)                      return res.status(500).json({ error: 'API-Fehler: ' + (data.reason || 'Unbekannt') });
        if (!data?.hourly?.time?.length)     return res.status(500).json({ error: 'Keine Daten verfügbar' });

        const timezone = data.timezone || 'UTC';
        const now      = new Date();

        // Aktuelles Datum/Stunde in lokaler Zeitzone
        const localStr    = now.toLocaleString('en-CA', { year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false,timeZone:timezone });
        const [currentDateStr, currentHourStr] = localStr.split(', ');
        const currentHour = parseInt(currentHourStr?.split(':')[0] ?? '0', 10);

        // ── Schritt 1: Pro Modell Stundenwerte extrahieren ─────────────────
        function getVal(hourly, field, model, i) {
            const key = `${field}_${model}`;
            const arr = hourly[key];
            if (Array.isArray(arr) && arr[i] != null) return arr[i];
            return null;
        }

        // Vollständiges Druckniveau-Profil für thundeR-Parameter
        // Gibt sortiertes Array von {p, z, T, Td, rh, ws_ms, wd} zurück
        function buildProfile(hourly, i, model) {
            const profile = [];
            for (const lv of LEVELS) {
                const T  = getVal(hourly, `temperature_${lv}hPa`,        model, i);
                const Td = getVal(hourly, `dewpoint_${lv}hPa`,           model, i);
                const rh = getVal(hourly, `relative_humidity_${lv}hPa`,  model, i);
                const ws = getVal(hourly, `wind_speed_${lv}hPa`,         model, i);  // km/h
                const wd = getVal(hourly, `wind_direction_${lv}hPa`,     model, i);
                const z  = getVal(hourly, `geopotential_height_${lv}hPa`,model, i);

                if (T === null) continue;  // Level nicht verfügbar für dieses Modell

                profile.push({
                    p:      lv,
                    z:      z  ?? pressureToAltitude(lv),  // Fallback: Standardatmosphäre
                    T,
                    Td:     Td ?? deriveDewpoint(T, rh ?? 70),
                    rh:     rh ?? calcRH(T, Td ?? T - 5),
                    ws_ms:  ws != null ? ws / 3.6 : 0,     // km/h → m/s
                    wd:     wd ?? 0,
                });
            }
            // Aufsteigend nach Druck (Surface zuerst)
            return profile.sort((a, b) => b.p - a.p);
        }

        function extractSurface(hourly, i, model) {
            const g = (f) => getVal(hourly, f, model, i);
            const t2m = g('temperature_2m');
            const d2m = g('dew_point_2m');
            if (t2m === null) return null;

            return {
                t2m,
                d2m:         d2m ?? (t2m - 10),
                ws10:        (g('wind_speed_10m')   ?? 0),           // km/h
                ws10_ms:     (g('wind_speed_10m')   ?? 0) / 3.6,
                gust_ms:     (g('wind_gusts_10m')   ?? 0) / 3.6,
                wd10:        g('wind_direction_10m') ?? 0,
                cape:        Math.max(0, g('cape')             ?? 0),
                cin:         g('convective_inhibition')         ?? 0,
                li:          g('lifted_index')                  ?? null,
                frzLvl:      g('freezing_level_height')         ?? 3000,
                pblH:        g('boundary_layer_height')         ?? null,
                precip:      g('precipitation')                 ?? 0,
                precipProb:  g('precipitation_probability')    ?? 0,
                pwat:        g('total_column_integrated_water_vapour') ?? 25,
                radiation:   g('direct_radiation')              ?? 0,
                cloudLow:    g('cloud_cover_low')               ?? 0,
                cloudMid:    g('cloud_cover_mid')               ?? 0,
                cloudHigh:   g('cloud_cover_high')              ?? 0,
            };
        }

        // ── Schritt 2: thundeR-Prädiktoren aus Profil berechnen ───────────
        // Alle Parameter analog zu sounding_compute() – rekonstruiert aus
        // diskreten Druckniveaus (accuracy=1 äquivalent)

        function computeThunderParams(sfc, profile) {
            if (!profile.length || !sfc) return null;

            // ── Lapse Rates (LR_*) ──────────────────────────────────────
            const LR = computeLapseRates(profile, sfc);

            // ── CAPE/CIN/LCL/LFC/EL (SB, ML, MU) ──────────────────────
            const SB = computeParcel(sfc.t2m, sfc.d2m, 1013.25, sfc, profile, 'SB');
            const ML = computeMLParcel(sfc, profile);
            const MU = computeMUParcel(sfc, profile);

            // ── Feuchte-Indizes ─────────────────────────────────────────
            const p850  = interpProfile(profile, 850);
            const p700  = interpProfile(profile, 700);
            const p500  = interpProfile(profile, 500);
            const p300  = interpProfile(profile, 300);
            const p200  = interpProfile(profile, 200);
            const p925  = interpProfile(profile, 925);
            const p1000 = interpProfile(profile, 1000);

            const PRCP_WATER = sfc.pwat;
            const RH_01km   = avgRH(profile, 0,    1000);
            const RH_02km   = avgRH(profile, 0,    2000);
            const RH_14km   = avgRH(profile, 1000, 4000);
            const RH_25km   = avgRH(profile, 2000, 5000);
            const RH_36km   = avgRH(profile, 3000, 6000);

            // ── Theta-E ─────────────────────────────────────────────────
            const ThetaE_01km = thetaE(sfc.t2m, sfc.d2m, 1013.25);
            const ThetaE_02km = p850 ? thetaE(p850.T, p850.Td, 850) : ThetaE_01km;
            const Delta_ThetaE = ThetaE_01km - (p500 ? thetaE(p500.T, p500.Td, 500) : ThetaE_01km - 10);

            // ── DCAPE & Cold Pool ────────────────────────────────────────
            const DCAPE = computeDCAPE(profile, p700, p500);
            const CPS   = DCAPE > 0 ? Math.sqrt(2 * DCAPE) : 0;  // Cold_Pool_Strength [m/s]

            // ── Kinetik: Bulk Shear ──────────────────────────────────────
            const BS = computeBulkShear(sfc, profile);

            // ── Mittlere Windvektoren (MW_*) ────────────────────────────
            const MW = computeMeanWinds(sfc, profile);

            // ── Bunkers Storm Motion ────────────────────────────────────
            const bunkers = computeBunkers(MW, BS);

            // ── SRH (Storm Relative Helicity) ────────────────────────────
            const SRH = computeSRH(sfc, profile, bunkers);

            // ── Composite-Indizes ────────────────────────────────────────
            const K_Index       = p850 && p700 && p500
                ? (p850.T - p500.T) + p850.Td - (p700.T - p700.Td)
                : 0;
            const Showalter     = p500 && p850
                ? p500.T - liftParcel(p850.T, p850.Td, 850, 500)
                : 0;
            const TotalTotals   = p850 && p700 && p500
                ? (p850.T + p850.Td) - (2 * p500.T)
                : 0;
            const SWEAT         = computeSWEAT(p850, p500, SRH.SRH_1km_RM, TotalTotals);

            const MU_WMAXSHEAR  = Math.sqrt(2 * MU.CAPE)  * BS.BS_06km;
            const SB_WMAXSHEAR  = Math.sqrt(2 * SB.CAPE)  * BS.BS_06km;
            const ML_WMAXSHEAR  = Math.sqrt(2 * ML.CAPE)  * BS.BS_06km;

            const EHI_01km = SB.CAPE > 0 ? (SB.CAPE * SRH.SRH_1km_RM) / 160000 : 0;
            const EHI_03km = SB.CAPE > 0 ? (SB.CAPE * SRH.SRH_3km_RM) / 160000 : 0;

            const SCP_fix  = computeSCP(MU.CAPE, BS.BS_06km, SRH.SRH_3km_RM, sfc.cin);
            const STP_fix  = computeSTP(SB.CAPE, SRH.SRH_1km_RM, BS.BS_06km, SB.LCL_HGT, sfc.cin);

            const SHIP     = computeSHIP(MU, BS, p500, p700);
            const DCP      = computeDCP(DCAPE, MU.CAPE, BS.BS_06km, SRH.SRH_1km_RM);

            // ── Wind_Index (Modifizierter McCann 1994) ───────────────────
            const Wind_Index = computeWindIndex(MU.CAPE, DCAPE, BS.BS_06km, sfc.frzLvl);

            // SHERBS3 / SHERBE (Sherburn & Parker 2014 – HSLC)
            const SHERBS3  = computeSHERBS3(LR.LR_36km, BS.BS_06km, SRH.SRH_3km_RM, MU.CAPE);
            const SHERBE   = computeSHERBE (LR.LR_36km, BS.BS_06km, SRH.SRH_3km_RM, MU.CAPE);

            // DEI (Gropp & Davenport 2019 – dominant Superzellen-Index)
            const DEI      = computeDEI(MU.CAPE, SCP_fix, BS.BS_06km);

            // TIP (Tornadic Index für Europa, Púčik 2015)
            const TIP      = computeTIP(MU.CAPE, SRH.SRH_1km_RM, BS.BS_06km, SB.LCL_HGT);

            // Moisture Flux 0-2km
            const MoistFlux02 = computeMoistureFlux(sfc, profile, 2000);

            return {
                // ── CAPE / CIN ────────────────────────────────────────
                MU_CAPE:        MU.CAPE,
                MU_CIN:         MU.CIN,
                MU_LCL_HGT:    MU.LCL_HGT,
                MU_LFC_HGT:    MU.LFC_HGT,
                MU_EL_HGT:     MU.EL_HGT,
                MU_EL_TEMP:    MU.EL_TEMP,
                MU_LI:         MU.LI,
                MU_WMAX:       Math.sqrt(2 * Math.max(0, MU.CAPE)),
                MU_MIXR:       mixingRatio(MU.Td_parcel, MU.p_parcel ?? 850),

                SB_CAPE:       SB.CAPE,
                SB_CIN:        SB.CIN,
                SB_LCL_HGT:   SB.LCL_HGT,
                SB_LFC_HGT:   SB.LFC_HGT,
                SB_EL_HGT:    SB.EL_HGT,
                SB_EL_TEMP:   SB.EL_TEMP,
                SB_LI:        SB.LI,
                SB_WMAX:      Math.sqrt(2 * Math.max(0, SB.CAPE)),
                SB_MIXR:      mixingRatio(sfc.d2m, 1013.25),

                ML_CAPE:      ML.CAPE,
                ML_CIN:       ML.CIN,
                ML_LCL_HGT:  ML.LCL_HGT,
                ML_LFC_HGT:  ML.LFC_HGT,
                ML_EL_HGT:   ML.EL_HGT,
                ML_EL_TEMP:  ML.EL_TEMP,
                ML_LI:       ML.LI,
                ML_WMAX:     Math.sqrt(2 * Math.max(0, ML.CAPE)),
                ML_MIXR:     ML.mixR,

                // ── CAPE-Teilschichten (thundeR: 0-2km, 0-3km, HGL) ─
                SB_02km_CAPE: partialCAPE(sfc, profile, SB, 0,    2000),
                SB_03km_CAPE: partialCAPE(sfc, profile, SB, 0,    3000),
                MU_03km_CAPE: partialCAPE(sfc, profile, MU, 0,    3000),

                // ── Lapse Rates ──────────────────────────────────────
                LR_01km:      LR.LR_01km,
                LR_02km:      LR.LR_02km,
                LR_03km:      LR.LR_03km,
                LR_06km:      LR.LR_06km,
                LR_16km:      LR.LR_16km,
                LR_26km:      LR.LR_26km,
                LR_36km:      LR.LR_36km,
                LR_500700hPa: LR.LR_500700hPa,
                LR_500800hPa: LR.LR_500800hPa,
                LR_600800hPa: LR.LR_600800hPa,

                // ── Gefrierniveau ────────────────────────────────────
                FRZG_HGT:          sfc.frzLvl,
                FRZG_wetbulb_HGT:  sfc.frzLvl - 200,  // Approx.

                // ── Theta-E ──────────────────────────────────────────
                Thetae_01km:       ThetaE_01km,
                Thetae_02km:       ThetaE_02km,
                Delta_thetae:      Delta_ThetaE,
                HGT_max_thetae_03km: maxThetaEHeight(profile, sfc, 3000),
                HGT_min_thetae_04km: minThetaEHeight(profile, sfc, 4000),

                // ── Feuchte ──────────────────────────────────────────
                PRCP_WATER:        PRCP_WATER,
                RH_01km,
                RH_02km,
                RH_14km,
                RH_25km,
                RH_36km,
                Moisture_Flux_02km: MoistFlux02,

                // ── DCAPE / Wind ─────────────────────────────────────
                DCAPE,
                Cold_Pool_Strength: CPS,
                Wind_Index,

                // ── Bulk Shear ────────────────────────────────────────
                BS_01km:       BS.BS_01km,
                BS_02km:       BS.BS_02km,
                BS_03km:       BS.BS_03km,
                BS_06km:       BS.BS_06km,
                BS_08km:       BS.BS_08km,
                BS_36km:       BS.BS_36km,
                BS_26km:       BS.BS_26km,
                BS_16km:       BS.BS_16km,

                // ── Mittlere Winde ────────────────────────────────────
                MW_01km:       MW.MW_01km,
                MW_02km:       MW.MW_02km,
                MW_03km:       MW.MW_03km,
                MW_06km:       MW.MW_06km,

                // ── SRH ───────────────────────────────────────────────
                SRH_500m_RM:   SRH.SRH_500m_RM,
                SRH_1km_RM:    SRH.SRH_1km_RM,
                SRH_3km_RM:    SRH.SRH_3km_RM,

                // ── Indizes ───────────────────────────────────────────
                K_Index,
                Showalter_Index: Showalter,
                TotalTotals_Index: TotalTotals,
                SWEAT_Index:    SWEAT,
                SCP_fix,
                STP_fix,
                EHI_01km,
                EHI_03km,
                SHIP,
                DCP,
                SHERBS3,
                SHERBE,
                DEI,
                TIP,

                // ── WMAXSHEAR ─────────────────────────────────────────
                MU_WMAXSHEAR:  Math.round(MU_WMAXSHEAR),
                SB_WMAXSHEAR:  Math.round(SB_WMAXSHEAR),
                ML_WMAXSHEAR:  Math.round(ML_WMAXSHEAR),

                // ── Bunkers Storm Motion ──────────────────────────────
                Bunkers_RM_M:  bunkers.RM_speed,
                Bunkers_RM_A:  bunkers.RM_dir,
                Bunkers_LM_M:  bunkers.LM_speed,
                Bunkers_LM_A:  bunkers.LM_dir,

                // ── Oberflächenwerte für Ausgabe ─────────────────────
                T2m:           sfc.t2m,
                Td2m:          sfc.d2m,
                CAPE_sfc:      sfc.cape,       // API-CAPE direkt
                CIN_sfc:       sfc.cin,
                LI_sfc:        sfc.li,
                PWAT:          sfc.pwat,
                FRZ_LVL:       sfc.frzLvl,
                PBL_H:         sfc.pblH ?? ML.LCL_HGT,
                RADIATION:     sfc.radiation,
            };
        }

        // ── Schritt 3: Gewitterwahrscheinlichkeit aus thundeR-Params ───────
        // AR-CHaMo Logistik: Rädler 2018 / Taszarek 2021
        // Primärprädiktoren: MUCAPE, ML-WMAXSHEAR, SRH1km, DCAPE, MeanRH, ThetaE850
        function calculateLightningProb(p, sfc) {
            if (!p) return 0;

            const cape      = Math.max(0, p.MU_CAPE);
            const sbCape    = Math.max(0, p.SB_CAPE);
            const cin       = sfc.cin ?? 0;
            const magCin    = -Math.min(0, cin);

            // Harte Ausschlüsse (physikalische Mindestbedingungen)
            if (sfc.t2m  < 3  && cape < 300)                  return 0;
            if (sfc.t2m  < 8  && cape < 180 && p.BS_06km < 15) return 0;
            if (cape     < 80 && sfc.precip < 0.1 && sfc.precipProb < 15) return 0;
            if (magCin   > 300)                                return 0;

            const wmaxshear = p.ML_WMAXSHEAR;     // thundeR Haupt-Prädiktor
            const shear06   = p.BS_06km;           // 0-6km Bulk Shear [m/s]
            const srh1km    = p.SRH_1km_RM;        // 0-1km SRH [m²/s²]
            const srh3km    = p.SRH_3km_RM;
            const dcape     = p.DCAPE;
            const lr36      = p.LR_36km;           // 3-6 km Lapse Rate [K/km]
            const lr26      = p.LR_26km;           // 2-6 km Lapse Rate
            const muEl      = p.MU_EL_TEMP ?? -15; // EL-Temperatur
            const lclH      = p.SB_LCL_HGT;
            const meanRH    = (p.RH_14km + p.RH_25km + p.RH_36km) / 3;  // 1-6km RH
            const thetaE    = p.Thetae_01km;
            const deltaTE   = p.Delta_thetae;      // Lapse der Theta-E
            const pwat      = p.PWAT;
            const pbl       = p.PBL_H;
            const mixR850   = p.ML_MIXR;           // Mixing Ratio
            const kIdx      = p.K_Index;
            const ttIdx     = p.TotalTotals_Index;
            const scp       = p.SCP_fix;
            const stp       = p.STP_fix;
            const ehi1      = p.EHI_01km;
            const ship      = p.SHIP;
            const sherbs3   = p.SHERBS3;

            // ── HSLC-Regime (High Shear Low CAPE) ───────────────────────
            // Sherburn & Parker 2014; SHERBS3 > 1.0 = konvektiv kritisch
            if (cape < 300 && shear06 >= 18) {
                let hslcScore = 0;
                if      (shear06 >= 25) hslcScore += 30;
                else if (shear06 >= 20) hslcScore += 20;
                else                    hslcScore += 10;
                if      (sherbs3 >= 1.0) hslcScore += 25;
                else if (sherbs3 >= 0.5) hslcScore += 12;
                if      (meanRH >= 65)   hslcScore += 12;
                else if (meanRH <  50)   hslcScore -= 15;
                if (sfc.t2m < 8) hslcScore = Math.round(hslcScore * 0.6);
                return Math.min(60, Math.max(0, hslcScore));
            }

            let score = 0;

            // ── (1) MUCAPE – abgeflacht (Westermayer 2017: Plateau ab ~500) ─
            if      (cape >= 2000) score += 16;
            else if (cape >= 1500) score += 14;
            else if (cape >= 1200) score += 12;
            else if (cape >= 800)  score += 10;
            else if (cape >= 500)  score += 8;
            else if (cape >= 300)  score += 6;
            else if (cape >= 150)  score += 3;

            // ── (2) ML_WMAXSHEAR – Taszarek 2020 bester Single-Prädiktor ─
            if      (wmaxshear >= 1500) score += 22;
            else if (wmaxshear >= 1200) score += 18;
            else if (wmaxshear >= 900)  score += 14;
            else if (wmaxshear >= 700)  score += 10;
            else if (wmaxshear >= 500)  score += 6;
            else if (wmaxshear >= 400)  score += 3;
            else if (wmaxshear >= 300)  score += 1;

            // ── (3) 0-6km Bulk Shear ─────────────────────────────────────
            if      (shear06 >= 25) score += 13;
            else if (shear06 >= 20) score += 10;
            else if (shear06 >= 15) score += 7;
            else if (shear06 >= 12) score += 4;
            else if (shear06 >= 10) score += 2;

            // ── (4) SRH 0-1km (Taszarek 2020 Part II) ───────────────────
            if      (srh1km >= 200) score += 12;
            else if (srh1km >= 150) score += 9;
            else if (srh1km >= 100) score += 6;
            else if (srh1km >= 60)  score += 3;
            else if (srh1km >= 30)  score += 1;

            // ── (5) SRH 0-3km ────────────────────────────────────────────
            if      (srh3km >= 300) score += 8;
            else if (srh3km >= 200) score += 6;
            else if (srh3km >= 150) score += 4;
            else if (srh3km >= 100) score += 2;

            // ── (6) SCP (Supercell Composite) ────────────────────────────
            if      (scp >= 3.0) score += 22;
            else if (scp >= 2.0) score += 18;
            else if (scp >= 1.5) score += 14;
            else if (scp >= 1.0) score += 10;

            // ── (7) STP ──────────────────────────────────────────────────
            if      (stp >= 2.0) score += 16;
            else if (stp >= 1.5) score += 13;
            else if (stp >= 1.0) score += 10;
            else if (stp >= 0.5) score += 6;
            else if (stp >= 0.3) score += 3;

            // ── (8) EHI 0-1km ────────────────────────────────────────────
            if      (ehi1 >= 2.5) score += 12;
            else if (ehi1 >= 2.0) score += 10;
            else if (ehi1 >= 1.0) score += 7;
            else if (ehi1 >= 0.5) score += 4;

            // ── (9) DCAPE (Downburst-Potential) ──────────────────────────
            if      (dcape >= 1000 && cape >= 400) score += 7;
            else if (dcape >= 800  && cape >= 300) score += 5;
            else if (dcape >= 600  && cape >= 200) score += 3;
            else if (dcape >= 400  && cape >= 150) score += 1;

            // ── (10) EL-Temperatur Proxy (ESTOFEX-Indikator) ─────────────
            if      (muEl <= -25 && cape >= 200) score += 10;
            else if (muEl <= -20 && cape >= 150) score += 7;
            else if (muEl <= -15 && cape >= 100) score += 4;
            else if (muEl <= -10 && cape >= 80)  score += 2;
            else if (muEl >  -5  && cape <  500) score -= 5;

            // ── (11) 3-6km Lapse Rate (thundeR: LR_36km) ─────────────────
            if      (lr36 >= 8.5) score += 8;
            else if (lr36 >= 8.0) score += 6;
            else if (lr36 >= 7.5) score += 4;
            else if (lr36 >= 7.0) score += 2;
            else if (lr36 <  5.5 && cape < 800) score -= 5;

            // ── (12) LCL-Höhe ─────────────────────────────────────────────
            if      (lclH <  500)  score += 8;
            else if (lclH <  800)  score += 6;
            else if (lclH <  1200) score += 4;
            else if (lclH <  1500) score += 2;
            else if (lclH >= 2500) score -= 6;

            // ── (13) Mittlere RH 1-6km (AR-CHaMo Rädler 2018) ────────────
            if      (meanRH >= 75) score += 8;
            else if (meanRH >= 65) score += 5;
            else if (meanRH >= 55) score += 2;
            else if (meanRH <  50) score -= 12;
            else if (meanRH <  40) score -= 20;

            // ── (14) Theta-E 0-1km (ESTOFEX: > 335K gut, > 345K sehr instabil) ─
            if      (thetaE >= 345) score += 8;
            else if (thetaE >= 335) score += 5;
            else if (thetaE >= 325) score += 2;
            else if (thetaE <  315) score -= 4;

            // ── (15) Delta-Theta-E (Instabilitätsmaß – thundeR) ──────────
            if      (deltaTE >= 20) score += 6;
            else if (deltaTE >= 15) score += 4;
            else if (deltaTE >= 10) score += 2;
            else if (deltaTE <   5) score -= 3;

            // ── (16) K-Index ──────────────────────────────────────────────
            if      (kIdx >= 38) score += 7;
            else if (kIdx >= 35) score += 5;
            else if (kIdx >= 30) score += 3;
            else if (kIdx >= 25) score += 1;

            // ── (17) Total Totals ─────────────────────────────────────────
            if      (ttIdx >= 55) score += 5;
            else if (ttIdx >= 50) score += 3;
            else if (ttIdx >= 45) score += 1;

            // ── (18) PWAT (Niederschlagswasser) ───────────────────────────
            if      (pwat >= 35 && cape >= 500) score += 5;
            else if (pwat >= 25 && cape >= 300) score += 3;
            else if (pwat >= 15 && cape >= 200) score += 1;

            // ── (19) Mixing Ratio ML (Feuchte) ────────────────────────────
            if      (mixR850 >= 13) score += 7;
            else if (mixR850 >= 10) score += 4;
            else if (mixR850 >= 6)  score += 1;
            else if (mixR850 <  4)  score -= 5;

            // ── (20) CIN (Hemmung) ────────────────────────────────────────
            if      (magCin <  25 && cape >= 300) score += 5;
            else if (magCin <  50 && cape >= 200) score += 2;
            else if (magCin > 200)                score -= 18;
            else if (magCin > 100)                score -= 10;
            else if (magCin > 50)                 score -= 5;

            // ── (21) Precipitation (Auslösung-Indikator) ─────────────────
            if      (sfc.precip >= 3.0 && cape >= 600) score += 7;
            else if (sfc.precip >= 2.0 && cape >= 400) score += 5;
            else if (sfc.precip >= 1.0 && cape >= 300) score += 3;
            else if (sfc.precip >= 0.5 && cape >= 200) score += 1;
            if      (sfc.precipProb >= 70 && cape >= 500) score += 5;
            else if (sfc.precipProb >= 55 && cape >= 400) score += 3;
            else if (sfc.precipProb >= 40 && cape >= 300) score += 1;

            // ── (22) Strahlung / Tageszeit ────────────────────────────────
            const isNight     = sfc.radiation < 20;
            const isDaytime   = sfc.radiation >= 200;
            const isStrongDay = sfc.radiation >= 600;
            if      (isStrongDay && sfc.t2m >= 14 && cape >= 300) score += 7;
            else if (isDaytime   && sfc.t2m >= 12 && cape >= 200) score += 4;
            else if (isNight) {
                const llj = srh1km >= 100 && shear06 >= 12 && sfc.ws10_ms >= 8;
                if (llj && cape >= 500) score += 5;
                else if (!llj && shear06 < 10 && cape < 400) score -= 4;
            }

            // ── (23) PBL-Höhe (thundeR: boundary_layer_height) ───────────
            if      (pbl >= 2000 && cape >= 300) score += 4;
            else if (pbl >= 1500 && cape >= 200) score += 2;
            else if (pbl <  300  && cape <  500) score -= 3;

            // ── (24) SHIP (Severe Hail Index – Proxy für tiefe Konvektion) ─
            if      (ship >= 2.0 && cape >= 1000) score += 5;
            else if (ship >= 1.0 && cape >= 500)  score += 3;
            else if (ship >= 0.5 && cape >= 300)  score += 1;

            // ── Temperatur-Skalierung ─────────────────────────────────────
            if      (sfc.t2m < 8)  score = Math.round(score * (shear06 < 15 && cape < 500 ? 0.4 : 0.6));
            else if (sfc.t2m < 12) score = Math.round(score * 0.7);
            else if (sfc.t2m < 15) score = Math.round(score * 0.85);

            // ── Korrekturen ───────────────────────────────────────────────
            if (score > 0 && cape < 100 && shear06 < 8) score = Math.max(0, score - 10);
            if (score > 0 && magCin > 150 && cape < 1000) score = Math.max(0, score - 12);

            // Mindestschwelle bei hohem Shear
            if (shear06 >= 20 && cape >= 150 && score < 30) score = Math.min(score + 5, 35);

            return Math.min(100, Math.max(0, Math.round(score)));
        }

        // ── Schritt 4: Modellgewichtung ────────────────────────────────────
        function getModelWeight(model, leadH) {
            if (leadH <= 48)  return {icon_eu:0.45, ecmwf_ifs025:0.35, gfs_global:0.20}[model] ?? 0.33;
            if (leadH <= 120) return {icon_eu:0.33, ecmwf_ifs025:0.42, gfs_global:0.25}[model] ?? 0.33;
            return                    {icon_eu:0.20, ecmwf_ifs025:0.55, gfs_global:0.25}[model] ?? 0.33;
        }

        function ensembleProb(probsByModel, leadH) {
            let wSum = 0, wTot = 0;
            for (const [model, prob] of Object.entries(probsByModel)) {
                if (prob === null) continue;
                const w = getModelWeight(model, leadH);
                wSum += prob * w;
                wTot += w;
            }
            return wTot === 0 ? 0 : Math.round(wSum / wTot);
        }

        function ensembleMean(vals) {
            const v = vals.filter(x => x != null && !isNaN(x));
            return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
        }

        // ── Schritt 5: Alle Stunden verarbeiten ────────────────────────────
        const hours = data.hourly.time.map((t, i) => {
            const fTime   = new Date(t);
            const leadH   = Math.round((fTime - now) / 3600000);

            const gewitterByModel = {};
            const paramsByModel   = {};

            for (const model of MODELS) {
                const sfc     = extractSurface(data.hourly, i, model);
                const profile = buildProfile(data.hourly, i, model);
                const params  = computeThunderParams(sfc, profile);
                paramsByModel[model]   = params;
                gewitterByModel[model] = sfc ? calculateLightningProb(params, sfc) : null;
            }

            const prob = ensembleProb(gewitterByModel, leadH);

            // Display-Mittelwerte aus Ensemble
            const validParams = Object.values(paramsByModel).filter(Boolean);
            const mean = (fn) => ensembleMean(validParams.map(fn));

            return {
                time:        t,
                probability: prob,
                // Wichtigste Parameter für Debug/Anzeige
                cape:        Math.round(mean(p => p.MU_CAPE)),
                shear06:     Math.round(mean(p => p.BS_06km) * 10) / 10,
                srh1km:      Math.round(mean(p => p.SRH_1km_RM)),
                srh3km:      Math.round(mean(p => p.SRH_3km_RM)),
                wmaxshear:   Math.round(mean(p => p.ML_WMAXSHEAR)),
                dcape:       Math.round(mean(p => p.DCAPE)),
                li:          Math.round(mean(p => p.SB_LI) * 10) / 10,
                kIndex:      Math.round(mean(p => p.K_Index)),
                theta_e:     Math.round(mean(p => p.Thetae_01km)),
                lr36:        Math.round(mean(p => p.LR_36km) * 10) / 10,
                scp:         Math.round(mean(p => p.SCP_fix) * 100) / 100,
                stp:         Math.round(mean(p => p.STP_fix) * 100) / 100,
                ship:        Math.round(mean(p => p.SHIP)    * 100) / 100,
            };
        });

        // ── Schritt 6: Ausgabe filtern ─────────────────────────────────────
        const nextHours = hours
            .filter(h => {
                const [dp, tp] = h.time.split('T');
                const hr = parseInt(tp?.split(':')[0] ?? '0', 10);
                return dp > currentDateStr || (dp === currentDateStr && hr >= currentHour);
            })
            .slice(0, 24);

        const daysMap = new Map();
        hours.forEach(h => {
            const [dp] = h.time.split('T');
            if (dp >= currentDateStr) {
                if (!daysMap.has(dp)) {
                    daysMap.set(dp, { date: dp, maxProbability: h.probability });
                } else {
                    const d = daysMap.get(dp);
                    d.maxProbability = Math.max(d.maxProbability, h.probability);
                }
            }
        });

        const stunden = nextHours.map(h => ({
            timestamp:     h.time,
            gewitter:      h.probability,
            gewitter_risk: categorizeRisk(h.probability),
            // Prädiktoren für Frontend-Anzeige
            cape:          h.cape,
            shear_06km:    h.shear06,
            srh_1km:       h.srh1km,
            srh_3km:       h.srh3km,
            wmaxshear:     h.wmaxshear,
            dcape:         h.dcape,
            lifted_index:  h.li,
            k_index:       h.kIndex,
            theta_e:       h.theta_e,
            lr_36km:       h.lr36,
            scp:           h.scp,
            stp:           h.stp,
            ship:          h.ship,
        }));

        const tage = Array.from(daysMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(day => ({
                date:          day.date,
                gewitter:      day.maxProbability,
                gewitter_risk: categorizeRisk(day.maxProbability),
            }));

        return res.status(200).json({ timezone, stunden, tage });

    } catch (err) {
        console.error('Fehler:', err);
        return res.status(500).json({ error: 'Netzwerkfehler beim Laden der Wetterdaten' });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PHYSIKALISCHE HILFSFUNKTIONEN
// ═══════════════════════════════════════════════════════════════════════════

function isEurope(lat, lon) {
    return lat >= 35 && lat <= 70 && lon >= -10 && lon <= 40;
}

function categorizeRisk(prob) {
    const p = Math.max(0, Math.min(100, Math.round(prob ?? 0)));
    if (p >= 70) return { level: 3, label: 'high' };
    if (p >= 45) return { level: 2, label: 'moderate' };
    if (p >= 15) return { level: 1, label: 'tstorm' };
    return { level: 0, label: 'none' };
}

// Standardatmosphäre Höhe aus Druck (ISA-Approximation)
function pressureToAltitude(p_hPa) {
    return 44330 * (1 - Math.pow(p_hPa / 1013.25, 0.1903));
}

// Taupunkt aus Temperatur und RH
function deriveDewpoint(T, rh) {
    const a = 17.625, b = 243.04;
    const gamma = Math.log(rh / 100) + a * T / (b + T);
    return (b * gamma) / (a - gamma);
}

// Relative Feuchte aus T und Td
function calcRH(T, Td) {
    const es = 6.112 * Math.exp(17.67 * T  / (T  + 243.5));
    const e  = 6.112 * Math.exp(17.67 * Td / (Td + 243.5));
    return Math.min(100, Math.max(0, (e / es) * 100));
}

// Mischungsverhältnis [g/kg]
function mixingRatio(Td, p_hPa) {
    const e = 6.112 * Math.exp(17.67 * Td / (Td + 243.5));
    return 1000 * 0.622 * e / (p_hPa - e);
}

// Theta-E nach Bolton (1980)
function thetaE(T, Td, p) {
    const T_K = T + 273.15;
    const e   = 6.112 * Math.exp(17.67 * Td / (Td + 243.5));
    const q   = 0.622 * e / (p - e);
    return T_K * Math.pow(1000 / p, 0.285) * Math.exp(2501000 * q / (1005 * T_K));
}

// Lineares Interpolieren zwischen Druckniveaus
function interpProfile(profile, p_target) {
    if (!profile.length) return null;
    const above = profile.filter(l => l.p <= p_target).sort((a,b) => b.p - a.p)[0];
    const below = profile.filter(l => l.p >= p_target).sort((a,b) => a.p - b.p)[0];
    if (!above && !below) return null;
    if (!above) return below;
    if (!below) return above;
    if (above.p === below.p) return above;
    const frac = (Math.log(p_target) - Math.log(below.p)) / (Math.log(above.p) - Math.log(below.p));
    return {
        p:    p_target,
        z:    below.z  + frac * (above.z  - below.z),
        T:    below.T  + frac * (above.T  - below.T),
        Td:   below.Td + frac * (above.Td - below.Td),
        rh:   below.rh + frac * (above.rh - below.rh),
        ws_ms:below.ws_ms + frac * (above.ws_ms - below.ws_ms),
        wd:   interpAngle(below.wd, above.wd, frac),
    };
}

function interpAngle(a1, a2, frac) {
    let diff = a2 - a1;
    if (diff >  180) diff -= 360;
    if (diff < -180) diff += 360;
    return (a1 + frac * diff + 360) % 360;
}

// Wind U/V Komponenten
function toUV(ws, wd) {
    const r = wd * Math.PI / 180;
    return { u: -ws * Math.sin(r), v: -ws * Math.cos(r) };
}

// Lapse Rates [K/km] zwischen Höhen aus Profil
function computeLapseRates(profile, sfc) {
    function lrBetween(z1, z2) {
        const interp1 = getAtZ(profile, sfc, z1);
        const interp2 = getAtZ(profile, sfc, z2);
        if (!interp1 || !interp2) return 0;
        const dz = (z2 - z1) / 1000;
        return dz > 0 ? (interp1.T - interp2.T) / dz : 0;
    }
    function lrBetweenP(p1, p2) {
        const l1 = interpProfile(profile, p1);
        const l2 = interpProfile(profile, p2);
        if (!l1 || !l2) return 0;
        const dz = (l2.z - l1.z) / 1000;
        return dz > 0 ? (l1.T - l2.T) / dz : 0;
    }
    return {
        LR_01km:      lrBetween(0, 1000),
        LR_02km:      lrBetween(0, 2000),
        LR_03km:      lrBetween(0, 3000),
        LR_06km:      lrBetween(0, 6000),
        LR_16km:      lrBetween(1000, 6000),
        LR_26km:      lrBetween(2000, 6000),
        LR_36km:      lrBetween(3000, 6000),
        LR_500700hPa: lrBetweenP(700, 500),
        LR_500800hPa: lrBetweenP(800, 500),
        LR_600800hPa: lrBetweenP(800, 600),
    };
}

// Profil-Wert bei Zielhöhe (AGL)
function getAtZ(profile, sfc, z_agl) {
    if (z_agl === 0) return { T: sfc.t2m, Td: sfc.d2m, rh: calcRH(sfc.t2m, sfc.d2m) };
    // Annahme: profile.z ist bereits AGL (erster Level = Surface)
    const above = profile.filter(l => l.z >= z_agl).sort((a,b) => a.z - b.z)[0];
    const below = profile.filter(l => l.z <  z_agl).sort((a,b) => b.z - a.z)[0];
    if (!above) return profile[profile.length - 1];
    if (!below) return { T: sfc.t2m, Td: sfc.d2m };
    const frac = (z_agl - below.z) / (above.z - below.z);
    return { T: below.T + frac * (above.T - below.T), Td: below.Td + frac * (above.Td - below.Td) };
}

// LCL-Höhe [m] – Bolton (1980)
function lclHeight(T, Td) {
    return Math.max(0, 125 * (T - Td));
}

// Einfache Parcelberechnung Surface-Based (SB)
function computeParcel(T, Td, p_sfc, sfc, profile, type) {
    const lclH    = lclHeight(T, Td);
    const T_LCL   = T - 0.212 * (T - Td) - 0.001 * Math.pow(T - Td, 2);
    const T_LCL_K = T_LCL + 273.15;
    const e_d     = 6.112 * Math.exp(17.67 * Td / (Td + 243.5));
    const w       = 0.622 * e_d / (p_sfc - e_d);
    const w_gkg   = w * 1000;
    const theta_e_parcel = (T + 273.15)
        * Math.pow(1000 / p_sfc, 0.2854 * (1 - 0.00028 * w_gkg))
        * Math.exp((3.376 / T_LCL_K - 0.00254) * w_gkg * (1 + 0.00081 * w_gkg));

    let cape = 0, cin = 0, el_hgt = lclH, el_temp = T_LCL, lfc_hgt = lclH;
    let aboveLFC = false;

    for (let idx = 0; idx < profile.length - 1; idx++) {
        const env = profile[idx];
        if (env.z < lclH) continue;

        // Parceltemperatur auf diesem Level via theta_e Iteration
        let T_parcel = env.T + 4;
        for (let it = 0; it < 6; it++) {
            const Tp_K  = T_parcel + 273.15;
            const es    = 6.112 * Math.exp(17.67 * T_parcel / (T_parcel + 243.5));
            const ws    = 0.622 * es / (env.p - es);
            const ws_gkg= ws * 1000;
            const th_e  = Tp_K
                * Math.pow(1000 / env.p, 0.2854 * (1 - 0.00028 * ws_gkg))
                * Math.exp((3.376 / Tp_K - 0.00254) * ws_gkg * (1 + 0.00081 * ws_gkg));
            T_parcel += (theta_e_parcel - th_e) * 0.3;
        }

        const dT   = T_parcel - env.T;
        const next = profile[idx + 1];
        const dz   = (next ? next.z - env.z : 100);
        const T_mean_K = env.T + 273.15;

        if (dT > 0) {
            if (!aboveLFC) { aboveLFC = true; lfc_hgt = env.z; }
            cape     += (dT / T_mean_K) * 9.81 * dz;
            el_hgt    = env.z;
            el_temp   = env.T;
        } else if (!aboveLFC) {
            cin      += (dT / T_mean_K) * 9.81 * dz;
        }
    }

    const li = profile.find(l => l.p <= 500)?.T != null
        ? (profile.find(l => l.p <= 500).T) - (T - 9.8 * lclH / 1000 + 4)
        : 0;

    return {
        CAPE:    Math.max(0, Math.round(cape)),
        CIN:     Math.round(Math.max(-500, Math.min(0, cin))),
        LCL_HGT: Math.round(lclH),
        LFC_HGT: Math.round(lfc_hgt),
        EL_HGT:  Math.round(el_hgt),
        EL_TEMP: Math.round(el_temp * 10) / 10,
        LI:      Math.round(li * 10) / 10,
        Td_parcel: Td,
        p_parcel:  p_sfc,
    };
}

// ML-Parcel: Mittelwert unterste 500m
function computeMLParcel(sfc, profile) {
    const ml_levels = profile.filter(l => l.z <= 500);
    const ml_T  = ml_levels.length ? ml_levels.reduce((s,l) => s + l.T,  0) / ml_levels.length : sfc.t2m;
    const ml_Td = ml_levels.length ? ml_levels.reduce((s,l) => s + l.Td, 0) / ml_levels.length : sfc.d2m;
    const ml_p  = ml_levels.length ? ml_levels[0].p : 1013.25;
    const res   = computeParcel(ml_T, ml_Td, ml_p, sfc, profile, 'ML');
    res.mixR    = mixingRatio(ml_Td, ml_p);
    return res;
}

// MU-Parcel: feuchteste Luftmasse in untersten 300 hPa
function computeMUParcel(sfc, profile) {
    let maxThetaE = -Infinity, best = null;
    const p_sfc = profile.length ? profile[0].p : 1013.25;
    const levels = [{ T: sfc.t2m, Td: sfc.d2m, p: p_sfc }, ...profile.filter(l => l.p >= p_sfc - 300)];
    for (const l of levels) {
        const te = thetaE(l.T, l.Td, l.p);
        if (te > maxThetaE) { maxThetaE = te; best = l; }
    }
    if (!best) return computeParcel(sfc.t2m, sfc.d2m, p_sfc, sfc, profile, 'MU');
    return computeParcel(best.T, best.Td, best.p, sfc, profile, 'MU');
}

// Teilschichten-CAPE (0-2km, 0-3km)
function partialCAPE(sfc, profile, parcel, z1, z2) {
    let cape = 0;
    const lclH = parcel.LCL_HGT;
    const theta_e_parcel = thetaE(sfc.t2m, sfc.d2m, 1013.25);
    for (let idx = 0; idx < profile.length - 1; idx++) {
        const env = profile[idx];
        if (env.z < Math.max(lclH, z1) || env.z > z2) continue;
        let T_parcel = env.T + 2;
        for (let it = 0; it < 5; it++) {
            const Tp_K = T_parcel + 273.15;
            const es   = 6.112 * Math.exp(17.67 * T_parcel / (T_parcel + 243.5));
            const ws   = 0.622 * es / (env.p - es);
            const ws_g = ws * 1000;
            const th_e = Tp_K * Math.pow(1000/env.p, 0.2854*(1-0.00028*ws_g))
                       * Math.exp((3.376/Tp_K - 0.00254)*ws_g*(1+0.00081*ws_g));
            T_parcel  += (theta_e_parcel - th_e) * 0.3;
        }
        const dT = T_parcel - env.T;
        if (dT > 0) {
            const next = profile[idx + 1];
            const dz   = next ? Math.min(next.z, z2) - Math.max(env.z, z1) : 100;
            cape += (dT / (env.T + 273.15)) * 9.81 * Math.max(0, dz);
        }
    }
    return Math.max(0, Math.round(cape));
}

// Lapse parcel from p1 to p2 (trockenadiabatisch)
function liftParcel(T, Td, p1, p2) {
    const lclH = lclHeight(T, Td);
    const z1 = pressureToAltitude(p1);
    const z2 = pressureToAltitude(p2);
    const zLCL = z1 + lclH;
    if (zLCL >= z2) {
        return T - 9.8 * (z2 - z1) / 1000;
    } else {
        const T_LCL = T - 9.8 * (zLCL - z1) / 1000;
        return T_LCL - 4.5 * (z2 - zLCL) / 1000;  // ~MALR
    }
}

// DCAPE nach Gilmore & Wicker (1998), angepasst für diskrete Levels
function computeDCAPE(profile, p700, p500) {
    if (!p700 || !p500) return 0;
    const dewDep = p700.T - p700.Td;
    if (dewDep > 35) return 0;
    const wetBulb700 = p700.T - 0.33 * dewDep;
    const tempDiff   = wetBulb700 - p500.T;
    if (tempDiff <= 0) return 0;
    const moistFactor = dewDep > 20 ? 0.2 : dewDep > 10 ? 0.5 : dewDep > 5 ? 0.8 : 1.0;
    return Math.max(0, Math.round((tempDiff / (p700.T + 273.15)) * 9.81 * 2500 * moistFactor));
}

// Bulk Shear zwischen Oberfläche und Zielhöhe
function computeBulkShear(sfc, profile) {
    const sfcUV = toUV(sfc.ws10_ms, sfc.wd10);
    function bs(z_top) {
        const top = getAtZ(profile, sfc, z_top);
        const topLevel = profile.filter(l => l.z >= z_top).sort((a,b) => a.z - b.z)[0];
        if (!topLevel) return 0;
        const topUV = toUV(topLevel.ws_ms, topLevel.wd);
        return Math.hypot(topUV.u - sfcUV.u, topUV.v - sfcUV.v);
    }
    function bsBetweenP(p1, p2) {
        const l1 = interpProfile(profile, p1);
        const l2 = interpProfile(profile, p2);
        if (!l1 || !l2) return 0;
        const uv1 = toUV(l1.ws_ms, l1.wd);
        const uv2 = toUV(l2.ws_ms, l2.wd);
        return Math.hypot(uv2.u - uv1.u, uv2.v - uv1.v);
    }
    return {
        BS_01km: bs(1000),
        BS_02km: bs(2000),
        BS_03km: bs(3000),
        BS_06km: bs(6000),
        BS_08km: bs(8000),
        BS_36km: bsBetweenP(600, 300),
        BS_26km: bsBetweenP(700, 300),
        BS_16km: bsBetweenP(850, 300),
    };
}

// Mittlere Windvektoren in Schichten
function computeMeanWinds(sfc, profile) {
    function mw(z_top) {
        const levels = [{ z:10, ws_ms: sfc.ws10_ms, wd: sfc.wd10 },
                        ...profile.filter(l => l.z <= z_top)];
        if (levels.length < 2) return 0;
        const uvs = levels.map(l => toUV(l.ws_ms, l.wd));
        const uM  = uvs.reduce((s,w) => s + w.u, 0) / uvs.length;
        const vM  = uvs.reduce((s,w) => s + w.v, 0) / uvs.length;
        return Math.hypot(uM, vM);
    }
    return { MW_01km: mw(1000), MW_02km: mw(2000), MW_03km: mw(3000), MW_06km: mw(6000) };
}

// Bunkers Storm Motion (Bunkers 2000)
function computeBunkers(MW, BS) {
    const prop = 7.5;  // m/s Deviation
    const sh   = BS.BS_06km || 1;
    // Vereinfachte Version ohne vollständige U/V-Decomposition
    return { RM_speed: MW.MW_06km + prop, RM_dir: 0, LM_speed: MW.MW_06km + prop, LM_dir: 0 };
}

// SRH (Storm Relative Helicity) – Bunkers RM
function computeSRH(sfc, profile, bunkers) {
    function srh(z_top) {
        const levels = [
            { z: 10,    u: toUV(sfc.ws10_ms, sfc.wd10).u,   v: toUV(sfc.ws10_ms, sfc.wd10).v },
            ...profile.filter(l => l.z <= z_top).map(l => ({ z: l.z, ...toUV(l.ws_ms, l.wd) })),
        ];
        if (levels.length < 2) return 0;

        // Storm motion (Bunkers RM – vereinfacht: Methode nach shear-Vektor)
        const sfcUV   = toUV(sfc.ws10_ms, sfc.wd10);
        const topLevel= profile.filter(l => l.z <= 6000).sort((a,b) => b.z - a.z)[0];
        const topUV   = topLevel ? toUV(topLevel.ws_ms, topLevel.wd) : sfcUV;
        const shU     = topUV.u - sfcUV.u;
        const shV     = topUV.v - sfcUV.v;
        const shMag   = Math.hypot(shU, shV) || 1;
        const mwU     = levels.reduce((s,l) => s + l.u, 0) / levels.length;
        const mwV     = levels.reduce((s,l) => s + l.v, 0) / levels.length;
        const devMag  = 7.5;
        const stormU  = mwU + devMag * (shV / shMag);
        const stormV  = mwV - devMag * (shU / shMag);

        let helicity = 0;
        for (let i = 0; i < levels.length - 1; i++) {
            const u1 = levels[i].u   - stormU;
            const v1 = levels[i].v   - stormV;
            const u2 = levels[i+1].u - stormU;
            const v2 = levels[i+1].v - stormV;
            helicity += u1 * v2 - u2 * v1;
        }
        return Math.abs(helicity);
    }
    return {
        SRH_500m_RM: Math.round(srh(500)),
        SRH_1km_RM:  Math.round(srh(1000)),
        SRH_3km_RM:  Math.round(srh(3000)),
    };
}

// Durchschnittliche RH in einer Höhenschicht
function avgRH(profile, z1, z2) {
    const levels = profile.filter(l => l.z >= z1 && l.z <= z2);
    if (!levels.length) return 60;
    return Math.round(levels.reduce((s,l) => s + l.rh, 0) / levels.length);
}

// Höhe der maximalen Theta-E unterhalb z_max
function maxThetaEHeight(profile, sfc, z_max) {
    const levels = [
        { z: 10, T: sfc.t2m, Td: sfc.d2m, p: 1013.25 },
        ...profile.filter(l => l.z <= z_max),
    ];
    let maxTE = -Infinity, maxZ = 0;
    for (const l of levels) {
        const te = thetaE(l.T, l.Td, l.p);
        if (te > maxTE) { maxTE = te; maxZ = l.z; }
    }
    return maxZ;
}

// Höhe der minimalen Theta-E unterhalb z_max
function minThetaEHeight(profile, sfc, z_max) {
    const levels = profile.filter(l => l.z <= z_max && l.z > 500);
    if (!levels.length) return z_max / 2;
    let minTE = Infinity, minZ = 0;
    for (const l of levels) {
        const te = thetaE(l.T, l.Td, l.p);
        if (te < minTE) { minTE = te; minZ = l.z; }
    }
    return minZ;
}

// SWEAT-Index (Miller 1972)
function computeSWEAT(p850, p500, srh1km, tt) {
    if (!p850 || !p500) return 0;
    const Td850 = p850.Td;
    const ws850 = p850.ws_ms * 1.944;  // m/s → kts
    const ws500 = p500.ws_ms * 1.944;
    if (tt < 49) return 0;
    return 12 * Td850 + 20 * (tt - 49) + 2 * ws850 + ws500 + 125 * (Math.sin((p500.wd - p850.wd) * Math.PI / 180) + 0.2);
}

// SCP nach Thompson et al. (2004)
function computeSCP(muCape, shear06, srh3km, cin) {
    if (muCape < 100 || shear06 < 6 || srh3km < 40) return 0;
    const magCin   = -Math.min(0, cin);
    const cinTerm  = magCin < 40 ? 1.0 : Math.max(0.1, 1 - (magCin - 40) / 200);
    return Math.max(0, (muCape/1000) * (srh3km/50) * Math.min(shear06/12, 1.5) * cinTerm);
}

// STP nach Thompson et al. (2003) – Europa-kalibriert (normCAPE=750)
function computeSTP(sbCape, srh1km, shear06, lclH, cin) {
    if (sbCape < 80 || srh1km < 40 || shear06 < 6) return 0;
    let lclTerm;
    if      (lclH < 1000)  lclTerm = 1.0;
    else if (lclH >= 2000) lclTerm = 0.0;
    else                   lclTerm = (2000 - lclH) / 1000;
    let cinTerm;
    if      (cin >= -50)  cinTerm = 1.0;
    else if (cin <= -200) cinTerm = 0.0;
    else                  cinTerm = (200 + cin) / 150;
    return Math.max(0, (sbCape/750) * (srh1km/150) * (shear06/20 >= 1.5 ? 1.5 : shear06/20) * lclTerm * cinTerm);
}

// SHIP (Significant Hail Parameter)
function computeSHIP(MU, BS, p500, p700) {
    if (!p500 || !p700) return 0;
    if (MU.CAPE < 100)  return 0;
    const lr   = (p700.T - p500.T) / Math.max(1, (p500.z - p700.z) / 1000);
    const muMr = mixingRatio(MU.Td_parcel ?? -5, MU.p_parcel ?? 850);
    return (MU.CAPE * muMr * lr * -p500.T * BS.BS_06km) / 42000000;
}

// DCP (Derecho Composite Parameter, Evans & Doswell 2001)
function computeDCP(dcape, muCape, shear06, srh1km) {
    if (dcape < 100 || muCape < 100 || shear06 < 6) return 0;
    return (dcape/980) * (muCape/2000) * (shear06/20) * (srh1km/100);
}

// Wind Index (McCann 1994, vereinfacht)
function computeWindIndex(muCape, dcape, shear06, frzLvl) {
    if (dcape < 100 && muCape < 100) return 0;
    const instab = Math.sqrt(2 * Math.max(muCape, dcape));
    return Math.round(instab * shear06 / 1000);
}

// SHERBS3 / SHERBE (Sherburn & Parker 2014)
function computeSHERBS3(lr36, shear06, srh3km, muCape) {
    if (muCape >= 1000) return 0;   // nur für HSLC-Umgebungen
    return (lr36 / 9.0) * (shear06 / 27) * (srh3km / 150);
}
function computeSHERBE(lr36, shear06, srh3km, muCape) {
    if (muCape >= 1000) return 0;
    return (lr36 / 9.0) * (shear06 / 27) * (srh3km / 150) * (muCape < 500 ? 1.5 : 1.0);
}

// DEI (Dominant Supercell Index, Gropp & Davenport 2019)
function computeDEI(muCape, scp, shear06) {
    if (muCape < 100 || scp < 0.5) return 0;
    return scp * Math.min(shear06 / 20, 1.5);
}

// TIP (Tornadic Index Europa, Púčik 2015 – vereinfacht)
function computeTIP(muCape, srh1km, shear06, lclH) {
    if (muCape < 80 || srh1km < 50 || shear06 < 12) return 0;
    const lclTerm = lclH < 1000 ? 1.0 : lclH < 2000 ? (2000 - lclH) / 1000 : 0;
    return (muCape/1000) * (srh1km/150) * (shear06/20) * lclTerm;
}

// Moisture Flux (Bodenfeuchtefluss 0-z km)
function computeMoistureFlux(sfc, profile, z_top) {
    const levels = [
        { z: 10, ws_ms: sfc.ws10_ms, Td: sfc.d2m, p: 1013.25 },
        ...profile.filter(l => l.z <= z_top),
    ];
    const fluxes = levels.map(l => mixingRatio(l.Td, l.p) * l.ws_ms);
    return Math.round(fluxes.reduce((s,f) => s + f, 0) / fluxes.length);
}
