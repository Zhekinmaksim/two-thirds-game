import { createElement as h } from "react";
import { ImageResponse } from "@vercel/og";

export const config = {
  runtime: "edge",
};

function readText(url: URL, key: string, fallback: string) {
  return url.searchParams.get(key)?.trim() || fallback;
}

function box(style: Record<string, string | number>, ...children: unknown[]) {
  return h("div", { style: { display: "flex", ...style } }, ...children);
}

function miniCell(index: number, winNum: number, yourNum: number) {
  const isWin = index === winNum;
  const isMine = index === yourNum;
  const background = isWin
    ? "linear-gradient(180deg, #16361a 0%, #0c220f 100%)"
    : isMine
      ? "#0c1417"
      : "repeating-linear-gradient(45deg, #473313 0 4px, #33240d 4px 8px)";
  const borderColor = isWin ? "#45e645" : isMine ? "#36f5ff" : "rgba(255,176,0,0.28)";
  const textColor = isWin ? "#9dffa0" : isMine ? "#9fe9ff" : "rgba(255,176,0,0.7)";
  const boxShadow = isWin
    ? "0 0 12px rgba(69,230,69,0.55)"
    : isMine
      ? "0 0 8px rgba(54,245,255,0.45)"
      : "none";
  const opacity = isWin || isMine ? "1" : "0.55";

  return box(
    {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 4,
      border: `1px solid ${borderColor}`,
      background,
      boxShadow,
      opacity,
    },
    box(
      {
        fontSize: 10,
        color: textColor,
        fontWeight: 700,
      },
      String(index),
    ),
  );
}

function miniGrid(winNum: number, yourNum: number) {
  const rows = [];
  for (let row = 0; row < 8; row += 1) {
    const cells = [];
    for (let col = 0; col < 8; col += 1) {
      const index = row * 8 + col;
      cells.push(miniCell(index, winNum, yourNum));
    }
    rows.push(box({ gap: 5 }, ...cells));
  }
  return box({ flexDirection: "column", gap: 5 }, ...rows);
}

export default function handler(request: Request) {
  const url = new URL(request.url);

  const rid = readText(url, "rid", "0");
  const yourNum = Number(readText(url, "card", "0"));
  const target = readText(url, "target", "0");
  const avg = readText(url, "avg", "0");
  const pot = readText(url, "pot", "$0.00");
  const pay = readText(url, "pay", "$0.00");
  const won = url.searchParams.get("won") === "1";
  const off = readText(url, "off", "0");
  const winners = Number(readText(url, "winners", "0"));
  const winNum = Number(readText(url, "win", target));

  const bigText = won ? `WON ${pay}` : `OFF BY ${off}`;
  const note = won
    ? winners > 1
      ? `closest of the field · ${winners} winners split ${pot}`
      : `closest of the field · 1 winner takes ${pay}`
    : "so close · next one is mine";
  const verdictColor = won ? "#45e645" : "#ff3b5c";
  const footRight = won ? "auto-paid ✓" : `your #${yourNum}`;

  return new ImageResponse(
    box(
      {
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        background: "radial-gradient(125% 90% at 50% 0%, #1c1208 0%, #0a0705 58%, #050302 100%)",
        color: "#ffb000",
        fontFamily: "monospace",
      },
      box({
        position: "absolute",
        inset: 0,
        background:
          "repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0 2px, rgba(0,0,0,0.18) 3px, rgba(0,0,0,0.18) 3px)",
        mixBlendMode: "multiply",
      }),
      box({
        position: "absolute",
        inset: 0,
        background: "radial-gradient(125% 100% at 50% 50%, rgba(0,0,0,0) 58%, rgba(0,0,0,0.55) 100%)",
      }),
      box({
        position: "absolute",
        inset: 26,
        border: "2px solid rgba(255,176,0,0.28)",
        borderRadius: 6,
      }),
      box(
        {
          position: "absolute",
          inset: 0,
          padding: "48px 52px",
          flexDirection: "column",
        },
        box(
          { justifyContent: "space-between", alignItems: "center" },
          box(
            {
              fontSize: 23,
              letterSpacing: 3,
              color: "rgba(255,176,0,0.68)",
            },
            "BASE · USDC · INCO ENCRYPTED",
          ),
          box(
            {
              fontSize: 14,
              fontWeight: 700,
              color: "#0a0705",
              background: "#ffb000",
              padding: "9px 13px",
              borderRadius: 3,
              letterSpacing: 1,
              boxShadow: "0 0 14px rgba(255,176,0,0.45)",
            },
            `ROUND #${rid.padStart(2, "0")}`,
          ),
        ),
        box(
          {
            marginTop: 22,
            fontSize: 50,
            fontWeight: 700,
            letterSpacing: 2,
            color: "#ffb000",
            textShadow: "0 0 10px rgba(255,176,0,0.5), 0 0 30px rgba(255,176,0,0.28)",
          },
          "TWO",
          h("span", { style: { color: "#ff3b5c" } }, "·"),
          "THIRDS",
        ),
        box(
          {
            flex: 1,
            gap: 32,
            alignItems: "center",
            marginTop: 18,
          },
          box(
            { flex: 1, flexDirection: "column" },
            box(
              {
                fontSize: 24,
                letterSpacing: 3,
                color: "rgba(255,176,0,0.66)",
              },
              "YOUR RESULT",
            ),
            box(
              {
                marginTop: 18,
                fontSize: won ? 64 : 60,
                fontWeight: 700,
                color: verdictColor,
                textShadow: won
                  ? "0 0 16px rgba(69,230,69,0.6), 0 0 40px rgba(69,230,69,0.3)"
                  : "0 0 16px rgba(255,59,92,0.55), 0 0 40px rgba(255,59,92,0.28)",
              },
              bigText,
            ),
            box(
              {
                fontSize: 20,
                fontWeight: 700,
                color: "#36f5ff",
                textShadow: "0 0 8px rgba(54,245,255,0.4)",
                marginTop: 14,
              },
              `CARD #${yourNum} · TARGET ${target}`,
            ),
            box(
              {
                fontSize: 25,
                color: "rgba(255,176,0,0.74)",
                marginTop: 12,
              },
              note,
            ),
          ),
          box(
            { width: 360, flexDirection: "column" },
            box(
              { justifyContent: "space-between", alignItems: "baseline", marginBottom: 9 },
              box(
                {
                  fontSize: 20,
                  letterSpacing: 2,
                  color: "#45e645",
                  textShadow: "0 0 8px rgba(69,230,69,0.4)",
                },
                "WINNING CARD",
              ),
              box(
                {
                  fontSize: 18,
                  fontWeight: 700,
                  color: "#45e645",
                  textShadow: "0 0 8px rgba(69,230,69,0.5)",
                },
                `#${winNum}`,
              ),
            ),
            miniGrid(winNum, yourNum),
            box(
              {
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 21,
                color: "rgba(255,176,0,0.66)",
                marginTop: 11,
              },
              box({}, `avg ${avg} · pot ${pot}`),
              box(
                {
                  color: won ? "#45e645" : "#36f5ff",
                },
                footRight,
              ),
            ),
          ),
        ),
        box(
          {
            justifyContent: "space-between",
            alignItems: "baseline",
            borderTop: "1px solid rgba(255,176,0,0.22)",
            paddingTop: 16,
            marginTop: 6,
          },
          box(
            {
              fontSize: 24,
              color: "rgba(255,176,0,0.66)",
            },
            "guess 2/3 of the average · lowest distance takes the pot",
          ),
          box(
            {
              fontSize: 17,
              fontWeight: 700,
              color: "#ffb000",
            },
            "twothirds.fun",
          ),
        ),
      ),
    ),
    { width: 1200, height: 630 },
  );
}
