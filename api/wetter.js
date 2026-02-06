import { GoogleGenerativeAI } from "@google/generative-ai";

// --- KONFIGURATION ---
const GEMINI_API_KEY = "AIzaSyAsa1XPlK6075ghGYIIXFGFMzo1DEJ9jmc"; 
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export default async function handler(req, res) {
  // CORS Header
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "lat und lon fehlen!" });
  }

  try {
    // 1. Wetterdaten von Open-Meteo holen
    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`
    );
    const weatherData = await weatherRes.json();
    const current = weatherData.current_weather;

    if (!current) throw new Error("Keine Wetterdaten gefunden.");

    // 2. Bericht mit Gemini generieren (Direkt-Methode)
    const prompt = `Du bist ein cooler Wetter-Assistent. Antworte auf Deutsch in 3-4 Sätzen.
    Daten für Koordinaten ${lat}, ${lon}: Temperatur ${current.temperature}°C, Windgeschwindigkeit ${current.windspeed} km/h.
    Schreibe einen kurzen, lockeren Wetterbericht.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const bericht = response.text();

    // 3. Antwort senden
    res.status(200).json({
      success: true,
      bericht: bericht,
      temp: current.temperature
    });

  } catch (error) {
    console.error("Gemini Error:", error);
    res.status(500).json({ 
      error: "Fehler beim Generieren des Berichts", 
      message: error.message 
    });
  }
}
