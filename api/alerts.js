// api/alerts.js

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const lat = searchParams.get('lat');
  const lon = searchParams.get('lon');

  let url = "https://api.weather.gov/alerts";
  if (lat && lon) {
    url = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "vercel-serverless-weather-api",
        "Accept": "application/geo+json",
      },
    });

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          error: "Weather API Error",
          status: response.status,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    const data = await response.json();

    // Filtere nur die gewünschten Felder
    const filteredAlerts = data.features?.map(feature => ({
      sent: feature.properties.sent,
      onset: feature.properties.onset,
      ends: feature.properties.ends,
      event: feature.properties.event,
      description: feature.properties.description,
      updated: feature.properties.updated,
    })) || [];

    return new Response(JSON.stringify({ alerts: filteredAlerts }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Request failed",
        detail: err.toString(),
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}
