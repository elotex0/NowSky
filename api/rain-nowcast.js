// --- 2) RADVOR Prognose +120 min (RQ: dBZ) ---
for (let i = 1; i <= 24; i++) {
    const t = new Date(now.getTime() + i * 5 * 60 * 1000);
    const fileTime = formatRadvorTime(t);

    // Nur 060 und 120 abrufen
    let step = (i <= 12) ? "060" : "120"; 
    const url = `https://opendata.dwd.de/weather/radar/radvor/rq/RQ${fileTime}_${step}.gz`;

    let val = await getRadvorPixel(url, lat, lng);
    if(val == null) val = 0;

    // Interpolation: linear zwischen 060 und 120
    if(i % 12 !== 0) {
        const prevStep = mmh[mmh.length-1]; // vorheriger Wert
        const nextStep = val; // aktueller Step (060 oder 120)
        const frac = (i % 12)/12;
        val = prevStep + (nextStep - prevStep)*frac;
    } else {
        val = dbzToRain(val);
    }

    mmh.push(dbzToRain(val));
    steps.push(t);
}
