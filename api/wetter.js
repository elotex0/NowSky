export default async function handler(req, res) {
  // CORS Header
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon } = req.query;
  const DEEPSEEK_API_KEY = "sk-afa22e62d48c4a5f9330da4f6d6a017c"; // Dein Key

  if (!lat || !lon) return res.status(400).json({ error: "lat/lon fehlen" });

  try {
    // 1. Wetterdaten
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
    const weatherData = await weatherRes.json();
    const current = weatherData.current_weather;

    // 2. DeepSeek via fetch (keine Library nötig!)
    const aiRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "Du bist ein Wetter-Experte." },
          { role: "user", content: `Wetter: ${current.temperature}°C, Wind: ${current.windspeed}km/h. Schreib 3-4 Sätze dazu.` }
        ]
      })
    });

    const aiData = await aiRes.json();
    const bericht = aiData.choices[0].message.content;

    res.status(200).json({ bericht });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
