function esc(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readHeader(headers: Record<string, string | string[] | undefined>, key: string) {
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

const SITE_ORIGIN = "https://twothirds.fun";

export default function handler(
  request: { url?: string; headers: Record<string, string | string[] | undefined> },
  response: {
    setHeader: (name: string, value: string) => void;
    statusCode: number;
    end: (body: string) => void;
  },
) {
  const forwardedPath = request.url ?? "/";
  const url = new URL(forwardedPath, SITE_ORIGIN);
  const rid = url.searchParams.get("rid") ?? "0";
  const card = url.searchParams.get("card") ?? "0";
  const target = url.searchParams.get("target") ?? "0";
  const avg = url.searchParams.get("avg") ?? "0";
  const pot = url.searchParams.get("pot") ?? "$0.00";
  const won = url.searchParams.get("won") === "1";
  const pay = url.searchParams.get("pay") ?? "$0.00";
  const off = url.searchParams.get("off") ?? "0";
  const winners = url.searchParams.get("winners") ?? "0";

  const title = won
    ? `I won ${pay} on TWO·THIRDS`
    : `Played card #${card} on TWO·THIRDS`;
  const description = won
    ? `Round #${rid}. Card #${card} landed closest to target ${target}. ${winners} winner${winners === "1" ? "" : "s"} split the pot.`
    : `Round #${rid}. Card #${card}, target ${target}, off by ${off}. Next one is mine.`;
  const imageUrl = `${SITE_ORIGIN}/api/share-image.ts${url.search}`;
  const destination = SITE_ORIGIN;
  const imageAlt = won
    ? `TWO THIRDS result card, round ${rid}, card ${card} won ${pay}`
    : `TWO THIRDS result card, round ${rid}, card ${card}, target ${target}`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <link rel="canonical" href="${esc(url.toString())}" />
    <meta name="description" content="${esc(description)}" />
    <meta property="og:site_name" content="TWO·THIRDS" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${esc(url.toString())}" />
    <meta property="og:image" content="${esc(imageUrl)}" />
    <meta property="og:image:secure_url" content="${esc(imageUrl)}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${esc(imageAlt)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@twothirdsfun" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:url" content="${esc(url.toString())}" />
    <meta name="twitter:image" content="${esc(imageUrl)}" />
    <meta name="twitter:image:alt" content="${esc(imageAlt)}" />
    <script>
      window.location.replace(${JSON.stringify(destination)});
    </script>
    <noscript>
      <meta http-equiv="refresh" content="0;url=${destination}" />
    </noscript>
    <style>
      body{margin:0;background:#0a0705;color:#ffb000;font:20px/1.4 monospace;display:grid;place-items:center;height:100vh}
      .box{max-width:720px;padding:24px;border:1px solid #4d3510;background:#120b06}
      a{color:#36f5ff}
    </style>
  </head>
  <body>
    <div class="box">
      <div>Redirecting to TWO·THIRDS...</div>
      <div style="margin-top:8px">Round #${esc(rid)} · card #${esc(card)} · target ${esc(target)} · avg ${esc(avg)} · pot ${esc(pot)}</div>
      <div style="margin-top:8px"><a href="${destination}">Open twothirds.fun</a></div>
    </div>
  </body>
</html>`;

  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "public, max-age=0, s-maxage=300");
  response.end(html);
}
