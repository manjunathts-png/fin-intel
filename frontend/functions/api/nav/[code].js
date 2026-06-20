/**
 * Cloudflare Pages Function: proxy mfapi.in NAV history
 *
 * mfapi.in does not send CORS headers, so direct browser fetches fail.
 * This function proxies the request server-side and returns the same JSON
 * with appropriate CORS + cache headers.
 *
 * Route: /api/nav/:code  → https://api.mfapi.in/mf/:code
 */

const UPSTREAM = "https://api.mfapi.in/mf";
const CACHE_TTL = 3600; // 1 hour; NAVs are published once per day

export async function onRequest({ params }) {
  const code = params.code;
  if (!code || !/^\d+$/.test(code)) {
    return new Response(JSON.stringify({ error: "invalid code" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}/${code}`, {
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "upstream unreachable", detail: e.message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!upstream.ok) {
    return new Response(JSON.stringify({ error: `upstream ${upstream.status}` }), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await upstream.text();
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}
