import OpenAI from "openai";

// --- KONFIGURATION ---
const DEEPSEEK_API_KEY = "sk-afa22e62d48c4a5f9330da4f6d6a017c"; 
// ---------------------

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: DEEPSEEK_API_KEY
});

// Hilfsfunktion für Wetter-Codes (WMO Standard)
const getWetterBeschreibung = (code) => {
  const codes = {
    0: "klarer Himmel", 1: "hauptsächlich klar", 2: "teils bewölkt", 3: "bedeckt",
    45: "Nebel", 48: "Raureifnebel", 51: "leichter Nieselregen", 61: "leichter Regen",
    71: "leichter Schneefall", 80: "Regenschauer", 95: "Gewitter"
  };
  return codes[code] || "wechselhaft";
};

export default async function handler(req, res) {
  // --- CORS HEADER ---
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // Erlaubt Aufrufe von allen Domains
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Falls ein "Preflight" Request (OPTIONS) kommt, direkt antworten
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "Parameter fehlen (lat & lon benötigt)." });
  }

  try {
    // 1. Wetterdaten abrufen
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`
    );
    const data = await response.json();
    const current = data.current_weather;

    // 2. Wetter-Code übersetzen für besseres KI-Verständnis
    const zustand = getWetterBeschreibung(current.weathercode);

    // 3. DeepSeek Prompt
    const prompt = `
      Aktuelles Wetter an Position (${lat}, ${lon}):
      - Temperatur: ${current.temperature}°C
      - Wind: ${current.windspeed} km/h
      - Zustand: ${zustand}
      
      Schreibe einen kurzen Wetterbericht (3-4 Sätze). 
      Erwähne die Temperatur und ob man eine Jacke braucht.
    `;

    const completion = await deepseek.chat.completions.create({
      messages: [
        { role: "system", content: "Du bist ein präziser Wetter-Experte." },
        { role: "user", content: prompt }
      ],
      model: "deepseek-chat",
    });

    const bericht = completion.choices[0].message.content;

    // 4. Antwort senden
    res.status(200).json({
      success: true,
      bericht: bericht
    });

  } catch (error) {
    res.status(500).json({ error: "API Fehler", details: error.message });
  }
}
