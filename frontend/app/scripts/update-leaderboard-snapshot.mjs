import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  defineChain,
  fallback,
  getAddress,
  http,
  parseAbi,
} from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, "../public/data/leaderboard.json");

const CHAIN_ID = 8453;
const CHAIN_NAME = "Base";
const GAME_ADDRESS = getAddress("0x4163b226f978E071FD45bc913bf9EbC8ed2d5860");
const MULTICALL3_ADDRESS = getAddress("0xca11bde05977b3631167028862be2a173976ca11");
const DEPLOYMENT_BLOCK = 47_506_833n;
const LOG_BLOCK_SPAN = 9_500n;
const PLAYER_BATCH_SIZE = 20;
const RPC_URLS = [
  process.env.LEADERBOARD_RPC_URL,
  process.env.VITE_RPC_URL,
  "https://mainnet.base.org",
].filter(Boolean);

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
  contracts: {
    multicall3: {
      address: MULTICALL3_ADDRESS,
      blockCreated: 5_022n,
    },
  },
});

const publicClient = createPublicClient({
  chain,
  transport: fallback(RPC_URLS.map((url) => http(url, { retryCount: 2, timeout: 12_000 }))),
});

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function withRetries(label, fn, maxAttempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === maxAttempts) break;
      console.warn(`${label} failed on attempt ${attempt}/${maxAttempts}: ${message}`);
      await sleep(750 * attempt);
    }
  }

  throw lastError;
}

async function readSnapshot() {
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.rows)) throw new Error("rows missing");
    return parsed;
  } catch {
    return {
      generatedAt: new Date(0).toISOString(),
      chainId: CHAIN_ID,
      contract: GAME_ADDRESS,
      deploymentBlock: DEPLOYMENT_BLOCK.toString(),
      lastScannedBlock: (DEPLOYMENT_BLOCK - 1n).toString(),
      entryFee: "1000000",
      rows: [],
    };
  }
}

async function getContractEvents(eventName, fromBlock, toBlock) {
  return withRetries(`${eventName} ${fromBlock}-${toBlock}`, () => publicClient.getContractEvents({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    eventName,
    fromBlock,
    toBlock,
  }));
}

async function collectLogs(eventName, fromBlock, latestBlock) {
  const logs = [];
  let cursor = fromBlock;

  while (cursor <= latestBlock) {
    const toBlock = cursor + LOG_BLOCK_SPAN > latestBlock
      ? latestBlock
      : cursor + LOG_BLOCK_SPAN;
    const chunk = await getContractEvents(eventName, cursor, toBlock);
    if (chunk.length) logs.push(...chunk);
    cursor = toBlock + 1n;
    await sleep(150);
  }

  return logs;
}

async function getPlayersByRoundIds(roundIds) {
  const playersByRid = new Map();

  for (let index = 0; index < roundIds.length; index += PLAYER_BATCH_SIZE) {
    const batch = roundIds.slice(index, index + PLAYER_BATCH_SIZE);
    const contracts = batch.map((rid) => ({
      address: GAME_ADDRESS,
      abi: GAME_ABI,
      functionName: "getPlayers",
      args: [rid],
    }));

    const results = await withRetries(`multicall getPlayers ${batch[0]}-${batch.at(-1)}`, () => publicClient.multicall({
      contracts,
      allowFailure: true,
      batchSize: 0,
    }));

    for (let offset = 0; offset < batch.length; offset += 1) {
      const rid = batch[offset];
      const result = results[offset];
      if (result?.status === "success") {
        playersByRid.set(rid.toString(), result.result ?? []);
      } else {
        playersByRid.set(rid.toString(), []);
      }
    }

    await sleep(250);
  }

  return playersByRid;
}

function sortLogsOldestFirst(logs) {
  return [...logs].sort((left, right) => {
    const leftBlock = left.blockNumber ?? 0n;
    const rightBlock = right.blockNumber ?? 0n;
    if (leftBlock === rightBlock) return Number((left.logIndex ?? 0) - (right.logIndex ?? 0));
    return leftBlock < rightBlock ? -1 : 1;
  });
}

function normalizeRows(rows) {
  const stats = new Map();
  for (const row of rows) {
    if (!row?.address) continue;
    stats.set(row.address.toLowerCase(), {
      address: getAddress(row.address),
      games: Number(row.games ?? 0),
      wins: Number(row.wins ?? 0),
      net: BigInt(row.net ?? "0"),
    });
  }
  return stats;
}

function upsertStat(stats, address) {
  const key = address.toLowerCase();
  const current = stats.get(key) ?? {
    address: getAddress(address),
    games: 0,
    wins: 0,
    net: 0n,
  };
  stats.set(key, current);
  return current;
}

async function main() {
  const snapshot = await readSnapshot();
  const latestBlock = await withRetries("latest block", () => publicClient.getBlockNumber());
  const lastScannedBlock = BigInt(snapshot.lastScannedBlock ?? DEPLOYMENT_BLOCK - 1n);
  const fromBlock = lastScannedBlock + 1n > DEPLOYMENT_BLOCK ? lastScannedBlock + 1n : DEPLOYMENT_BLOCK;
  const entryFee = await withRetries("entryFee", () => publicClient.readContract({
    address: GAME_ADDRESS,
    abi: GAME_ABI,
    functionName: "entryFee",
  }));

  const stats = normalizeRows(snapshot.rows);

  if (fromBlock <= latestBlock) {
    console.log(`Updating leaderboard snapshot from block ${fromBlock} to ${latestBlock}`);

    const [settledLogs, decryptedLogs] = await Promise.all([
      collectLogs("Settled", fromBlock, latestBlock),
      collectLogs("RoundDecrypted", fromBlock, latestBlock),
    ]);

    const decryptedByRid = new Map();
    for (const log of decryptedLogs) {
      decryptedByRid.set(Number(log.args.rid), (log.args.numbers ?? []).map((value) => Number(value)));
    }

    const orderedSettledLogs = sortLogsOldestFirst(settledLogs);
    const playerRoundIds = orderedSettledLogs.map((log) => BigInt(log.args.rid));
    const playersByRid = await getPlayersByRoundIds(playerRoundIds);

    for (const log of orderedSettledLogs) {
      const rid = BigInt(log.args.rid);
      const players = playersByRid.get(rid.toString()) ?? [];
      const guesses = decryptedByRid.get(Number(rid)) ?? [];

      if (!players.length || !guesses.length) continue;

      let minDistance = Number.POSITIVE_INFINITY;
      for (const guess of guesses) {
        const distance = Math.abs(guess - Number(log.args.target));
        if (distance < minDistance) minDistance = distance;
      }

      const winnerIndexes = new Set();
      for (let index = 0; index < guesses.length; index += 1) {
        if (Math.abs(guesses[index] - Number(log.args.target)) === minDistance) {
          winnerIndexes.add(index);
        }
      }

      for (const player of players) {
        const row = upsertStat(stats, player);
        row.games += 1;
        row.net -= BigInt(entryFee);
      }

      for (const winnerIndex of winnerIndexes) {
        const winner = players[winnerIndex];
        if (!winner) continue;
        const row = upsertStat(stats, winner);
        row.wins += 1;
        row.net += BigInt(log.args.payPerWinner);
      }
    }
  } else {
    console.log(`Leaderboard snapshot is already current at block ${lastScannedBlock}`);
  }

  const rows = [...stats.values()]
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

  const payload = {
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    contract: GAME_ADDRESS,
    deploymentBlock: DEPLOYMENT_BLOCK.toString(),
    lastScannedBlock: latestBlock.toString(),
    entryFee: entryFee.toString(),
    rows,
  };

  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${rows.length} leaderboard rows to ${SNAPSHOT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
