import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SNAPSHOT_PATH = resolve(process.cwd(), "public/data/leaderboard.json");

function json(response: {
  setHeader: (name: string, value: string) => void;
  statusCode: number;
  end: (body: string) => void;
}, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=900");
  response.end(JSON.stringify(body));
}

export default async function handler(
  _request: unknown,
  response: {
    setHeader: (name: string, value: string) => void;
    statusCode: number;
    end: (body: string) => void;
  },
) {
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=900");
    response.end(raw);
  } catch {
    json(response, 200, { rows: [] });
  }
}
