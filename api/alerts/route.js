export const runtime = "edge";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");

  let url = "https://api.weather.gov/alerts";
  if (lat && lon) {
    url = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "vercel-edge-weather-api",
        "Accept": "application/geo+json"
      }
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: "Weather API Error", status: res.status }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    const data = await res.json();

    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Request failed", detail: err.toString() }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
}
