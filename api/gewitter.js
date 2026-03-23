// ═══════════════════════════════════════════════════════════════════════════
// LIGHTNING PROBABILITY API HANDLER
// Methodik: ESSL AR-CHaMo (Rädler 2018) + thundeR-Prädiktoren (Taszarek 2020)
//
// KORREKTUREN (v3):
//   FIX A – DCAPE: Echtes Integral nach Emanuel (1994) statt vereinfachter
//            Wetbulb-T500-Approximation. Parcell steigt von 700 hPa trocken-
//            adiabatisch ab und wird gegen Umgebung integriert.
//            Vorher: (wetBulb700-T500)/T700 * 9.81 * 2500 * moistFactor
//            → produzierte unrealistisch hohe Werte (~1000+ J/kg für März EU)
//
//   FIX B – ML-Parcel: Mixed-Layer-Tiefe auf 100 hPa (~1 km AGL) angehoben.
//            Vorher: nur 500m AGL → ML_CAPE=0 obwohl SB_CAPE positiv, weil
//            die Schicht zu dünn war und die Mittelung nicht repräsentativ.
//
//   FIX C – Theta-E Schwellen: An europäische Klimatologie (Taszarek 2020)
//            angepasst. DE-Sommer-Thetae typisch 310–330 K, Extremereignisse
//            330–340 K. Subtropische Schwellen (≥345 für max. Score) entfernt.
//            Vorher: ≥345/≥335/≥325/<315 → jetzt ≥330/≥322/≥315/<308
//
//   FIX D – SHIP Kalibrierung: Divisor an europäisches CAPE-Regime angepasst.
//            SHIP ist für Great Plains kalibriert (CAPE 1000–4000 J/kg).
//            In EU ist CAPE 100–800 J/kg typisch → SHIP bleibt strukturell
//            gleich aber Scoring-Schwellen auf EU-Klimaperzentile abgesenkt.
//            Vorher: Schwellen ≥0.5/≥1.0/≥2.0 → jetzt ≥0.1/≥0.2/≥0.4
//
//   FIX E – avgRH Fallback: Statt stilles 60% wird nun der nächste vorhandene
//            Level interpoliert statt ein unrealistischer Festwert zurückgegeben.
//
//   FIX F – Score-Gesamtkalibrierung: Basis-Grenzwerte angehoben, sodass
//            schwache März-Situationen (CAPE 100–300, kein SRH) nicht bereits
//            35–40% erreichen. Ziel: klare Trennung zwischen
//            Randüberschreitung (10–20%) und echter Gewittergefahr (40%+).
//
// Quellliteratur:
//   Emanuel (1994): Atmospheric Convection – DCAPE-Definition
//   Rädler et al. (2018): Eur. J. Meteorol. – AR-CHaMo Logistik
//   Taszarek et al. (2020): JGR-Atmospheres – EU Konvektionsklimatologie
//   Sherburn & Parker (2014): Wea. Forecasting – SHERBE
//   Romanic et al. (2022): Nat. Hazards – DEI
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

    const LEVELS    = [1000,975,950,925,900,850,800,700,600,500,400,300,250,200];
    const LEV_VARS  = ['temperature','dewpoint','relative_humidity','wind_speed','wind_direction','geopotential_height'];
    const MODELS    = ['icon_eu','ecmwf_ifs025','gfs_global'];

    const surfaceVars = [
        'temperature_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_gusts_10m',
        'wind_direction_10m', 'cape', 'convective_inhibition', 'lifted_index',
        'boundary_layer_height', 'precipitation', 'precipitation_probability',
        'total_column_integrated_water_vapour', 'direct_radiation',
        'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
    ].join(',');

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

        const localStr    = now.toLocaleString('en-CA', { year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false,timeZone:timezone });
        const [currentDateStr, currentHourStr] = localStr.split(', ');
        const currentHour = parseInt(currentHourStr?.split(':')[0] ?? '0', 10);

        function getVal(hourly, field, model, i) {
            const key = `${field}_${model}`;
            const arr = hourly[key];
            if (Array.isArray(arr) && arr[i] != null) return arr[i];
            return null;
        }

        function buildProfile(hourly, i, model) {
            const raw = [];
            for (const lv of LEVELS) {
                const T  = getVal(hourly, `temperature_${lv}hPa`,        model, i);
                const Td = getVal(hourly, `dewpoint_${lv}hPa`,           model, i);
                const rh = getVal(hourly, `relative_humidity_${lv}hPa`,  model, i);
                const ws = getVal(hourly, `wind_speed_${lv}hPa`,         model, i);
                const wd = getVal(hourly, `wind_direction_${lv}hPa`,     model, i);
                const z  = getVal(hourly, `geopotential_height_${lv}hPa`,model, i);
                if (T === null) continue;
                raw.push({
                    p:     lv,
                    T,
                    z_asl: z ?? pressureToAltitude(lv),
                    Td:    Td ?? deriveDewpoint(T, rh ?? 70),
                    rh:    rh ?? calcRH(T, Td ?? T - 5),
                    ws_ms: ws != null ? ws / 3.6 : 0,
                    wd:    wd ?? 0,
                });
            }
            raw.sort((a, b) => b.p - a.p);

            const z_sfc    = raw.length > 0 ? raw[0].z_asl : 0;
            const p_lowest = raw[0]?.p ?? 1000;
            const T_lowest = raw[0]?.T ?? 15;
            const dz_to_sfc = raw[0]?.z_asl - z_sfc;
            const p_sfc = p_lowest * Math.exp(9.81 * dz_to_sfc / (287 * (T_lowest + 273.15)));

            const profile = raw.map(l => ({ ...l, z: Math.max(0, l.z_asl - z_sfc) }));
            return { profile, p_sfc: Math.round(p_sfc * 10) / 10 };
        }

        function extractSurface(hourly, i, model) {
            const g = (f) => getVal(hourly, f, model, i);
            const t2m = g('temperature_2m');
            const d2m = g('dew_point_2m');
            if (t2m === null) return null;
            return {
                t2m,
                d2m:         d2m ?? (t2m - 10),
                ws10:        (g('wind_speed_10m')   ?? 0),
                ws10_ms:     (g('wind_speed_10m')   ?? 0) / 3.6,
                gust_ms:     (g('wind_gusts_10m')   ?? 0) / 3.6,
                wd10:        g('wind_direction_10m') ?? 0,
                cape:        Math.max(0, g('cape')             ?? 0),
                cin:         g('convective_inhibition')         ?? 0,
                li:          g('lifted_index')                  ?? null,
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

        function computeThunderParams(sfc, profile, p_sfc_in) {
            if (!profile.length || !sfc) return null;

            const LR = computeLapseRates(profile, sfc);
            const p_sfc = p_sfc_in ?? 1013.25;

            const SB = computeParcel(sfc.t2m, sfc.d2m, p_sfc, sfc, profile, 'SB');
            const ML = computeMLParcel(sfc, profile, p_sfc);
            const MU = computeMUParcel(sfc, profile, p_sfc);

            const p850  = interpProfile(profile, 850);
            const p700  = interpProfile(profile, 700);
            const p500  = interpProfile(profile, 500);

            const PRCP_WATER = sfc.pwat;
            const RH_01km   = avgRH(profile, sfc, 0,    1000);
            const RH_02km   = avgRH(profile, sfc, 0,    2000);
            const RH_14km   = avgRH(profile, sfc, 1000, 4000);
            const RH_25km   = avgRH(profile, sfc, 2000, 5000);
            const RH_36km   = avgRH(profile, sfc, 3000, 6000);

            const ThetaE_01km  = thetaE(sfc.t2m, sfc.d2m, 1013.25);
            const ThetaE_02km  = p850 ? thetaE(p850.T, p850.Td, 850) : ThetaE_01km;
            const Delta_ThetaE = ThetaE_01km - (p500 ? thetaE(p500.T, p500.Td, 500) : ThetaE_01km - 10);

            // FIX A: echtes DCAPE-Integral nach Emanuel (1994)
            const DCAPE = computeDCAPE(profile, sfc);
            const CPS   = DCAPE > 0 ? Math.sqrt(2 * DCAPE) : 0;

            const BS      = computeBulkShear(sfc, profile);
            const MW      = computeMeanWinds(sfc, profile);
            const bunkers = computeBunkers(sfc, profile);
            const SRH     = computeSRH(sfc, profile, bunkers);

            const K_Index = p850 && p700 && p500
                ? (p850.T - p500.T) + p850.Td - (p700.T - p700.Td)
                : 0;

            let Showalter = 0;
            if (p500 && p850) {
                const dewDep850 = Math.max(0, p850.T - p850.Td);
                const T_LCL850  = p850.T - 0.212 * dewDep850 - 0.001 * dewDep850 * dewDep850;
                const T_LCL_K   = T_LCL850 + 273.15;
                const e_850     = 6.112 * Math.exp(17.67 * p850.Td / (p850.Td + 243.5));
                const w_gkg850  = 1000 * 0.622 * e_850 / (850 - e_850);
                const thetaE_850 = (p850.T + 273.15)
                    * Math.pow(1000 / 850, 0.2854 * (1 - 0.00028 * w_gkg850))
                    * Math.exp((3.376 / T_LCL_K - 0.00254) * w_gkg850 * (1 + 0.00081 * w_gkg850));
                const T_parcel_500 = parcelTempAtLevel(thetaE_850, 500, p500.T + 1);
                Showalter = p500.T - T_parcel_500;
            }

            const TotalTotals = p850 && p700 && p500
                ? (p850.T + p850.Td) - (2 * p500.T)
                : 0;
            const SWEAT = computeSWEAT(p850, p500, SRH.SRH_1km_RM, TotalTotals);

            const MU_WMAXSHEAR  = Math.sqrt(2 * MU.CAPE)  * BS.BS_06km;
            const SB_WMAXSHEAR  = Math.sqrt(2 * SB.CAPE)  * BS.BS_06km;
            const ML_WMAXSHEAR  = Math.sqrt(2 * ML.CAPE)  * BS.BS_06km;

            const EHI_01km = (SB.CAPE * SRH.SRH_1km_RM) / 160000;
            const EHI_03km = (SB.CAPE * SRH.SRH_3km_RM) / 160000;

            const SCP_fix  = computeSCP(MU.CAPE, BS.BS_06km, SRH.SRH_3km_RM, sfc.cin);
            const STP_fix  = computeSTP(SB.CAPE, SRH.SRH_1km_RM, BS.BS_06km, SB.LCL_HGT, sfc.cin);
            const SHIP     = computeSHIP(MU, BS, p500, p700);
            const DCP      = computeDCP(DCAPE, MU.CAPE, BS.BS_06km, SRH.SRH_1km_RM);
            const SHERBS3  = computeSHERBS3(LR.LR_36km, BS.BS_06km, SRH.SRH_3km_RM, MU.CAPE);

            const maxLR_2km_2_6km = computeMaxLapseRate2km(profile, sfc, 2000, 6000);
            const SHERBE   = computeSHERBE(maxLR_2km_2_6km, BS.BS_06km, SRH.SRH_3km_RM, MU.CAPE);

            const DEI = computeDEI(ML_WMAXSHEAR, CPS);
            const TIP = computeTIP(MU.CAPE, SRH.SRH_1km_RM, BS.BS_06km, SB.LCL_HGT);
            const MoistFlux02 = computeMoistureFlux(sfc, profile, 2000);

            return {
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
                SB_02km_CAPE: partialCAPE(sfc, profile, SB, 0,    2000),
                SB_03km_CAPE: partialCAPE(sfc, profile, SB, 0,    3000),
                MU_03km_CAPE: partialCAPE(sfc, profile, MU, 0,    3000),
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
                Thetae_01km:       ThetaE_01km,
                Thetae_02km:       ThetaE_02km,
                Delta_thetae:      Delta_ThetaE,
                HGT_max_thetae_03km: maxThetaEHeight(profile, sfc, 3000),
                HGT_min_thetae_04km: minThetaEHeight(profile, sfc, 4000),
                PRCP_WATER:        PRCP_WATER,
                RH_01km, RH_02km, RH_14km, RH_25km, RH_36km,
                Moisture_Flux_02km: MoistFlux02,
                DCAPE,
                Cold_Pool_Strength: CPS,
                BS_01km:  BS.BS_01km,
                BS_02km:  BS.BS_02km,
                BS_03km:  BS.BS_03km,
                BS_06km:  BS.BS_06km,
                BS_08km:  BS.BS_08km,
                BS_36km:  BS.BS_36km,
                BS_26km:  BS.BS_26km,
                BS_16km:  BS.BS_16km,
                MW_01km:  MW.MW_01km,
                MW_02km:  MW.MW_02km,
                MW_03km:  MW.MW_03km,
                MW_06km:  MW.MW_06km,
                SRH_500m_RM: SRH.SRH_500m_RM,
                SRH_1km_RM:  SRH.SRH_1km_RM,
                SRH_3km_RM:  SRH.SRH_3km_RM,
                K_Index,
                Showalter_Index: Showalter,
                TotalTotals_Index: TotalTotals,
                SWEAT_Index:    SWEAT,
                SCP_fix, STP_fix, EHI_01km, EHI_03km, SHIP, DCP,
                SHERBS3, SHERBE, DEI, TIP,
                MU_WMAXSHEAR:  Math.round(MU_WMAXSHEAR),
                SB_WMAXSHEAR:  Math.round(SB_WMAXSHEAR),
                ML_WMAXSHEAR:  Math.round(ML_WMAXSHEAR),
                Bunkers_RM_M:  bunkers.RM_speed,
                Bunkers_RM_A:  bunkers.RM_dir,
                Bunkers_LM_M:  bunkers.LM_speed,
                Bunkers_LM_A:  bunkers.LM_dir,
                Bunkers_MW_M:  bunkers.MW_speed,
                Bunkers_MW_A:  bunkers.MW_dir,
                SRH_1km_LM:    SRH.SRH_1km_LM,
                SRH_3km_LM:    SRH.SRH_3km_LM,
                T2m:       sfc.t2m,
                Td2m:      sfc.d2m,
                CAPE_sfc:  sfc.cape,
                CIN_sfc:   sfc.cin,
                LI_sfc:    sfc.li,
                PWAT:      sfc.pwat,
                PBL_H:     sfc.pblH ?? ML.LCL_HGT,
                RADIATION: sfc.radiation,
            };
        }

        // ── Gewitterwahrscheinlichkeit ──────────────────────────────────────
        // AR-CHaMo Logistik: Rädler 2018 / Taszarek 2021
        // FIX F: Gesamtkalibrierung für EU-Klimatologie
        function calculateLightningProb(p, sfc) {
            if (!p) return 0;

            const cape   = Math.max(0, p.MU_CAPE);
            const sbCape = Math.max(0, p.SB_CAPE);
            const cin    = sfc.cin ?? 0;
            const magCin = -Math.min(0, cin);

            // Harte Ausschlusskriterien
            if (sfc.t2m  < 2  && cape < 500)                   return 0;
            if (sfc.t2m  < 8  && cape < 200 && p.BS_06km < 15) return 0;
            if (cape     < 80 && sfc.precip < 0.1 && sfc.precipProb < 15) return 0;
            if (magCin   > 300)                                 return 0;

            const wmaxshear = p.ML_WMAXSHEAR;
            const shear06   = p.BS_06km;
            const srh1km    = p.SRH_1km_RM;
            const srh3km    = p.SRH_3km_RM;
            const dcape     = p.DCAPE;
            const lr36      = p.LR_36km;
            const muEl      = p.MU_EL_TEMP ?? -15;
            const lclH      = p.SB_LCL_HGT;
            const meanRH    = (p.RH_14km + p.RH_25km + p.RH_36km) / 3;
            const thetaE_   = p.Thetae_01km;
            const deltaTE   = p.Delta_thetae;
            const pwat      = p.PWAT;
            const pbl       = p.PBL_H;
            const mixR850   = p.ML_MIXR;
            const kIdx      = p.K_Index;
            const ttIdx     = p.TotalTotals_Index;
            const scp       = p.SCP_fix;
            const stp       = p.STP_fix;
            const ehi1      = p.EHI_01km;
            const ship      = p.SHIP;
            const sherbs3   = p.SHERBS3;

            // ── HSLC-Regime (High Shear Low CAPE) ───────────────────────────
            if (cape < 300 && shear06 >= 18) {
                let hslcScore = 0;
                if      (shear06 >= 25) hslcScore += 28;
                else if (shear06 >= 20) hslcScore += 18;
                else                    hslcScore += 8;
                if      (sherbs3 >= 1.0) hslcScore += 20;
                else if (sherbs3 >= 0.5) hslcScore += 10;
                if      (meanRH >= 65)   hslcScore += 10;
                else if (meanRH <  50)   hslcScore -= 15;
                if (sfc.t2m < 8) hslcScore = Math.round(hslcScore * 0.5);
                return Math.min(55, Math.max(0, hslcScore));
            }

            let score = 0;

            // ── (1) MUCAPE ────────────────────────────────────────────────
            // Wichtigster Einzelprädiktor (Taszarek 2020)
            if      (cape >= 2000) score += 18;
            else if (cape >= 1500) score += 15;
            else if (cape >= 1000) score += 12;
            else if (cape >= 700)  score += 9;
            else if (cape >= 400)  score += 6;
            else if (cape >= 200)  score += 3;
            else if (cape >= 100)  score += 1;
            // Kein CAPE < 100: kein Beitrag

            // ── (2) ML_WMAXSHEAR – EU-kalibrierte Schwellen (Taszarek 2020) ─
            if      (wmaxshear >= 800) score += 20;
            else if (wmaxshear >= 600) score += 16;
            else if (wmaxshear >= 450) score += 12;
            else if (wmaxshear >= 300) score += 8;
            else if (wmaxshear >= 200) score += 4;
            else if (wmaxshear >= 150) score += 2;
            else if (wmaxshear >= 100) score += 1;

            // ── (3) 0-6km Bulk Shear ────────────────────────────────────────
            if      (shear06 >= 25) score += 11;
            else if (shear06 >= 20) score += 8;
            else if (shear06 >= 15) score += 5;
            else if (shear06 >= 12) score += 3;
            else if (shear06 >= 10) score += 1;

            // ── (4) SRH 0-1km ───────────────────────────────────────────────
            if      (srh1km >= 200) score += 12;
            else if (srh1km >= 150) score += 9;
            else if (srh1km >= 100) score += 6;
            else if (srh1km >= 60)  score += 3;
            else if (srh1km >= 30)  score += 1;

            // ── (5) SRH 0-3km ───────────────────────────────────────────────
            if      (srh3km >= 300) score += 7;
            else if (srh3km >= 200) score += 5;
            else if (srh3km >= 150) score += 3;
            else if (srh3km >= 100) score += 1;

            // ── (6) SCP ─────────────────────────────────────────────────────
            if      (scp >= 3.0) score += 20;
            else if (scp >= 2.0) score += 16;
            else if (scp >= 1.5) score += 12;
            else if (scp >= 1.0) score += 8;

            // ── (7) STP ─────────────────────────────────────────────────────
            if      (stp >= 2.0) score += 14;
            else if (stp >= 1.5) score += 11;
            else if (stp >= 1.0) score += 8;
            else if (stp >= 0.5) score += 5;
            else if (stp >= 0.3) score += 2;

            // ── (8) EHI 0-1km ───────────────────────────────────────────────
            if      (ehi1 >= 2.5) score += 10;
            else if (ehi1 >= 2.0) score += 8;
            else if (ehi1 >= 1.0) score += 5;
            else if (ehi1 >= 0.5) score += 3;

            // ── (9) DCAPE – FIX A: neu kalibriert da echtes Integral ────────
            // Typische EU-DCAPE nach Fix: 200–600 J/kg (schwach–moderat),
            // >800 J/kg: starke Böenlinien, >1200 J/kg: extreme Ereignisse
            if      (dcape >= 1200 && cape >= 400) score += 8;
            else if (dcape >= 800  && cape >= 300) score += 6;
            else if (dcape >= 500  && cape >= 200) score += 4;
            else if (dcape >= 300  && cape >= 150) score += 2;
            else if (dcape >= 150  && cape >= 100) score += 1;

            // ── (10) EL-Temperatur ──────────────────────────────────────────
            if      (muEl <= -25 && cape >= 200) score += 9;
            else if (muEl <= -20 && cape >= 150) score += 6;
            else if (muEl <= -15 && cape >= 100) score += 3;
            else if (muEl <= -10 && cape >=  80) score += 1;
            else if (muEl >   -5 && cape <  500) score -= 4;

            // ── (11) 3-6km Lapse Rate ───────────────────────────────────────
            if      (lr36 >= 8.5) score += 7;
            else if (lr36 >= 8.0) score += 5;
            else if (lr36 >= 7.5) score += 3;
            else if (lr36 >= 7.0) score += 1;
            else if (lr36 <  5.5 && cape < 800) score -= 4;

            // ── (12) LCL-Höhe ───────────────────────────────────────────────
            if      (lclH <  500)  score += 7;
            else if (lclH <  800)  score += 5;
            else if (lclH <  1200) score += 3;
            else if (lclH <  1500) score += 1;
            else if (lclH >= 2500) score -= 5;

            // ── (13) Mittlere RH 1-6km ──────────────────────────────────────
            if      (meanRH >= 75) score += 7;
            else if (meanRH >= 65) score += 4;
            else if (meanRH >= 55) score += 1;
            else if (meanRH <  50) score -= 10;
            else if (meanRH <  40) score -= 18;

            // ── (14) Theta-E 0-1km – FIX C: EU-kalibriert ──────────────────
            // EU-Klimatologie (Taszarek 2020):
            //   >330 K: sehr feucht/instabil (Sommerextrem)
            //   322–330 K: typisch aktive Gewittertage
            //   315–322 K: schwache Konvektion möglich
            //   <308 K: zu trocken/stabil
            if      (thetaE_ >= 330) score += 8;
            else if (thetaE_ >= 322) score += 5;
            else if (thetaE_ >= 315) score += 2;
            else if (thetaE_ <  308) score -= 4;
            // 308–315 K: neutral, kein Beitrag

            // ── (15) Delta-Theta-E ──────────────────────────────────────────
            if      (deltaTE >= 20) score += 5;
            else if (deltaTE >= 15) score += 3;
            else if (deltaTE >= 10) score += 1;
            else if (deltaTE <   5) score -= 2;

            // ── (16) K-Index ────────────────────────────────────────────────
            if      (kIdx >= 38) score += 6;
            else if (kIdx >= 35) score += 4;
            else if (kIdx >= 30) score += 2;
            else if (kIdx >= 25) score += 1;

            // ── (17) Total Totals ───────────────────────────────────────────
            if      (ttIdx >= 55) score += 5;
            else if (ttIdx >= 50) score += 3;
            else if (ttIdx >= 45) score += 1;

            // ── (18) PWAT ───────────────────────────────────────────────────
            if      (pwat >= 35 && cape >= 500) score += 5;
            else if (pwat >= 25 && cape >= 300) score += 3;
            else if (pwat >= 15 && cape >= 200) score += 1;

            // ── (19) Mixing Ratio ML ────────────────────────────────────────
            if      (mixR850 >= 12) score += 6;
            else if (mixR850 >= 9)  score += 3;
            else if (mixR850 >= 6)  score += 1;
            else if (mixR850 <  4)  score -= 5;

            // ── (20) CIN ────────────────────────────────────────────────────
            if      (magCin <  25 && cape >= 300) score += 5;
            else if (magCin <  50 && cape >= 200) score += 2;
            else if (magCin > 200)                score -= 18;
            else if (magCin > 100)                score -= 10;
            else if (magCin >  50)                score -= 5;

            // ── (21) Precipitation ──────────────────────────────────────────
            if      (sfc.precip >= 3.0 && cape >= 600) score += 6;
            else if (sfc.precip >= 2.0 && cape >= 400) score += 4;
            else if (sfc.precip >= 1.0 && cape >= 300) score += 2;
            else if (sfc.precip >= 0.5 && cape >= 200) score += 1;
            if      (sfc.precipProb >= 70 && cape >= 500) score += 4;
            else if (sfc.precipProb >= 55 && cape >= 400) score += 2;
            else if (sfc.precipProb >= 40 && cape >= 300) score += 1;

            // ── (22) Strahlung / Tageszeit ──────────────────────────────────
            const isNight     = sfc.radiation < 20;
            const isDaytime   = sfc.radiation >= 200;
            const isStrongDay = sfc.radiation >= 600;
            if      (isStrongDay && sfc.t2m >= 14 && cape >= 300) score += 6;
            else if (isDaytime   && sfc.t2m >= 12 && cape >= 200) score += 3;
            else if (isNight) {
                const llj = srh1km >= 100 && shear06 >= 12 && sfc.ws10_ms >= 8;
                if (llj && cape >= 500) score += 4;
                else if (!llj && shear06 < 10 && cape < 400) score -= 4;
            }

            // ── (23) PBL-Höhe ───────────────────────────────────────────────
            if      (pbl >= 2000 && cape >= 300) score += 4;
            else if (pbl >= 1500 && cape >= 200) score += 2;
            else if (pbl <  300  && cape <  500) score -= 3;

            // ── (24) SHIP – FIX D: EU-kalibrierte Schwellen ─────────────────
            // SHIP ursprünglich für US-Plains (CAPE 1000–4000 J/kg) kalibriert.
            // In EU: SHIP >0.1 bereits relevant, >0.3 erhöhte Hagelgefahr.
            if      (ship >= 0.4 && cape >= 500)  score += 5;
            else if (ship >= 0.2 && cape >= 300)  score += 3;
            else if (ship >= 0.1 && cape >= 200)  score += 1;

            // ── Temperatur-Skalierung ────────────────────────────────────────
            if      (sfc.t2m < 8)  score = Math.round(score * (shear06 < 15 && cape < 500 ? 0.35 : 0.55));
            else if (sfc.t2m < 12) score = Math.round(score * 0.65);
            else if (sfc.t2m < 15) score = Math.round(score * 0.82);

            // ── Korrekturen ──────────────────────────────────────────────────
            if (score > 0 && cape < 100 && shear06 < 8)         score = Math.max(0, score - 10);
            if (score > 0 && magCin > 150 && cape < 1000)       score = Math.max(0, score - 12);
            if (shear06 >= 20 && cape >= 150 && score < 25)     score = Math.min(score + 5, 30);

            // FIX F: Mindest-Score-Schwelle für Meldung
            // Verhindert dass schwache Situationen ohne klaren Trigger > 20% erreichen
            if (score > 0 && cape < 200 && srh1km < 30 && shear06 < 15 && sfc.precipProb < 30) {
                score = Math.min(score, 15);
            }

            return Math.min(100, Math.max(0, Math.round(score)));
        }

        // ── Modellgewichtung ────────────────────────────────────────────────
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

        function formatParams(p, prob) {
            if (!p) return null;
            return {
                gewitter: prob ?? null,
                MU_CAPE:        Math.round(p.MU_CAPE),
                MU_CIN:         Math.round(p.MU_CIN),
                MU_LCL_HGT:    Math.round(p.MU_LCL_HGT),
                MU_LFC_HGT:    Math.round(p.MU_LFC_HGT),
                MU_EL_HGT:     Math.round(p.MU_EL_HGT),
                MU_EL_TEMP:    Math.round(p.MU_EL_TEMP * 10) / 10,
                MU_LI:         Math.round(p.MU_LI * 10) / 10,
                MU_WMAX:       Math.round(p.MU_WMAX * 10) / 10,
                MU_MIXR:       Math.round(p.MU_MIXR * 10) / 10,
                SB_CAPE:       Math.round(p.SB_CAPE),
                SB_CIN:        Math.round(p.SB_CIN),
                SB_LCL_HGT:   Math.round(p.SB_LCL_HGT),
                SB_LFC_HGT:   Math.round(p.SB_LFC_HGT),
                SB_EL_HGT:    Math.round(p.SB_EL_HGT),
                SB_EL_TEMP:   Math.round(p.SB_EL_TEMP * 10) / 10,
                SB_LI:        Math.round(p.SB_LI * 10) / 10,
                SB_WMAX:      Math.round(p.SB_WMAX * 10) / 10,
                SB_MIXR:      Math.round(p.SB_MIXR * 10) / 10,
                ML_CAPE:      Math.round(p.ML_CAPE),
                ML_CIN:       Math.round(p.ML_CIN),
                ML_LCL_HGT:  Math.round(p.ML_LCL_HGT),
                ML_LFC_HGT:  Math.round(p.ML_LFC_HGT),
                ML_EL_HGT:   Math.round(p.ML_EL_HGT),
                ML_EL_TEMP:  Math.round(p.ML_EL_TEMP * 10) / 10,
                ML_LI:       Math.round(p.ML_LI * 10) / 10,
                ML_WMAX:     Math.round(p.ML_WMAX * 10) / 10,
                ML_MIXR:     Math.round(p.ML_MIXR * 10) / 10,
                SB_02km_CAPE: Math.round(p.SB_02km_CAPE),
                SB_03km_CAPE: Math.round(p.SB_03km_CAPE),
                MU_03km_CAPE: Math.round(p.MU_03km_CAPE),
                LR_01km:      Math.round(p.LR_01km * 10) / 10,
                LR_02km:      Math.round(p.LR_02km * 10) / 10,
                LR_03km:      Math.round(p.LR_03km * 10) / 10,
                LR_06km:      Math.round(p.LR_06km * 10) / 10,
                LR_16km:      Math.round(p.LR_16km * 10) / 10,
                LR_26km:      Math.round(p.LR_26km * 10) / 10,
                LR_36km:      Math.round(p.LR_36km * 10) / 10,
                LR_500700hPa: Math.round(p.LR_500700hPa * 10) / 10,
                LR_500800hPa: Math.round(p.LR_500800hPa * 10) / 10,
                LR_600800hPa: Math.round(p.LR_600800hPa * 10) / 10,
                Thetae_01km:         Math.round(p.Thetae_01km * 10) / 10,
                Thetae_02km:         Math.round(p.Thetae_02km * 10) / 10,
                Delta_thetae:        Math.round(p.Delta_thetae * 10) / 10,
                HGT_max_thetae_03km: Math.round(p.HGT_max_thetae_03km),
                HGT_min_thetae_04km: Math.round(p.HGT_min_thetae_04km),
                PRCP_WATER:         Math.round(p.PRCP_WATER * 10) / 10,
                RH_01km:            Math.round(p.RH_01km),
                RH_02km:            Math.round(p.RH_02km),
                RH_14km:            Math.round(p.RH_14km),
                RH_25km:            Math.round(p.RH_25km),
                RH_36km:            Math.round(p.RH_36km),
                Moisture_Flux_02km: Math.round(p.Moisture_Flux_02km),
                DCAPE:              Math.round(p.DCAPE),
                Cold_Pool_Strength: Math.round(p.Cold_Pool_Strength * 10) / 10,
                BS_01km:  Math.round(p.BS_01km * 10) / 10,
                BS_02km:  Math.round(p.BS_02km * 10) / 10,
                BS_03km:  Math.round(p.BS_03km * 10) / 10,
                BS_06km:  Math.round(p.BS_06km * 10) / 10,
                BS_08km:  Math.round(p.BS_08km * 10) / 10,
                BS_36km:  Math.round(p.BS_36km * 10) / 10,
                BS_26km:  Math.round(p.BS_26km * 10) / 10,
                BS_16km:  Math.round(p.BS_16km * 10) / 10,
                MW_01km:  Math.round(p.MW_01km * 10) / 10,
                MW_02km:  Math.round(p.MW_02km * 10) / 10,
                MW_03km:  Math.round(p.MW_03km * 10) / 10,
                MW_06km:  Math.round(p.MW_06km * 10) / 10,
                SRH_500m_RM: Math.round(p.SRH_500m_RM),
                SRH_1km_RM:  Math.round(p.SRH_1km_RM),
                SRH_3km_RM:  Math.round(p.SRH_3km_RM),
                K_Index:           Math.round(p.K_Index * 10) / 10,
                Showalter_Index:   Math.round(p.Showalter_Index * 10) / 10,
                TotalTotals_Index: Math.round(p.TotalTotals_Index * 10) / 10,
                SWEAT_Index:       Math.round(p.SWEAT_Index),
                SCP_fix:           Math.round(p.SCP_fix * 100) / 100,
                STP_fix:           Math.round(p.STP_fix * 100) / 100,
                EHI_01km:          Math.round(p.EHI_01km * 100) / 100,
                EHI_03km:          Math.round(p.EHI_03km * 100) / 100,
                SHIP:              Math.round(p.SHIP * 100) / 100,
                DCP:               Math.round(p.DCP * 100) / 100,
                SHERBS3:           Math.round(p.SHERBS3 * 100) / 100,
                SHERBE:            Math.round(p.SHERBE  * 100) / 100,
                DEI:               Math.round(p.DEI * 100) / 100,
                TIP:               Math.round(p.TIP * 100) / 100,
                MU_WMAXSHEAR: Math.round(p.MU_WMAXSHEAR),
                SB_WMAXSHEAR: Math.round(p.SB_WMAXSHEAR),
                ML_WMAXSHEAR: Math.round(p.ML_WMAXSHEAR),
                Bunkers_RM_M: Math.round(p.Bunkers_RM_M * 10) / 10,
                Bunkers_RM_A: Math.round(p.Bunkers_RM_A),
                Bunkers_LM_M: Math.round(p.Bunkers_LM_M * 10) / 10,
                Bunkers_LM_A: Math.round(p.Bunkers_LM_A),
                Bunkers_MW_M: Math.round(p.Bunkers_MW_M * 10) / 10,
                Bunkers_MW_A: Math.round(p.Bunkers_MW_A),
                SRH_1km_LM:  Math.round(p.SRH_1km_LM ?? 0),
                SRH_3km_LM:  Math.round(p.SRH_3km_LM ?? 0),
                T2m:       Math.round(p.T2m * 10) / 10,
                Td2m:      Math.round(p.Td2m * 10) / 10,
                CAPE_sfc:  Math.round(p.CAPE_sfc),
                CIN_sfc:   Math.round(p.CIN_sfc),
                LI_sfc:    p.LI_sfc != null ? Math.round(p.LI_sfc * 10) / 10 : null,
                PWAT:      Math.round(p.PWAT * 10) / 10,
                PBL_H:     Math.round(p.PBL_H),
                RADIATION: Math.round(p.RADIATION),
            };
        }

        // ── Alle Stunden verarbeiten ────────────────────────────────────────
        const hours = data.hourly.time.map((t, i) => {
            const fTime   = new Date(t);
            const leadH   = Math.round((fTime - now) / 3600000);

            const gewitterByModel = {};
            const paramsByModel   = {};

            for (const model of MODELS) {
                const sfc             = extractSurface(data.hourly, i, model);
                const { profile, p_sfc } = buildProfile(data.hourly, i, model);
                const params  = computeThunderParams(sfc, profile, p_sfc);
                paramsByModel[model]   = params;
                gewitterByModel[model] = sfc ? calculateLightningProb(params, sfc) : null;
            }

            const prob = ensembleProb(gewitterByModel, leadH);

            const validParams = Object.values(paramsByModel).filter(Boolean);
            const mean = (fn) => ensembleMean(validParams.map(fn));

            const modelle = {};
            for (const model of MODELS) {
                modelle[model] = formatParams(paramsByModel[model], gewitterByModel[model]);
            }

            return {
                time:        t,
                probability: prob,
                ensemble: {
                    MU_CAPE:     Math.round(mean(p => p.MU_CAPE)),
                    BS_06km:     Math.round(mean(p => p.BS_06km) * 10) / 10,
                    SRH_1km_RM:  Math.round(mean(p => p.SRH_1km_RM)),
                    SRH_3km_RM:  Math.round(mean(p => p.SRH_3km_RM)),
                    ML_WMAXSHEAR:Math.round(mean(p => p.ML_WMAXSHEAR)),
                    DCAPE:       Math.round(mean(p => p.DCAPE)),
                    SB_LI:       Math.round(mean(p => p.SB_LI) * 10) / 10,
                    K_Index:     Math.round(mean(p => p.K_Index)),
                    Thetae_01km: Math.round(mean(p => p.Thetae_01km)),
                    LR_36km:     Math.round(mean(p => p.LR_36km) * 10) / 10,
                    SCP_fix:     Math.round(mean(p => p.SCP_fix) * 100) / 100,
                    STP_fix:     Math.round(mean(p => p.STP_fix) * 100) / 100,
                    SHIP:        Math.round(mean(p => p.SHIP)    * 100) / 100,
                },
                modelle,
            };
        });

        // ── Ausgabe filtern ─────────────────────────────────────────────────
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
            if (dp < currentDateStr) return;

            if (!daysMap.has(dp)) {
                const entry = {
                    date:           dp,
                    maxProbability: h.probability,
                    ensemble:       { ...h.ensemble },
                    modelle:        {},
                };
                for (const model of MODELS) {
                    if (h.modelle[model]) {
                        entry.modelle[model] = { ...h.modelle[model] };
                    }
                }
                daysMap.set(dp, entry);
            } else {
                const d = daysMap.get(dp);
                d.maxProbability = Math.max(d.maxProbability, h.probability);
                for (const key of Object.keys(d.ensemble)) {
                    if (h.ensemble[key] != null) {
                        d.ensemble[key] = Math.max(d.ensemble[key] ?? 0, h.ensemble[key]);
                    }
                }
                for (const model of MODELS) {
                    const mh = h.modelle[model];
                    if (!mh) continue;
                    if (!d.modelle[model]) {
                        d.modelle[model] = { ...mh };
                    } else {
                        const dm = d.modelle[model];
                        for (const key of Object.keys(mh)) {
                            const val = mh[key];
                            if (typeof val === 'number') {
                                dm[key] = Math.max(dm[key] ?? 0, val);
                            }
                        }
                    }
                }
            }
        });

        const stunden = nextHours.map(h => ({
            timestamp:     h.time,
            gewitter:      h.probability,
            gewitter_risk: categorizeRisk(h.probability),
            ensemble:      h.ensemble,
            modelle:       h.modelle,
        }));

        const tage = Array.from(daysMap.values())
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(day => ({
                date:          day.date,
                gewitter:      day.maxProbability,
                gewitter_risk: categorizeRisk(day.maxProbability),
                ensemble:      day.ensemble,
                modelle:       day.modelle,
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

function pressureToAltitude(p_hPa) {
    return 44330 * (1 - Math.pow(p_hPa / 1013.25, 0.1903));
}

function deriveDewpoint(T, rh) {
    const a = 17.625, b = 243.04;
    const gamma = Math.log(rh / 100) + a * T / (b + T);
    return (b * gamma) / (a - gamma);
}

function calcRH(T, Td) {
    const es = 6.112 * Math.exp(17.67 * T  / (T  + 243.5));
    const e  = 6.112 * Math.exp(17.67 * Td / (Td + 243.5));
    return Math.min(100, Math.max(0, (e / es) * 100));
}

function mixingRatio(Td, p_hPa) {
    const e = 6.112 * Math.exp(17.67 * Td / (Td + 243.5));
    return 1000 * 0.622 * e / (p_hPa - e);
}

function thetaE(T, Td, p) {
    const T_K = T + 273.15;
    const e   = 6.112 * Math.exp(17.67 * Td / (Td + 243.5));
    const q   = 0.622 * e / (p - e);
    return T_K * Math.pow(1000 / p, 0.285) * Math.exp(2501000 * q / (1005 * T_K));
}

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
        p:     p_target,
        z:     below.z  + frac * (above.z  - below.z),
        T:     below.T  + frac * (above.T  - below.T),
        Td:    below.Td + frac * (above.Td - below.Td),
        rh:    below.rh + frac * (above.rh - below.rh),
        ws_ms: below.ws_ms + frac * (above.ws_ms - below.ws_ms),
        wd:    interpAngle(below.wd, above.wd, frac),
    };
}

function interpAngle(a1, a2, frac) {
    let diff = a2 - a1;
    if (diff >  180) diff -= 360;
    if (diff < -180) diff += 360;
    return (a1 + frac * diff + 360) % 360;
}

function toUV(ws, wd) {
    const r = wd * Math.PI / 180;
    return { u: -ws * Math.sin(r), v: -ws * Math.cos(r) };
}

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

function computeMaxLapseRate2km(profile, sfc, z_bottom, z_top) {
    const WINDOW = 2000;
    const STEP   = 500;
    let maxLR = 0;
    for (let zBase = z_bottom; zBase <= z_top - WINDOW; zBase += STEP) {
        const lo = getAtZ(profile, sfc, zBase);
        const hi = getAtZ(profile, sfc, zBase + WINDOW);
        if (!lo || !hi) continue;
        const lr = (lo.T - hi.T) / 2.0;
        if (lr > maxLR) maxLR = lr;
    }
    return maxLR;
}

function getAtZ(profile, sfc, z_agl) {
    if (z_agl === 0) return { T: sfc.t2m, Td: sfc.d2m, rh: calcRH(sfc.t2m, sfc.d2m) };
    const above = profile.filter(l => l.z >= z_agl).sort((a,b) => a.z - b.z)[0];
    const below = profile.filter(l => l.z <  z_agl).sort((a,b) => b.z - a.z)[0];
    if (!above) return profile[profile.length - 1];
    if (!below) return { T: sfc.t2m, Td: sfc.d2m };
    const frac = (z_agl - below.z) / (above.z - below.z);
    return { T: below.T + frac * (above.T - below.T), Td: below.Td + frac * (above.Td - below.Td) };
}

function lclHeight(T, Td) {
    return Math.max(0, 125 * (T - Td));
}

function parcelTempAtLevel(theta_e_parcel, p_level, T_guess) {
    let Tp = T_guess;
    for (let it = 0; it < 12; it++) {
        const Tp_K = Tp + 273.15;
        const es   = 6.112 * Math.exp(17.67 * Tp / (Tp + 243.5));
        const ws   = 0.622 * es / (p_level - es);
        const ws_g = ws * 1000;
        const th_e = Tp_K
            * Math.pow(1000 / p_level, 0.2854 * (1 - 0.00028 * ws_g))
            * Math.exp((3.376 / Tp_K - 0.00254) * ws_g * (1 + 0.00081 * ws_g));
        const err = theta_e_parcel - th_e;
        Tp += err * 0.25;
        if (Math.abs(err) < 0.005) break;
    }
    return Tp;
}

function computeParcel(T, Td, p_sfc, sfc, profile, type) {
    const dewDep  = Math.max(0, T - Td);
    const lclH    = 125 * dewDep;
    const T_LCL   = T - 0.212 * dewDep - 0.001 * dewDep * dewDep;
    const T_LCL_K = T_LCL + 273.15;

    const e_d   = 6.112 * Math.exp(17.67 * Td / (Td + 243.5));
    const w_gkg = 1000 * 0.622 * e_d / (p_sfc - e_d);

    const theta_e_parcel = (T + 273.15)
        * Math.pow(1000 / p_sfc, 0.2854 * (1 - 0.00028 * w_gkg))
        * Math.exp((3.376 / T_LCL_K - 0.00254) * w_gkg * (1 + 0.00081 * w_gkg));

    const sorted = [...profile].sort((a, b) => a.z - b.z);

    let cape = 0, cin = 0;
    let lfc_hgt = null, el_hgt = lclH, el_temp = T_LCL;
    let aboveLFC = false;
    let T_parcel_500 = null;
    let prevTp = null, prevEnvT = null, prevZ = null;

    for (let idx = 0; idx < sorted.length - 1; idx++) {
        const env  = sorted[idx];
        const next = sorted[idx + 1];

        if (env.z < lclH) {
            const Tp_dry = T - 9.8 * (env.z / 1000);
            const dT_dry = Tp_dry - env.T;
            const dz_eff = Math.min(next.z, lclH) - env.z;
            if (dz_eff > 0 && dT_dry < 0) {
                cin += (dT_dry / (env.T + 273.15)) * 9.81 * dz_eff;
            }
            prevTp = null; prevEnvT = env.T; prevZ = env.z;
            continue;
        }

        const Tp = parcelTempAtLevel(theta_e_parcel, env.p, env.T + 1);
        if (env.p <= 502 && T_parcel_500 === null) T_parcel_500 = Tp;

        const dT = Tp - env.T;
        const dz = next.z - env.z;

        if (dT > 0) {
            if (!aboveLFC) {
                aboveLFC = true;
                if (prevTp !== null && prevEnvT !== null) {
                    const dT_prev = prevTp - prevEnvT;
                    if (dT_prev < 0) {
                        const frac = Math.abs(dT_prev) / (Math.abs(dT_prev) + dT);
                        lfc_hgt = prevZ + frac * (env.z - prevZ);
                    } else { lfc_hgt = env.z; }
                } else { lfc_hgt = env.z; }
            }
            cape   += (dT / (env.T + 273.15)) * 9.81 * dz;
            el_hgt  = next.z;
            el_temp = next.T;
        } else {
            if (!aboveLFC) {
                cin += (dT / (env.T + 273.15)) * 9.81 * dz;
            }
        }

        prevTp = Tp; prevEnvT = env.T; prevZ = env.z;
    }

    const env500 = sorted.find(l => l.p <= 502 && l.p >= 498)
                ?? interpProfile(sorted, 500);
    const li = (env500 && T_parcel_500 !== null)
        ? Math.round((env500.T - T_parcel_500) * 10) / 10
        : null;

    return {
        CAPE:      Math.max(0, Math.round(cape)),
        CIN:       Math.round(Math.max(-500, Math.min(0, cin))),
        LCL_HGT:   Math.round(Math.max(0, lclH)),
        LFC_HGT:   Math.round(lfc_hgt ?? lclH),
        EL_HGT:    Math.round(el_hgt),
        EL_TEMP:   Math.round(el_temp * 10) / 10,
        LI:        li,
        Td_parcel: Td,
        p_parcel:  p_sfc,
    };
}

// FIX B: Mixed-Layer-Tiefe 100 hPa (~1 km) statt 500 m AGL
// Standard-Definition (Doswell & Rasmussen 1994): unterste 100 hPa mitteln.
// 500m AGL ist zu flach und unterschätzt die repräsentative Schicht-Feuchte.
function computeMLParcel(sfc, profile, p_sfc_in) {
    const p_sfc = p_sfc_in ?? 1013.25;
    const p_top = p_sfc - 100; // 100 hPa tiefer = ~1 km AGL

    // Alle Levels von Oberfläche bis p_top mitteln
    const sfcLevel = { T: sfc.t2m, Td: sfc.d2m, p: p_sfc, z: 10 };
    const ml_levels = [
        sfcLevel,
        ...profile.filter(l => l.p <= p_sfc && l.p >= p_top),
    ];

    let sumT = 0, sumTd = 0, sumP = 0, count = 0;
    for (const l of ml_levels) {
        sumT  += l.T;
        sumTd += l.Td;
        sumP  += (l.p ?? p_sfc);
        count++;
    }

    const ml_T  = count > 0 ? sumT  / count : sfc.t2m;
    const ml_Td = count > 0 ? sumTd / count : sfc.d2m;
    const ml_p  = count > 0 ? sumP  / count : p_sfc;

    const res = computeParcel(ml_T, ml_Td, ml_p, sfc, profile, 'ML');
    res.mixR  = mixingRatio(ml_Td, ml_p);
    return res;
}

function computeMUParcel(sfc, profile, p_sfc_in) {
    let maxThetaE = -Infinity, best = null;
    const p_sfc = p_sfc_in ?? (profile.length ? profile[0].p : 1013.25);
    const levels = [
        { T: sfc.t2m, Td: sfc.d2m, p: p_sfc, z: 0 },
        ...profile.filter(l => l.p >= p_sfc - 300),
    ];
    for (const l of levels) {
        const te = thetaE(l.T, l.Td, l.p);
        if (te > maxThetaE) { maxThetaE = te; best = l; }
    }
    if (!best) return computeParcel(sfc.t2m, sfc.d2m, p_sfc, sfc, profile, 'MU');
    return computeParcel(best.T, best.Td, best.p, sfc, profile, 'MU');
}

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

// FIX A: Echtes DCAPE nach Emanuel (1994)
// Definition: Potential energy of a saturated parcel descending from a level
// in the layer where downdraft originates (typ. 700–600 hPa in EU).
// Parcell wird vom feuchtesten (niedrigster Taupunktsdefizit) Level in 500–750 hPa
// trocken-adiabatisch abgesenkt und gegen die Umgebungstemperatur integriert.
// Vorher: vereinfachte Wetbulb-Differenz → überschätzte DCAPE um Faktor 2–5.
function computeDCAPE(profile, sfc) {
    // Downdraft-Parzel startet am Level mit minimalem Theta-E zwischen 500-700 hPa
    // (Trockenster, negativst-auftriebsstärkster Bereich im Profil)
    
    const candidates = profile.filter(l => l.p >= 500 && l.p <= 700);
    if (!candidates.length) return 0;
    
    // Finde das Level mit minimalem Theta-E (trockenste Luft = stärkster Downdraft)
    let minTE = Infinity, startLevel = null;
    for (const l of candidates) {
        const te = thetaE(l.T, l.Td, l.p);
        if (te < minTE) { minTE = te; startLevel = l; }
    }
    if (!startLevel) return 0;
    
    // Taupunkts-Depression am Startlevel
    const dewDep = startLevel.T - startLevel.Td;
    if (dewDep > 40) return 0; // Zu trocken — kein relevanter Downdraft
    
    // Virtuelles Kühlungsterm: Feuchtkugeltemperatur als Parzeltemperatur
    const wetBulbStart = startLevel.T - 0.33 * dewDep;
    
    // Sortiere Profil von Startlevel bis Boden
    const sortedDown = [...profile]
        .filter(l => l.z <= startLevel.z)
        .sort((a, b) => b.z - a.z); // Von oben nach unten
    
    if (sortedDown.length < 2) return 0;
    
    let dcape = 0;
    
    // Parzel kühlt moist-adiabatisch (4.5 K/km) von Startlevel an
    for (let i = 0; i < sortedDown.length - 1; i++) {
        const env   = sortedDown[i];
        const lower = sortedDown[i + 1];
        const dz    = env.z - lower.z; // positiv (von oben nach unten)
        if (dz <= 0) continue;
        
        // Parzeltemperatur am aktuellen Level:
        // Starttemperatur = Feuchtkugel am Startlevel, dann moist-adiabatisch (4.5 K/km)
        const z_from_start = startLevel.z - env.z;
        const T_parcel = wetBulbStart - 4.5 * (z_from_start / 1000);
        
        // Virtuelle Temperaturen (vereinfacht: Tv ≈ T(1 + 0.608*q))
        const e_env    = 6.112 * Math.exp(17.67 * env.Td   / (env.Td   + 243.5));
        const e_parcel = 6.112 * Math.exp(17.67 * T_parcel / (T_parcel + 243.5));
        const q_env    = 0.622 * e_env    / (env.p    - e_env);
        const q_parcel = 0.622 * e_parcel / (env.p    - e_parcel);
        
        const Tv_env    = (env.T    + 273.15) * (1 + 0.608 * q_env);
        const Tv_parcel = (T_parcel + 273.15) * (1 + 0.608 * q_parcel);
        
        // DCAPE-Integral: nur wenn Parzel kälter als Umgebung (negativer Auftrieb)
        const dT_v = Tv_parcel - Tv_env;
        if (dT_v < 0) {
            dcape += Math.abs(dT_v / Tv_env) * 9.81 * dz;
        }
    }
    
    // Bodenlevel: Parzel bis z=0 extrapolieren
    if (sortedDown.length > 0) {
        const lastEnv = sortedDown[sortedDown.length - 1];
        const sfcDz   = lastEnv.z; // Restweg bis Boden
        if (sfcDz > 0) {
            const z_from_start = startLevel.z - lastEnv.z;
            const T_parcel_sfc = wetBulbStart - 4.5 * (z_from_start / 1000);
            const Tv_env_sfc   = (sfc.t2m + 273.15);
            const Tv_parcel_sfc = (T_parcel_sfc + 273.15);
            const dT_v = Tv_parcel_sfc - Tv_env_sfc;
            if (dT_v < 0) {
                dcape += Math.abs(dT_v / Tv_env_sfc) * 9.81 * sfcDz;
            }
        }
    }
    
    return Math.max(0, Math.round(dcape));
}

function computeBulkShear(sfc, profile) {
    const sfcUV = toUV(sfc.ws10_ms, sfc.wd10);
    function bs(z_top) {
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

function computeMeanWinds(sfc, profile) {
    function mw(z_top) {
        const levels = [
            { z: 10, ws_ms: sfc.ws10_ms, wd: sfc.wd10 },
            ...profile.filter(l => l.z <= z_top),
        ];
        if (levels.length < 2) return 0;
        const uvs = levels.map(l => toUV(l.ws_ms, l.wd));
        const uM  = uvs.reduce((s,w) => s + w.u, 0) / uvs.length;
        const vM  = uvs.reduce((s,w) => s + w.v, 0) / uvs.length;
        return Math.hypot(uM, vM);
    }
    return { MW_01km: mw(1000), MW_02km: mw(2000), MW_03km: mw(3000), MW_06km: mw(6000) };
}

function computeBunkers(sfc, profile) {
    const levels06 = [
        { z: 10, u: toUV(sfc.ws10_ms, sfc.wd10).u, v: toUV(sfc.ws10_ms, sfc.wd10).v },
        ...profile.filter(l => l.z <= 6000).map(l => ({ z: l.z, ...toUV(l.ws_ms, l.wd) })),
    ];
    const mwU = levels06.reduce((s, l) => s + l.u, 0) / levels06.length;
    const mwV = levels06.reduce((s, l) => s + l.v, 0) / levels06.length;

    const bot  = toUV(sfc.ws10_ms, sfc.wd10);
    const top6 = profile.filter(l => l.z <= 6000).sort((a,b) => b.z - a.z)[0];
    const topUV = top6 ? toUV(top6.ws_ms, top6.wd) : bot;
    const shU = topUV.u - bot.u;
    const shV = topUV.v - bot.v;
    const shMag = Math.hypot(shU, shV) || 1;

    const D = 7.5;
    const rm_u = mwU + D * (shV / shMag);
    const rm_v = mwV - D * (shU / shMag);
    const lm_u = mwU - D * (shV / shMag);
    const lm_v = mwV + D * (shU / shMag);

    function uvToSpeedDir(u, v) {
        const speed = Math.hypot(u, v);
        const dir = (270 - Math.atan2(v, u) * 180 / Math.PI + 360) % 360;
        return { speed: Math.round(speed * 10) / 10, dir: Math.round(dir) };
    }
    const rm = uvToSpeedDir(rm_u, rm_v);
    const lm = uvToSpeedDir(lm_u, lm_v);
    const mw = uvToSpeedDir(mwU, mwV);

    return {
        RM_speed: rm.speed, RM_dir: rm.dir, RM_u: rm_u, RM_v: rm_v,
        LM_speed: lm.speed, LM_dir: lm.dir, LM_u: lm_u, LM_v: lm_v,
        MW_speed: mw.speed, MW_dir: mw.dir, MW_u: mwU,  MW_v: mwV,
    };
}

function computeSRH(sfc, profile, bunkers) {
    const stormU_RM = bunkers.RM_u;
    const stormV_RM = bunkers.RM_v;
    const stormU_LM = bunkers.LM_u;
    const stormV_LM = bunkers.LM_v;

    function srhLayer(z_top, stormU, stormV) {
        const sfcUV = toUV(sfc.ws10_ms, sfc.wd10);
        const levels = [
            { z: 10, u: sfcUV.u, v: sfcUV.v },
            ...profile
                .filter(l => l.z > 10 && l.z <= z_top)
                .sort((a, b) => a.z - b.z)
                .map(l => ({ z: l.z, ...toUV(l.ws_ms, l.wd) })),
        ];
        if (levels.length < 2) return 0;
        let helicity = 0;
        for (let i = 0; i < levels.length - 1; i++) {
            const u1 = levels[i].u   - stormU;
            const v1 = levels[i].v   - stormV;
            const u2 = levels[i+1].u - stormU;
            const v2 = levels[i+1].v - stormV;
            helicity += u1 * v2 - u2 * v1;
        }
        return helicity;
    }

    return {
        SRH_500m_RM: Math.round(Math.max(0, srhLayer(500,  stormU_RM, stormV_RM))),
        SRH_1km_RM:  Math.round(Math.max(0, srhLayer(1000, stormU_RM, stormV_RM))),
        SRH_3km_RM:  Math.round(Math.max(0, srhLayer(3000, stormU_RM, stormV_RM))),
        SRH_1km_LM:  Math.round(Math.max(0, -srhLayer(1000, stormU_LM, stormV_LM))),
        SRH_3km_LM:  Math.round(Math.max(0, -srhLayer(3000, stormU_LM, stormV_LM))),
    };
}

// FIX E: avgRH mit echtem Fallback statt stilles 60%
// Wenn keine Profile-Level im Fenster: nächstgelegene Level interpolieren.
function avgRH(profile, sfc, z1, z2) {
    const levels = profile.filter(l => l.z >= z1 && l.z <= z2);
    if (levels.length > 0) {
        return Math.round(levels.reduce((s,l) => s + l.rh, 0) / levels.length);
    }
    // Fallback: interpoliere zwischen nächstem Level unterhalb und oberhalb
    const below = profile.filter(l => l.z < z1).sort((a,b) => b.z - a.z)[0];
    const above = profile.filter(l => l.z > z2).sort((a,b) => a.z - b.z)[0];
    if (below && above) {
        return Math.round((below.rh + above.rh) / 2);
    }
    if (below) return Math.round(below.rh);
    if (above) return Math.round(above.rh);
    // Letzter Fallback: Oberflächen-RH
    return Math.round(calcRH(sfc.t2m, sfc.d2m));
}

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

function computeSWEAT(p850, p500, srh1km, tt) {
    if (!p850 || !p500) return 0;
    const Td850 = p850.Td;
    const ws850 = p850.ws_ms * 1.944;
    const ws500 = p500.ws_ms * 1.944;
    if (tt < 49) return 0;
    return 12 * Td850 + 20 * (tt - 49) + 2 * ws850 + ws500
         + 125 * (Math.sin((p500.wd - p850.wd) * Math.PI / 180) + 0.2);
}

function computeSCP(muCape, shear06, srh3km, cin) {
    if (muCape < 100 || shear06 < 6 || srh3km < 40) return 0;
    const magCin  = -Math.min(0, cin);
    const cinTerm = magCin < 40 ? 1.0 : Math.max(0.1, 1 - (magCin - 40) / 200);
    return Math.max(0, (muCape/1000) * (srh3km/50) * Math.min(shear06/12, 1.5) * cinTerm);
}

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

function computeSHIP(MU, BS, p500, p700) {
    if (!p500 || !p700) return 0;
    if (MU.CAPE < 100)  return 0;
    const lr   = (p700.T - p500.T) / Math.max(1, (p500.z - p700.z) / 1000);
    const muMr = mixingRatio(MU.Td_parcel ?? -5, MU.p_parcel ?? 850);
    // Struktur unverändert; Scoring-Schwellen in calculateLightningProb angepasst (FIX D)
    return (MU.CAPE * muMr * lr * -p500.T * BS.BS_06km) / 42000000;
}

function computeDCP(dcape, muCape, shear06, srh1km) {
    if (dcape < 100 || muCape < 100 || shear06 < 6) return 0;
    return (dcape/980) * (muCape/2000) * (shear06/20) * (srh1km/100);
}

function computeSHERBS3(lr36, shear06, srh3km, muCape) {
    if (muCape >= 1000) return 0;
    return (lr36 / 9.0) * (shear06 / 27) * (srh3km / 150);
}

function computeSHERBE(maxLR_2km, shear06, srh3km, muCape) {
    if (muCape >= 1000) return 0;
    return (maxLR_2km / 9.0) * (shear06 / 27) * (srh3km / 150) * (muCape < 500 ? 1.5 : 1.0);
}

function computeDEI(mlWmaxshear, coldPoolStrength) {
    if (mlWmaxshear <= 0 || coldPoolStrength <= 0) return 0;
    return (mlWmaxshear / 500) * (coldPoolStrength / 30);
}

function computeTIP(muCape, srh1km, shear06, lclH) {
    if (muCape < 80 || srh1km < 50 || shear06 < 12) return 0;
    const lclTerm = lclH < 1000 ? 1.0 : lclH < 2000 ? (2000 - lclH) / 1000 : 0;
    return (muCape/1000) * (srh1km/150) * (shear06/20) * lclTerm;
}

function computeMoistureFlux(sfc, profile, z_top) {
    const levels = [
        { z: 10, ws_ms: sfc.ws10_ms, Td: sfc.d2m, p: 1013.25 },
        ...profile.filter(l => l.z <= z_top),
    ];
    const fluxes = levels.map(l => mixingRatio(l.Td, l.p) * l.ws_ms);
    return Math.round(fluxes.reduce((s,f) => s + f, 0) / fluxes.length);
}
