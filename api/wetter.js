import OpenAI from "openai";

// --- KONFIGURATION ---
const DEEPSEEK_API_KEY = "sk-afa22e62d48c4a5f9330da4f6d6a017c"; 

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: DEEPSEEK_API_KEY,
  // Verhindert Fehler in manchen Umgebungen
  maxRetries: 2,
});

const getWetterBeschreibung = (code) => {
  const codes = {
    0: "klarer Himmel", 1: "hauptsächlich klar", 2: "teils bewölkt", 3: "bedeckt",
    45: "Nebel", 48: "Raureifnebel", 51: "leichter Nieselregen", 61: "leichter Regen",
    71: "leichter Schneefall", 80: "Regenschauer", 95: "Gewitter"
  };
  return codes[code] || "wechselhaft";
};

export default async function handler(req, res) {
  // CORS Header
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat/lon fehlen" });

  try {
    // 1. Wetterdaten abrufen
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`
    );
    const data = await response.json();
    
    if (!data.current_weather) {
      return res.status(500).json({ error: "Keine Wetterdaten von Open-Meteo erhalten" });
    }

    const current = data.current_weather;
    const zustand = getWetterBeschreibung(current.weathercode);

    // 2. DeepSeek API Aufruf mit Absicherung
    const completion = await deepseek.chat.completions.create({
      messages: [
        { role: "system", content: "Du bist ein präziser Wetter-Experte." },
        { role: "user", content: `Wetter in Bürstadt/Umgebung (${lat}, ${lon}): ${current.temperature}°C, Wind: ${current.windspeed}km/h, ${zustand}. Schreib 3-4 Sätze.` }
      ],
      model: "deepseek-chat",
    }).catch(err => {
      console.error("DeepSeek Error:", err);
      return null;
    });

    // 3. Prüfen ob die KI geantwortet hat
    if (!completion || !completion.choices || completion.choices.length === 0) {
      return res.status(200).json({ 
        success: true, 
        bericht: `Aktuell sind es ${current.temperature}°C mit ${zustand}. (KI-Bericht gerade nicht verfügbar).`,
        hinweis: "Prüfe dein DeepSeek Guthaben oder den API-Key!"
      });
    }

    const bericht = completion.choices[0].message.content;

    res.status(200).json({
      success: true,
      bericht: bericht
    });

  } catch (error) {
    res.status(500).json({ error: "Server Fehler", details: error.message });
  }
}
