function calculateLightningProbability(hour) {
    const cape   = Math.max(0, hour.cape ?? 0);
    const li     = hour.liftedIndex ?? calcLiftedIndex(hour);
    const cin    = hour.cin ?? 0;
    const magCin = -Math.min(0, cin);
    const shear  = calcShear(hour);          // km/h-ähnliche Einheit (m/s * 1.08 * 3.6 → nein: calcShear gibt m/s aus!)
    const shearMS = shear / 3.6;             // → echte m/s für Vergleiche mit Literaturwerten
    const meanRH = hour.meanRH ?? 50;
    const mlMR   = hour.mlMixRatio ?? 0;
    const wbz    = hour.wbzHeight ?? calcWBZHeight(hour);
    const pwat   = hour.pwat ?? 20;
    const month  = new Date(hour.time).getMonth() + 1;
    const rad    = hour.directRadiation ?? 0;

    const winterMode = month <= 3 || month >= 11;
    const springMode = month === 4 || month === 5 || month === 9 || month === 10;
    const summerMode = month >= 6 && month <= 8;

    // ── Saisonaler Faktor ────────────────────────────────────────────────
    let f_saison;
    if      (summerMode)                     f_saison = 1.00;
    else if (month === 5 || month === 9)      f_saison = 0.90;
    else if (month === 4 || month === 10)     f_saison = 0.80;
    else if (month === 3 || month === 11)     f_saison = 0.70;
    else                                      f_saison = 0.60;

    // ── Abgeleitete Parameter ────────────────────────────────────────────
    const midLapse    = calcMidLapseRate(hour.temp700, hour.temp500);
    const srh1        = calcSRH(hour, '0-1km');
    const srh3        = calcSRH(hour, '0-3km');
    const lcl         = calcLCLHeight(hour.temperature, hour.dew);
    const isDay       = rad >= 150;
    const isNight     = rad < 20;

    // ── Frontale / synoptische Erkennung ─────────────────────────────────
    // Frontal: starke Scherung + feuchte Luft + Niederschlag
    const isFrontal       = shearMS >= 8 && meanRH >= 65 && (hour.precip ?? 0) >= 25;
    // Kaltfront-Winter: zusätzlich niedrige WBZ (Schauer-Gewitter-Typ)
    const isFrontalWinter = meanRH >= 60 && wbz < 1800 && (hour.precip ?? 0) >= 20;

    // ════════════════════════════════════════════════════════════════════
    // PFAD 1: HSLC — High Shear Low Cape (Kaltfront, Winter/Frühjahr)
    // Lit: Sherburn 2014 — SBCAPE ≤ 500, Shear ≥ 18 m/s
    // Für Europa realistisch ab Shear ≥ 8 m/s mit Frontalunterstützung
    // ════════════════════════════════════════════════════════════════════
    const isHSLC = cape >= 10 && cape < 600
        && shearMS >= 5
        && meanRH >= 55
        && midLapse >= 6.0;   // steile Lapserate nötig für Konvektion

    if (isHSLC && (winterMode || springMode)) {
        const wbzBonus     = wbz < 800  ? 1.5
                           : wbz < 1200 ? 1.3
                           : wbz < 1800 ? 1.1
                           : wbz < 2500 ? 0.9 : 0.6;
        const lapseBonus   = midLapse >= 8.0 ? 1.4
                           : midLapse >= 7.5 ? 1.3
                           : midLapse >= 7.0 ? 1.2
                           : midLapse >= 6.5 ? 1.1 : 1.0;
        const shearScore   = linNorm(shearMS, 5, 25);
        const moistScore   = linNorm(meanRH, 55, 92);
        const instScore    = linNorm(li, 2.5, -2.0);
        const cinScore     = cin >= -15 ? 1.0 : linNorm(cin, -200, -15);
        const frontalBonus = isFrontalWinter ? 1.4 : isFrontal ? 1.2 : 1.0;
        const capeBonus    = linNorm(cape, 10, 400);
        const pwatBonus    = linNorm(pwat, 8, 25);

        let p = shearScore
              * moistScore
              * Math.max(instScore, 0.20)   // Mindestwert: selbst stabile Luft hat etwas Potential frontal
              * cinScore
              * capeBonus
              * pwatBonus
              * wbzBonus
              * lapseBonus
              * frontalBonus
              * 80;                          // Skalierung → max ~65 nach f_saison

        p *= f_saison;
        return Math.min(65, Math.max(0, Math.round(p)));
    }

    // ════════════════════════════════════════════════════════════════════
    // PFAD 2: Luftmassengewitter (Single-Cell, thermisch getrieben)
    // Typisch: Sommer, hohe Einstrahlung, moderates CAPE, wenig Shear
    // Lit: CAPE > 300 J/kg + Tagheizung als Trigger
    // ════════════════════════════════════════════════════════════════════
    const isAirmass = cape >= 300
        && isDay
        && rad >= 200
        && li <= 0
        && magCin <= 60
        && shearMS < 12;

    if (isAirmass) {
        const capeScore  = linNorm(cape, 300, 2500);
        const radScore   = linNorm(rad, 200, 800);
        const liScore    = linNorm(li, 0, -4);
        const rhScore    = linNorm(meanRH, 40, 75);
        const cinScore   = linNorm(cin, -60, 0);

        let p = capeScore * radScore * Math.max(liScore, 0.1) * rhScore * cinScore * 90;
        p *= f_saison;
        return Math.min(85, Math.max(0, Math.round(p)));
    }

    // ════════════════════════════════════════════════════════════════════
    // PFAD 3: Organisierte Gewitter (Multicell/Squall Line)
    // Lit: CAPE > 800 J/kg für organisierte Konvektion, Shear 10-18 m/s
    // ════════════════════════════════════════════════════════════════════
    const isOrganized = cape >= 500
        && shearMS >= 8
        && (srh3 >= 50 || meanRH >= 60);

    if (isOrganized) {
        const capeScore  = linNorm(cape, 500, 3000);
        const shearScore = linNorm(shearMS, 8, 25);
        const srhScore   = linNorm(srh3, 50, 300);
        const rhScore    = linNorm(meanRH, 50, 80);
        const cinScore   = cin >= -30 ? 1.0 : linNorm(cin, -200, -30);
        const lclScore   = lcl < 1000 ? 1.1 : lcl < 2000 ? 1.0 : 0.8;

        let p = capeScore
              * Math.max(shearScore, srhScore * 0.8)
              * rhScore
              * cinScore
              * lclScore
              * 95;
        p *= f_saison;
        return Math.min(95, Math.max(0, Math.round(p)));
    }

    // ════════════════════════════════════════════════════════════════════
    // PFAD 4: Superzelle / schwere Gewitter
    // Lit: SCP ≥ 1, EHI ≥ 1, Shear > 18 m/s, CAPE > 1000
    // ════════════════════════════════════════════════════════════════════
    const scp = calcSCP(cape, shearMS, srh3, cin);
    const ehi = calcEHI(hour);

    const isSupercell = (scp >= 1 || ehi >= 1.0)
        && cape >= 800
        && shearMS >= 12;

    if (isSupercell) {
        const scpScore  = linNorm(scp, 1, 8);
        const ehiScore  = linNorm(ehi, 1, 4);
        const capeScore = linNorm(cape, 800, 4000);
        const cinScore  = cin >= -30 ? 1.0 : linNorm(cin, -150, -30);

        let p = Math.max(scpScore, ehiScore)
              * capeScore
              * cinScore
              * 100;
        p *= f_saison;
        return Math.min(100, Math.max(0, Math.round(p)));
    }

    // ════════════════════════════════════════════════════════════════════
    // PFAD 5: Schwacher Allgemein-Pfad (Auffang für Grenzfälle)
    // z.B. leicht instabile Luft ohne klares Muster, erhöhte Feuchte
    // ════════════════════════════════════════════════════════════════════
    const liThreshHigh = winterMode ? 1.5 : springMode ? 2.5 : 3.0;
    const liThreshLow  = winterMode ? -1.0 : springMode ? -2.0 : -3.0;
    const mrLow        = winterMode ? 2.0 : 4.0;
    const mrHigh       = winterMode ? 6.0 : 9.0;

    const f_instabil = linNorm(li, liThreshHigh, liThreshLow);
    const capeFactor = cape > 0 ? Math.min(1.0, Math.log1p(cape / 200) / Math.log1p(5)) : 0;
    const f_inst     = cape < 50
        ? linNorm(li, liThreshHigh, liThreshLow - 1.0)
        : Math.max(f_instabil, capeFactor * 0.4) * (0.6 + 0.4 * capeFactor);

    const f_meanRH  = linNorm(meanRH, 35, 70);
    const f_mlMR    = linNorm(mlMR, mrLow, mrHigh);
    const f_feuchte = Math.sqrt(f_meanRH * f_mlMR);

    let f_cin = linNorm(cin, winterMode ? -250 : -200, winterMode ? -15 : -25);
    if (isFrontal) f_cin = Math.max(f_cin, 0.5);

    let f_tagesgang = 0.7;
    if (isDay)                         f_tagesgang = 0.7 + 0.3 * linNorm(rad, 150, 700);
    else if ((srh1 >= 80) && shearMS >= 8) f_tagesgang = 0.75;  // LLJ nachts
    else if (isNight && !winterMode)   f_tagesgang = 0.55;
    if (winterMode) f_tagesgang = isFrontal ? 0.85 : 0.70;

    const wmaxshear    = calcWMAXSHEAR(cape, shear);
    const shearLow     = winterMode ? 5.0  : 6.0;
    const shearHigh    = winterMode ? 12.0 : 18.0;
    const f_shear      = linNorm(shear, shearLow, shearHigh);
    const f_wms        = linNorm(wmaxshear, 150, 550);
    const f_organisation = Math.max(f_shear, f_wms * 0.9);

    // Gates
    if (f_feuchte < 0.06) return 0;
    if (f_inst < 0.06)    return 0;
    const cinThreshold = 120 + Math.max(0, (shearMS - 15) * 8) + Math.max(0, (cape - 500) * 0.1);
    if (magCin > cinThreshold && !isFrontal) return 0;
    if (cape < 50 && li > 1.0 && shearMS < 5 && !isFrontal) return 0;

    const pBase = f_inst * f_feuchte * (f_cin * f_tagesgang) * f_organisation * f_saison;
    if (pBase < 0.035) return 0;

    const pRaw = 100 * Math.pow(Math.min(pBase, 0.9) / 0.9, 0.65);
    const p    = Math.round(Math.max(0, Math.min(100, pRaw)));
    return p < 5 ? 0 : p;
}
