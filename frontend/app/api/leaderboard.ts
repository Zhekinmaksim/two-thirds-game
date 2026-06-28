import {
  createPublicClient,
  defineChain,
  fallback,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { limitRpcRoute } from "./_rpc-guard";

const CHAIN_ID = 8453;
const CHAIN_NAME = "Base";
const GAME_ADDRESS = getAddress("0x4163b226f978E071FD45bc913bf9EbC8ed2d5860");
const DEPLOYMENT_BLOCK = 47_506_833n;
const LOG_BLOCK_SPAN = 5_000n;
const CACHE_TTL_MS = 5 * 60_000;
const ROUTE_LIMIT = 24;
const RPC_URLS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
];

const GAME_ABI = parseAbi([
  "function entryFee() view returns (uint256)",
  "function getPlayers(uint256 rid) view returns (address[])",
  "event Settled(uint256 indexed rid, uint16 target, uint16 avgX1, uint256 netPot, uint256 payPerWinner, uint256 winners)",
  "event RoundDecrypted(uint256 indexed rid, uint16[] numbers)",
]);

const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_NAME,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
});

const publicClient = createPublicClient({
  chain,
  transport: fallback(RPC_URLS.map((url) => http(url, { retryCount: 1, timeout: 8_000 }))),
});

let cachedAt = 0;
let cachedPayload: { rows: Array<{ address: string; games: number; wins: number; net: string }> } | null = null;
let inflightPayloadPromise: Promise<{ rows: Array<{ address: string; games: number; wins: number; net: string }> }> | null = null;

function json(response: {
  setHeader: (name: string, value: string) => void;
  statusCode: number;
  end: (body: string) => void;
}, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  response.end(JSON.stringify(body));
}

function sortLogsNewestFirst<T extends { blockNumber?: bigint | null; logIndex?: number | null }>(logs: T[]) {
  return [...logs].sort((left, right) => {
    const leftBlock = left.blockNumber ?? 0n;
    const rightBlock = right.blockNumber ?? 0n;
    if (leftBlock === rightBlock) return Number((right.logIndex ?? 0) - (left.logIndex ?? 0));
    return leftBlock > rightBlock ? -1 : 1;
  });
}

async function getAllSettledLogs() {
  return getAllLogs("Settled");
}

async function getAllRoundDecryptedLogs() {
  return getAllLogs("RoundDecrypted");
}

async function getAllLogs(eventName: "Settled" | "RoundDecrypted") {
  const latestBlock = await publicClient.getBlockNumber();
  const logs = [];

  let fromBlock = DEPLOYMENT_BLOCK;
  while (fromBlock <= latestBlock) {
    const toBlock = fromBlock + LOG_BLOCK_SPAN > latestBlock
      ? latestBlock
      : fromBlock + LOG_BLOCK_SPAN;
    const chunk = await publicClient.getContractEvents({
      address: GAME_ADDRESS,
      abi: GAME_ABI,
      eventName,
      fromBlock,
      toBlock,
    });
    if (chunk.length) logs.push(...chunk);
    fromBlock = toBlock + 1n;
  }

  return sortLogsNewestFirst(logs);
}

async function getLeaderboardRows() {
  const [entryFee, settledLogs, decryptedLogs] = await Promise.all([
    publicClient.readContract({
      address: GAME_ADDRESS,
      abi: GAME_ABI,
      functionName: "entryFee",
    }),
    getAllSettledLogs(),
    getAllRoundDecryptedLogs(),
  ]);

  const decryptedByRid = new Map<number, number[]>();
  for (const log of decryptedLogs) {
    decryptedByRid.set(Number(log.args.rid), (log.args.numbers ?? []).map((value) => Number(value)));
  }

  const stats = new Map<string, { address: string; games: number; wins: number; net: bigint }>();

  for (const log of settledLogs) {
    const rid = BigInt(log.args.rid);
    const players = await publicClient.readContract({
      address: GAME_ADDRESS,
      abi: GAME_ABI,
      functionName: "getPlayers",
      args: [rid],
    });
    const guesses = decryptedByRid.get(Number(rid)) ?? [];

    if (!players.length || !guesses.length) continue;

    let minDistance = Number.POSITIVE_INFINITY;
    for (const guess of guesses) {
      const distance = Math.abs(guess - Number(log.args.target));
      if (distance < minDistance) minDistance = distance;
    }

    const winnerIndexes = new Set<number>();
    for (let index = 0; index < guesses.length; index += 1) {
      if (Math.abs(guesses[index] - Number(log.args.target)) === minDistance) {
        winnerIndexes.add(index);
      }
    }

    for (const player of players) {
      const key = player.toLowerCase();
      const row = stats.get(key) ?? {
        address: player,
        games: 0,
        wins: 0,
        net: 0n,
      };
      row.games += 1;
      row.net -= BigInt(entryFee);
      stats.set(key, row);
    }

    for (const winnerIndex of winnerIndexes) {
      const winner = players[winnerIndex];
      if (!winner) continue;
      const key = winner.toLowerCase();
      const row = stats.get(key);
      if (!row) continue;
      row.wins += 1;
      row.net += BigInt(log.args.payPerWinner);
    }
  }

  return [...stats.values()]
    .sort((left, right) => {
      if (left.net === right.net) return right.wins - left.wins;
      return left.net > right.net ? -1 : 1;
    })
    .map((row) => ({
      address: row.address,
      games: row.games,
      wins: row.wins,
      net: row.net.toString(),
    }));
}

async function getOrBuildPayload() {
  if (cachedPayload && Date.now() - cachedAt < CACHE_TTL_MS) return cachedPayload;
  if (inflightPayloadPromise) return inflightPayloadPromise;

  inflightPayloadPromise = (async () => {
    const rows = await getLeaderboardRows();
    const payload = { rows };
    cachedPayload = payload;
    cachedAt = Date.now();
    return payload;
  })();

  try {
    return await inflightPayloadPromise;
  } finally {
    inflightPayloadPromise = null;
  }
}

export default async function handler(
  request: { headers?: Record<string, string | string[] | undefined> },
  response: {
    setHeader: (name: string, value: string) => void;
    statusCode: number;
    end: (body: string) => void;
  },
) {
  try {
    const headers = request.headers ?? {};
    const rate = limitRpcRoute(headers, ROUTE_LIMIT);
    response.setHeader("x-rpc-rate-limit-remaining", String(rate.remaining));
    response.setHeader("x-rpc-rate-limit-reset", String(rate.resetAt));

    if (!rate.allowed) {
      if (cachedPayload) return json(response, 200, cachedPayload);
      return json(response, 429, { error: "rate limited" });
    }

    const payload = await getOrBuildPayload();
    return json(response, 200, payload);
  } catch (error) {
    if (cachedPayload) return json(response, 200, cachedPayload);
    return json(response, 500, {
      error: error instanceof Error ? error.message : "leaderboard unavailable",
    });
  }
}
