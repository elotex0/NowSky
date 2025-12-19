// api/alerts.js

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const lat = searchParams.get('lat');
  const lon = searchParams.get('lon');

  if (!lat || !lon) {
    return new Response(
      JSON.stringify({ error: "Missing lat or lon parameter" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const url = `https://api.met.no/weatherapi/metalerts/2.0/current.json?lang=en&lat=${lat}&lon=${lon}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "vercel-serverless-weather-api",
        "Accept": "application/json",
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

    // Filtere die gewünschten Felder
    const filteredAlerts = data.features?.map(feature => ({
    onset: feature.when?.interval?.[0] || null,
    ends: feature.when?.interval?.[1] || null,
    event: feature.properties.event || null,
    description: feature.properties.description || null,
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
