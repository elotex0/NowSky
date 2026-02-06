import OpenAI from "openai";

// --- KONFIGURATION ---
const GEMINI_API_KEY = "AIzaSyAsa1XPlK6075ghGYIIXFGFMzo1DEJ9jmc"; 
// ---------------------

// Gemini lässt sich über die OpenAI-Library ansteuern!
const ai = new OpenAI({
  apiKey: GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

export default async function handler(req, res) {
  // CORS Header
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "Digga, lat und lon fehlen in der URL!" });
  }

  try {
    // 1. Wetterdaten von Open-Meteo holen
    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`
    );
    const weatherData = await weatherRes.json();
    const current = weatherData.current_weather;

    if (!current) throw new Error("Wetter-API liefert keine Daten.");

    // 2. Bericht mit Gemini generieren
    const completion = await ai.chat.completions.create({
      model: "gemini-1.5-flash", // Kostenloses, schnelles Modell
      messages: [
        { 
          role: "system", 
          content: "Du bist ein cooler Wetter-Assistent. Antworte immer auf Deutsch in 3-4 Sätzen." 
        },
        { 
          role: "user", 
          content: `Hier sind Daten für Koordinaten ${lat}, ${lon}: Temperatur ${current.temperature}°C, Wind ${current.windspeed} km/h. Schreib einen kurzen Bericht.` 
        }
      ]
    });

    const bericht = completion.choices[0].message.content;

    // 3. Antwort senden
    res.status(200).json({
      success: true,
      bericht: bericht,
      temp: current.temperature
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ 
      error: "Fehler", 
      message: error.message 
    });
  }
}
