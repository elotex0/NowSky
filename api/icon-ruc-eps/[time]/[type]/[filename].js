export const config = { runtime: "edge" };

export default async function handler(req) {
   const { method } = req;
  // --- CORS Preflight ---
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      }
    });
  }
  try {
    const { pathname, href } = new URL(req.url);

    // Debug: komplette Anfrage
    console.log("Full request URL:", href);
    console.log("Pathname:", pathname);

    const parts = pathname.split("/").filter(Boolean);

    // Erwartet: ["api", "icon-d2", "<time>", "<type>", "<filename>"]
    const [api, prefix, time, type, filename] = parts;
    console.log("Parsed path parts:", { api, prefix, time, type, filename });

    if (!time || !type || !filename) {
      console.log("Missing path parameters");
      return new Response(
        JSON.stringify({ error: "Missing path parameters", parts }),
        { 
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" }
        }
      );
    }

    // R2 Key
    const key = `${prefix}/${time}/${type}/${filename}`;
    console.log("R2 Key:", key);

    // R2 URL
    const r2Url = `https://pub-9863c1e2db83469a9497b53320eb13da.r2.dev/${key}`;
    console.log("Fetching R2 URL:", r2Url);

    // Basic Auth Header
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secretKey = process.env.R2_SECRET_ACCESS_KEY;
    const headers = new Headers();
    const credentials = Buffer.from(`${accessKey}:${secretKey}`, "utf-8").toString("base64");
    headers.set("Authorization", `Basic ${credentials}`);

    // Fetch von R2
    const res = await fetch(r2Url, { headers });
    console.log("R2 Response status:", res.status);

    if (!res.ok) {
      console.log("Image not found at R2");
      return new Response(
        JSON.stringify({ error: "Image not found", status: res.status }),
        { status: 404 }
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    console.log("Fetched image successfully, size:", arrayBuffer.byteLength);

    return new Response(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=0, s-maxage=10800, stale-while-revalidate=0",
      },
    });

  } catch (err) {
    console.log("Unexpected error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
