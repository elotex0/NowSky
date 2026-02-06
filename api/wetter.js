import OpenAI from "openai";

const DEEPSEEK_API_KEY = "sk-afa22e62d48c4a5f9330da4f6d6a017c"; 

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: DEEPSEEK_API_KEY,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon } = req.query;

  try {
    // 1. Wetterdaten holen
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
    const weatherData = await weatherRes.json();
    
    if (!weatherData.current_weather) {
      return res.status(400).json({ error: "Keine Wetterdaten für diese Koordinaten gefunden." });
    }

    const temp = weatherData.current_weather.temperature;

    // 2. DeepSeek Aufruf mit detailliertem Logging
    const completion = await deepseek.chat.completions.create({
      messages: [
        { role: "system", content: "Gib nur einen kurzen Wetterbericht aus." },
        { role: "user", content: `Es sind ${temp} Grad. Schreib 3 Sätze.` }
      ],
      model: "deepseek-chat",
    });

    // --- DEBUGGING LOGIK ---
    console.log("DeepSeek Antwort:", JSON.stringify(completion));

    if (!completion || !completion.choices || !completion.choices[0]) {
      return res.status(500).json({ 
        error: "DeepSeek hat keine 'choices' geliefert",
        debug: completion // Das zeigt dir im Browser, was wirklich ankam
      });
    }

    const bericht = completion.choices[0].message.content;

    res.status(200).json({ success: true, bericht });

  } catch (error) {
    // Wenn hier ein Fehler landet, ist es meistens ein API-Error (401, 402, 429)
    res.status(500).json({ 
      error: "API oder Netzwerk-Fehler", 
      message: error.message,
      stack: error.stack // Zeigt genau, wo es im Code knallt
    });
  }
}
