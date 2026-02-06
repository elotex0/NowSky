import { GoogleGenerativeAI } from "@google/generative-ai";

// --- KONFIGURATION ---
const GEMINI_API_KEY = "AIzaSyAsa1XPlK6075ghGYIIXFGFMzo1DEJ9jmc"; 
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Wir nutzen 'gemini-1.5-flash' ohne Pfad-Präfix
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export default async function handler(req, res) {
  // CORS Header (Wichtig für dein Frontend!)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon fehlen!" });
  }

  try {
    // 1. Wetterdaten von Open-Meteo
    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`
    );
    const weatherData = await weatherRes.json();
    const current = weatherData.current_weather;

    if (!current) throw new Error("Keine Wetterdaten gefunden.");

    // 2. Bericht generieren
    // Wichtig: Wir bauen den Prompt so, dass er keine Sonderzeichen-Fehler macht
    const prompt = `Schreibe einen Wetterbericht auf Deutsch für Koordinaten ${lat}, ${lon}. 
    Temperatur: ${current.temperature}°C, Wind: ${current.windspeed} km/h. 
    Halte dich an 3-4 Sätze.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    res.status(200).json({
      success: true,
      bericht: text,
      temp: current.temperature
    });

  } catch (error) {
    console.error("Gemini Fehler:", error);
    res.status(500).json({ 
      error: "API Fehler", 
      message: error.message 
    });
  }
}
