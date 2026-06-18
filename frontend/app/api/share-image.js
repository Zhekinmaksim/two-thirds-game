import { createElement as h } from "react";
import { ImageResponse } from "@vercel/og";

function readNumber(url, key, fallback) {
  const raw = url.searchParams.get(key);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readText(url, key, fallback) {
  return url.searchParams.get(key)?.trim() || fallback;
}

function readHeader(headers, key) {
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function box(style, ...children) {
  return h("div", { style: { display: "flex", ...style } }, ...children);
}

export default async function handler(request, response) {
  const proto = readHeader(request.headers, "x-forwarded-proto") ?? "https";
  const host = readHeader(request.headers, "host") ?? "twothirds.fun";
  const url = new URL(request.url ?? "/", `${proto}://${host}`);
  const rid = readText(url, "rid", "0");
  const card = readText(url, "card", "0");
  const target = readText(url, "target", "0");
  const avg = readText(url, "avg", "0");
  const pot = readText(url, "pot", "$0.00");
  const pay = readText(url, "pay", "$0.00");
  const won = url.searchParams.get("won") === "1";
  const off = readText(url, "off", "0");
  const winners = readText(url, "winners", "0");
  const accent = won ? "#45e645" : "#ff3b5c";
  const subtitle = won
    ? `${winners} winner${winners === "1" ? "" : "s"} split ${pot}`
    : `off by ${off} · next one is mine`;
  const big = won ? `WON ${pay}` : `CARD #${card}`;
  const sideLabel = won ? "WINNER PAYOUT" : "TARGET";
  const sideValue = won ? pay : `#${target}`;
  const averageDisplay = Number.isFinite(readNumber(url, "avg", Number(avg))) ? avg : "0";

  const image = new ImageResponse(
    box(
      {
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: "#080503",
        color: "#ffb000",
        fontFamily: "monospace",
        overflow: "hidden",
      },
      box({
        position: "absolute",
        inset: "0",
        background:
          "radial-gradient(120% 90% at 50% 0%, rgba(255,176,0,0.12) 0%, rgba(8,5,3,0) 58%), linear-gradient(180deg, #140d06 0%, #080503 100%)",
      }),
      box(
        {
          position: "absolute",
          inset: "22px",
          border: "2px solid rgba(255,176,0,0.32)",
          display: "flex",
          flexDirection: "column",
          padding: "34px 40px",
          justifyContent: "space-between",
        },
        box(
          { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
          box(
            { display: "flex", flexDirection: "column" },
            box({ fontSize: 22, color: "rgba(255,176,0,0.8)", letterSpacing: 2 }, "BASE · USDC · INCO ENCRYPTED"),
            box(
              { fontSize: 76, marginTop: 18, color: "#ffb000", letterSpacing: 4, textShadow: "0 0 24px rgba(255,176,0,0.28)" },
              "TWO",
              h("span", { style: { color: "#ff3b5c" } }, "·"),
              "THIRDS",
            ),
          ),
          box(
            {
              display: "flex",
              fontSize: 20,
              color: "#080503",
              background: "#ffb000",
              padding: "10px 14px",
              borderRadius: 4,
              letterSpacing: 2,
            },
            `ROUND #${rid}`,
          ),
        ),
        box(
          { display: "flex", gap: 22, alignItems: "stretch" },
          box(
            {
              flex: 1,
              display: "flex",
              flexDirection: "column",
              border: "1px solid rgba(255,176,0,0.28)",
              background: "rgba(12,8,4,0.78)",
              padding: "24px 26px",
            },
            box({ fontSize: 22, color: "rgba(255,176,0,0.75)", letterSpacing: 2 }, "YOUR RESULT"),
            box({ fontSize: 70, color: accent, marginTop: 18, textShadow: `0 0 20px ${accent}55` }, big),
            box({ fontSize: 28, color: "#36f5ff", marginTop: 10 }, `card #${card} · target ${target}`),
            box({ fontSize: 22, color: "rgba(255,176,0,0.86)", marginTop: 18 }, subtitle),
          ),
          box(
            {
              width: 290,
              display: "flex",
              flexDirection: "column",
              border: "1px solid rgba(54,245,255,0.28)",
              background: "rgba(11,16,19,0.82)",
              padding: "24px 26px",
              justifyContent: "space-between",
            },
            box(
              { display: "flex", flexDirection: "column" },
              box({ fontSize: 20, color: "#36f5ff", letterSpacing: 2 }, sideLabel),
              box({ fontSize: 54, color: won ? "#45e645" : "#36f5ff", marginTop: 12 }, sideValue),
            ),
            box(
              { display: "flex", flexDirection: "column", gap: 10 },
              box({ fontSize: 20, color: "rgba(255,176,0,0.72)" }, `avg ${averageDisplay}`),
              box({ fontSize: 20, color: "rgba(255,176,0,0.72)" }, `pot ${pot}`),
              box({ fontSize: 20, color: "rgba(255,176,0,0.72)" }, "automatic payout"),
            ),
          ),
        ),
        box(
          { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 24, color: "rgba(255,176,0,0.72)" },
          box({}, "guess 2/3 of the average · lowest distance takes the pot"),
          box({ color: "#36f5ff" }, "twothirds.fun"),
        ),
      ),
    ),
    { width: 1200, height: 630 },
  );

  response.statusCode = 200;
  for (const [key, value] of image.headers.entries()) {
    response.setHeader(key, value);
  }
  response.end(Buffer.from(await image.arrayBuffer()));
}
