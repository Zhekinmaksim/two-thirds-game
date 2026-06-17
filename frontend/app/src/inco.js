import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  defineChain,
  fallback,
  getAddress,
  getContract,
  http,
  parseAbi,
} from "viem";
import * as IncoLite from "@inco/js/lite";
import { handleTypes } from "@inco/js";

const DEFAULTS = {
  pepper: "mainnet",
  chainId: 8453,
  chainName: "Base",
  rpcUrl: "https://rpc.ankr.com/base/1dfb41f645be2ab63ae3eb7463c41f98995438f00e44a579a0abee13b61cf83a",
  game: "0x0e9D534dE28045A33D8aB94Dbebc6822816ABe1B",
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const ENV = import.meta.env ?? {};

function readEnv(name, fallback) {
  const value = ENV[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeAddress(value, fallback = "") {
  for (const candidate of [value, fallback]) {
    if (!candidate) continue;
    try {
      return getAddress(candidate);
    } catch {
      // ignore invalid candidate and continue
    }
  }
  return null;
}

function clampPick(value) {
  const num = Number(value);
  return Math.max(0, Math.min(63, Math.round(num)));
}

function toBigInt(value) {
  return typeof value === "bigint" ? value : BigInt(value);
}

export const CONFIG = {
  pepper: readEnv("VITE_INCO_PEPPER", DEFAULTS.pepper),
  chainId: Number(readEnv("VITE_CHAIN_ID", String(DEFAULTS.chainId))),
  chainName: readEnv("VITE_CHAIN_NAME", DEFAULTS.chainName),
  rpcUrl: readEnv("VITE_RPC_URL", DEFAULTS.rpcUrl),
  game: normalizeAddress(readEnv("VITE_GAME_ADDRESS", DEFAULTS.game), DEFAULTS.game),
  token: normalizeAddress(readEnv("VITE_TOKEN_ADDRESS", DEFAULTS.token), DEFAULTS.token),
};

const RPC_FALLBACKS = {
  8453: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    DEFAULTS.rpcUrl,
  ],
};

const rpcUrls = [...new Set([CONFIG.rpcUrl, ...(RPC_FALLBACKS[CONFIG.chainId] ?? [])])];
const LOG_BLOCK_SPAN = 5_000n;
const MAX_LOG_LOOKBACK_BLOCKS = 100_000n;
const resultCache = new Map();
let latestSettledBlock = null;
let inco = null;
let gameMetaPromise = null;

const GAME_ABI = parseAbi([
  "function enter(bytes ciphertext) payable",
  "function inputFee() view returns (uint256)",
  "function roundId() view returns (uint256)",
  "function entryFee() view returns (uint256)",
  "function rakeBps() view returns (uint16)",
  "function roundDuration() view returns (uint64)",
  "function getRound(uint256 rid) view returns (uint64 closesAt, bool settled, uint256 pot, uint256 playerCount)",
  "function getPlayers(uint256 rid) view returns (address[])",
  "function settle(uint256[] values, bytes[][] signatures)",
  "event Settled(uint256 indexed rid, uint16 target, uint16 avgX1, uint256 netPot, uint256 payPerWinner, uint256 winners)",
  "event RoundDecrypted(uint256 indexed rid, uint16[] numbers)",
]);

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const chain = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } },
});

export const publicClient = createPublicClient({
  chain,
  transport: fallback(rpcUrls.map((url) => http(url, { retryCount: 1, timeout: 8_000 }))),
});

function requireGameAddress() {
  if (!CONFIG.game) throw new Error("Game contract address is not configured.");
}

function requireTokenAddress() {
  if (!CONFIG.token) throw new Error("Payment token address is not configured.");
}

async function getInco() {
  if (inco) return inco;
  inco = await IncoLite.Lightning.latest(CONFIG.pepper, CONFIG.chainId, {
    hostChainRpcUrls: rpcUrls,
  });
  return inco;
}

async function getPlayersForRound(rid) {
  requireGameAddress();
  return publicClient.readContract({
    address: CONFIG.game,
    abi: GAME_ABI,
    functionName: "getPlayers",
    args: [rid],
  });
}

async function collectLogs(eventName, { limit = 10, rid } = {}) {
  requireGameAddress();

  const latestBlock = await publicClient.getBlockNumber();
  const minBlock = latestBlock > MAX_LOG_LOOKBACK_BLOCKS ? latestBlock - MAX_LOG_LOOKBACK_BLOCKS : 0n;
  const matches = [];
  const ridArg = rid === undefined || rid === null ? undefined : toBigInt(rid);
  const args = ridArg === undefined ? undefined : { rid: ridArg };

  let toBlock = latestSettledBlock && latestSettledBlock < latestBlock ? latestSettledBlock : latestBlock;
  while (toBlock >= minBlock) {
    const fromBlock = toBlock > LOG_BLOCK_SPAN ? toBlock - LOG_BLOCK_SPAN : 0n;
    const logs = await publicClient.getContractEvents({
      address: CONFIG.game,
      abi: GAME_ABI,
      eventName,
      args,
      fromBlock,
      toBlock,
    });

    if (logs.length) {
      matches.push(...logs);
      for (const log of logs) {
        if (typeof log.blockNumber === "bigint") {
          latestSettledBlock = latestSettledBlock === null || log.blockNumber > latestSettledBlock
            ? log.blockNumber
            : latestSettledBlock;
        }
      }
    }

    if (ridArg !== undefined && matches.length) break;
    if (matches.length >= limit) break;
    if (fromBlock === 0n) break;
    toBlock = fromBlock - 1n;
  }

  return matches;
}

async function getDecryptedNumbers(rid) {
  const logs = await collectLogs("RoundDecrypted", { rid, limit: 1 });
  if (!logs.length) return [];
  return (logs[logs.length - 1].args.numbers ?? []).map((value) => Number(value));
}

async function hydrateSettledLog(log) {
  const cacheKey = `${log.transactionHash}:${log.args.rid}`;
  if (resultCache.has(cacheKey)) return resultCache.get(cacheKey);

  const rid = Number(log.args.rid);
  const base = {
    rid,
    target: Number(log.args.target),
    avg: Number(log.args.avgX1),
    netPot: log.args.netPot,
    grossPot: 0n,
    rake: 0n,
    payPerWinner: log.args.payPerWinner,
    winners: Number(log.args.winners),
    winnerAddresses: [],
    guesses: [],
    players: [],
    txHash: log.transactionHash,
  };

  try {
    const [tx, players] = await Promise.all([
      publicClient.getTransaction({ hash: log.transactionHash }),
      getPlayersForRound(log.args.rid),
    ]);

    base.players = players;

    let guesses = await getDecryptedNumbers(log.args.rid);
    if (!guesses.length) {
      const decoded = decodeFunctionData({ abi: GAME_ABI, data: tx.input });
      if (decoded.functionName === "settle") {
        const [values] = decoded.args;
        guesses = values.map((value) => Number(value));
      }
    }

    base.guesses = guesses;
    if (players.length && guesses.length) {
      let minDistance = Number.POSITIVE_INFINITY;
      for (const guess of guesses) {
        const distance = Math.abs(guess - base.target);
        if (distance < minDistance) minDistance = distance;
      }

      base.winnerAddresses = players.filter((_, index) =>
        Math.abs((guesses[index] ?? Number.NaN) - base.target) === minDistance);
    }

  } catch {
    // keep partial data if tx calldata or player lookup is unavailable
  }

  const gameMeta = await getGameMeta().catch(() => null);
  const rakeBps = BigInt(gameMeta?.rakeBps ?? 0);
  const entryFee = BigInt(gameMeta?.entryFee ?? 0n);

  if (base.winnerAddresses.length) {
    const payTotal = BigInt(base.winnerAddresses.length) * BigInt(base.payPerWinner);
    base.netPot = base.netPot || payTotal;
  }

  if (entryFee > 0n && base.players.length) {
    base.grossPot = BigInt(base.players.length) * entryFee;
  }

  if (base.netPot) {
    const divisor = 10_000n - rakeBps;
    base.grossPot = divisor > 0n ? (BigInt(base.netPot) * 10_000n) / divisor : BigInt(base.netPot);
    base.rake = base.grossPot - BigInt(base.netPot);
  }

  resultCache.set(cacheKey, base);
  return base;
}

function providerRank(provider) {
  if (provider?.isRabby) return 0;
  if (provider?.isMetaMask) return 1;
  if (provider?.isCoinbaseWallet) return 2;
  if (provider?.isPhantom) return 3;
  return 9;
}

function getInjectedProviders() {
  const candidates = [];
  if (window.rabby?.ethereum) candidates.push(window.rabby.ethereum);
  if (window.ethereum?.providers?.length) candidates.push(...window.ethereum.providers);
  if (window.ethereum) candidates.push(window.ethereum);

  const unique = [];
  const seen = new Set();
  for (const provider of candidates) {
    if (!provider || typeof provider.request !== "function" || seen.has(provider)) continue;
    seen.add(provider);
    unique.push(provider);
  }

  return unique.sort((left, right) => providerRank(left) - providerRank(right));
}

function getErrorCode(error) {
  return error?.code ?? error?.cause?.code ?? error?.data?.originalError?.code;
}

async function getChainId(provider) {
  const chainIdHex = await provider.request({ method: "eth_chainId" });
  return Number.parseInt(chainIdHex, 16);
}

async function ensureChain(provider) {
  const current = await getChainId(provider);
  if (current === CONFIG.chainId) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${CONFIG.chainId.toString(16)}` }],
    });
    return;
  } catch (error) {
    const code = getErrorCode(error);
    if (code !== 4902 && code !== -32603) throw error;
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [{
      chainId: `0x${CONFIG.chainId.toString(16)}`,
      chainName: CONFIG.chainName,
      rpcUrls: [CONFIG.rpcUrl],
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      blockExplorerUrls: [`https://${CONFIG.chainId === 84532 ? "sepolia." : ""}basescan.org`],
    }],
  });

  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: `0x${CONFIG.chainId.toString(16)}` }],
  });
}

export async function connectWallet() {
  const providers = getInjectedProviders();
  if (!providers.length) throw new Error("No wallet found. Install Rabby, MetaMask, or a compatible wallet.");

  let lastError = null;

  for (const provider of providers) {
    try {
      try {
        await ensureChain(provider);
      } catch (error) {
        if (getErrorCode(error) === 4100) {
          await provider.request({ method: "eth_requestAccounts" });
          await ensureChain(provider);
        } else {
          throw error;
        }
      }

      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!accounts?.length) throw new Error("Wallet returned no accounts.");

      const wallet = createWalletClient({ chain, transport: custom(provider) });
      return { wallet, account: getAddress(accounts[0]) };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Wallet connection failed.");
}

export async function playRound(wallet, account, pick) {
  requireGameAddress();
  requireTokenAddress();

  const entryFee = await publicClient.readContract({
    address: CONFIG.game,
    abi: GAME_ABI,
    functionName: "entryFee",
  });
  const inputFee = await publicClient.readContract({
    address: CONFIG.game,
    abi: GAME_ABI,
    functionName: "inputFee",
  });

  const encryptedPick = clampPick(pick);
  const client = await getInco();
  const ciphertext = await client.encrypt(BigInt(encryptedPick), {
    accountAddress: account,
    dappAddress: CONFIG.game,
    handleType: handleTypes.euint256,
  });

  const erc20 = getContract({
    address: CONFIG.token,
    abi: ERC20_ABI,
    client: { public: publicClient, wallet },
  });

  const allowance = await erc20.read.allowance([account, CONFIG.game]);
  if (allowance < entryFee) {
    const approveTx = await erc20.write.approve([CONFIG.game, entryFee], { account });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  const game = getContract({
    address: CONFIG.game,
    abi: GAME_ABI,
    client: { public: publicClient, wallet },
  });

  const tx = await game.write.enter([ciphertext], { account, value: inputFee });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  return tx;
}

export async function getCurrentRound() {
  requireGameAddress();
  const rid = await publicClient.readContract({
    address: CONFIG.game,
    abi: GAME_ABI,
    functionName: "roundId",
  });
  const [closesAt, settled, pot, playerCount] = await publicClient.readContract({
    address: CONFIG.game,
    abi: GAME_ABI,
    functionName: "getRound",
    args: [rid],
  });

  return {
    rid: Number(rid),
    closesAt: Number(closesAt),
    settled,
    pot,
    playerCount: Number(playerCount),
  };
}

export async function getGameMeta() {
  requireGameAddress();
  if (!gameMetaPromise) {
    gameMetaPromise = Promise.all([
      publicClient.readContract({ address: CONFIG.game, abi: GAME_ABI, functionName: "entryFee" }),
      publicClient.readContract({ address: CONFIG.game, abi: GAME_ABI, functionName: "rakeBps" }),
      publicClient.readContract({ address: CONFIG.game, abi: GAME_ABI, functionName: "roundDuration" }),
    ]).then(([entryFee, rakeBps, roundDuration]) => ({
      entryFee,
      rakeBps: Number(rakeBps),
      roundDuration: Number(roundDuration),
    }));
  }

  return gameMetaPromise;
}

export async function getRoundResult(rid) {
  const logs = await collectLogs("Settled", { rid, limit: 1 });
  if (!logs.length) return null;
  return hydrateSettledLog(logs[logs.length - 1]);
}

export async function getRecentResults(limit = 10) {
  const logs = await collectLogs("Settled", { limit });
  const recent = logs
    .sort((left, right) => {
      const leftBlock = left.blockNumber ?? 0n;
      const rightBlock = right.blockNumber ?? 0n;
      if (leftBlock === rightBlock) return Number((right.logIndex ?? 0) - (left.logIndex ?? 0));
      return leftBlock > rightBlock ? -1 : 1;
    })
    .slice(0, limit);

  return Promise.all(recent.map((log) => hydrateSettledLog(log)));
}
