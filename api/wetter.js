import { GoogleGenerativeAI } from "@google/generative-ai";

// --- KONFIGURATION ---
const GEMINI_API_KEY = "DEIN_NEUER_KEY_HIER"; // Nutze einen frischen Key!
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Wir nutzen Gemini 3 Flash (Standard in 2026)
const model = genAI.getGenerativeModel({ model: "gemini-3-flash" });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "Koordinaten fehlen!" });

  try {
    // 1. Wetterdaten holen
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
    const weatherData = await weatherRes.json();
    const current = weatherData.current_weather;

    // 2. KI-Bericht versuchen
    let bericht;
    try {
      const prompt = `Erstelle einen Wetterbericht auf Deutsch (3 Sätze). 
      Ort-Koordinaten: ${lat}, ${lon}. Temperatur: ${current.temperature}°C, Wind: ${current.windspeed} km/h. 
      Sei freundlich und locker.`;

      const result = await model.generateContent(prompt);
      bericht = result.response.text();
    } catch (aiErr) {
      console.error("KI-Fehler:", aiErr);
      // Fallback, falls das Modell-Naming bei Google wieder hakt
      bericht = `In Bürstadt sind es gerade ${current.temperature}°C bei einem Wind von ${current.windspeed} km/h. (KI-Bericht aktuell nicht verfügbar).`;
    }

    res.status(200).json({ success: true, bericht });

  } catch (error) {
    res.status(500).json({ error: "Wetter-Dienst Fehler", message: error.message });
  }
}
