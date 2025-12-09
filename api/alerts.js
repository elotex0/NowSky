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

    return new Response(JSON.stringify(data), {
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