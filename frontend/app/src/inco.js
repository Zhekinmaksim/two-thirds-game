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
import { createBaseAccountSDK } from "@base-org/account";

const DEFAULTS = {
  pepper: "mainnet",
  chainId: 8453,
  chainName: "Base",
  game: "0x4163b226f978E071FD45bc913bf9EbC8ed2d5860",
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
  game: normalizeAddress(readEnv("VITE_GAME_ADDRESS", DEFAULTS.game), DEFAULTS.game),
  token: normalizeAddress(readEnv("VITE_TOKEN_ADDRESS", DEFAULTS.token), DEFAULTS.token),
};

const RPC_FALLBACKS = {
  8453: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
  ],
};

const rpcUrls = [...new Set(RPC_FALLBACKS[CONFIG.chainId] ?? [])];
const LOG_BLOCK_SPAN = 5_000n;
const MAX_LOG_LOOKBACK_BLOCKS = 100_000n;
const resultCache = new Map();
let latestSettledBlock = null;
let allSettledLogsCache = [];
let allSettledResultsCache = [];
let allSettledScannedToBlock = null;
let inco = null;
let gameMetaPromise = null;
let baseAccountProvider = undefined;
let eip6963Started = false;
const eip6963Providers = new Map();

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
  "event RoundRefunded(uint256 indexed rid, address indexed player, uint256 amount, uint256 carriedPot)",
  "event RolledOver(uint256 indexed rid, uint256 carriedPot, uint256 players)",
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
  const matches = [];
  const ridArg = rid === undefined || rid === null ? undefined : toBigInt(rid);
  const args = ridArg === undefined ? undefined : { rid: ridArg };
  const hardMinBlock = latestBlock > MAX_LOG_LOOKBACK_BLOCKS ? latestBlock - MAX_LOG_LOOKBACK_BLOCKS : 0n;
  const recentMinBlock = latestSettledBlock === null
    ? hardMinBlock
    : (latestSettledBlock > LOG_BLOCK_SPAN ? latestSettledBlock - LOG_BLOCK_SPAN : 0n);
  const minBlock = ridArg === undefined
    ? (recentMinBlock > hardMinBlock ? recentMinBlock : hardMinBlock)
    : hardMinBlock;

  let toBlock = latestBlock;
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

function sortLogsNewestFirst(logs) {
  return [...logs].sort((left, right) => {
    const leftBlock = left.blockNumber ?? 0n;
    const rightBlock = right.blockNumber ?? 0n;
    if (leftBlock === rightBlock) return Number((right.logIndex ?? 0) - (left.logIndex ?? 0));
    return leftBlock > rightBlock ? -1 : 1;
  });
}

async function collectAllSettledLogs() {
  requireGameAddress();

  const latestBlock = await publicClient.getBlockNumber();
  const fromStart = allSettledScannedToBlock === null ? 0n : allSettledScannedToBlock + 1n;

  if (fromStart > latestBlock) return allSettledLogsCache;

  let fromBlock = fromStart;
  while (fromBlock <= latestBlock) {
    const toBlock = fromBlock + LOG_BLOCK_SPAN > latestBlock
      ? latestBlock
      : fromBlock + LOG_BLOCK_SPAN;
    const logs = await publicClient.getContractEvents({
      address: CONFIG.game,
      abi: GAME_ABI,
      eventName: "Settled",
      fromBlock,
      toBlock,
    });

    if (logs.length) {
      allSettledLogsCache.push(...logs);
      for (const log of logs) {
        if (typeof log.blockNumber === "bigint") {
          latestSettledBlock = latestSettledBlock === null || log.blockNumber > latestSettledBlock
            ? log.blockNumber
            : latestSettledBlock;
        }
      }
    }

    fromBlock = toBlock + 1n;
  }

  allSettledScannedToBlock = latestBlock;
  allSettledLogsCache = sortLogsNewestFirst(allSettledLogsCache);
  return allSettledLogsCache;
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
    kind: "settled",
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

async function hydrateRolledOverLog(log) {
  const cacheKey = `${log.transactionHash}:rollover:${log.args.rid}`;
  if (resultCache.has(cacheKey)) return resultCache.get(cacheKey);

  const base = {
    kind: "rolledOver",
    rid: Number(log.args.rid),
    carriedPot: log.args.carriedPot,
    grossPot: log.args.carriedPot,
    netPot: log.args.carriedPot,
    rake: 0n,
    payPerWinner: 0n,
    winners: 0,
    playersCount: Number(log.args.players),
    winnerAddresses: [],
    guesses: [],
    players: [],
    target: 0,
    avg: 0,
    txHash: log.transactionHash,
  };

  try {
    base.players = await getPlayersForRound(log.args.rid);
  } catch {
    // keep partial data if player lookup is unavailable
  }

  resultCache.set(cacheKey, base);
  return base;
}

async function hydrateRefundedLog(log) {
  const cacheKey = `${log.transactionHash}:refund:${log.args.rid}`;
  if (resultCache.has(cacheKey)) return resultCache.get(cacheKey);

  const base = {
    kind: "refunded",
    rid: Number(log.args.rid),
    player: log.args.player,
    refundAmount: log.args.amount,
    carriedPot: log.args.carriedPot,
    grossPot: log.args.amount,
    netPot: log.args.amount,
    rake: 0n,
    payPerWinner: 0n,
    winners: 0,
    playersCount: 1,
    winnerAddresses: [],
    guesses: [],
    players: [log.args.player],
    target: 0,
    avg: 0,
    txHash: log.transactionHash,
  };

  resultCache.set(cacheKey, base);
  return base;
}

function providerRank(provider) {
  if (provider?.__ttBaseAccount) return isProbablyBaseApp() ? -1 : 4;
  if (provider?.isRabby) return 0;
  if (provider?.isMetaMask) return 1;
  if (provider?.isCoinbaseWallet) return 2;
  if (provider?.isPhantom) return 3;
  return 9;
}

function isProbablyBaseApp() {
  if (typeof window === "undefined") return false;

  const ua = window.navigator?.userAgent ?? "";
  const referrer = window.document?.referrer ?? "";
  return /base\.app/i.test(referrer)
    || /\bBaseApp\b/i.test(ua)
    || /\bBase\/[\d.]+\b/i.test(ua)
    || /\bCoinbaseWallet\b/i.test(ua);
}

function startEip6963Discovery() {
  if (eip6963Started || typeof window === "undefined") return;
  eip6963Started = true;

  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = event?.detail;
    const provider = detail?.provider;
    if (!provider || typeof provider.request !== "function") return;
    eip6963Providers.set(provider, detail?.info ?? null);
  });

  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function getBaseAccountProvider() {
  if (baseAccountProvider !== undefined) return baseAccountProvider;
  baseAccountProvider = null;

  if (typeof window === "undefined") return baseAccountProvider;

  try {
    const sdk = createBaseAccountSDK({
      appName: "TWO·THIRDS",
      appLogoUrl: `${window.location.origin}/favicon.png`,
      appChainIds: [CONFIG.chainId],
      preference: {
        attribution: { auto: true },
      },
    });

    const provider = sdk.getProvider();
    if (provider && typeof provider.request === "function") {
      provider.__ttBaseAccount = true;
      baseAccountProvider = provider;
    }
  } catch {
    baseAccountProvider = null;
  }

  return baseAccountProvider;
}

function getInjectedProviders() {
  startEip6963Discovery();

  const candidates = [];
  const baseProvider = getBaseAccountProvider();
  if (baseProvider) candidates.push(baseProvider);
  if (window.rabby?.ethereum) candidates.push(window.rabby.ethereum);
  if (eip6963Providers.size) candidates.push(...eip6963Providers.keys());
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

function getErrorMessage(error, fallback) {
  return error?.shortMessage || error?.cause?.shortMessage || error?.message || error?.cause?.message || fallback;
}

async function getChainId(provider) {
  const chainIdHex = await provider.request({ method: "eth_chainId" });
  return Number.parseInt(chainIdHex, 16);
}

async function ensureChain(provider) {
  if (provider?.__ttBaseAccount) return;

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
    if (code !== 4902 && code !== -32603 && code !== -32601) throw error;
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [{
      chainId: `0x${CONFIG.chainId.toString(16)}`,
      chainName: CONFIG.chainName,
      rpcUrls,
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
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!accounts?.length) throw new Error("Wallet returned no accounts.");

      await ensureChain(provider);

      const wallet = createWalletClient({ chain, transport: custom(provider) });
      return { wallet, account: getAddress(accounts[0]) };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Wallet connection failed.");
}

export async function resumeWalletConnection({ ensureCorrectChain = false } = {}) {
  const providers = getInjectedProviders();
  if (!providers.length) return null;

  for (const provider of providers) {
    try {
      const accounts = await provider.request({ method: "eth_accounts" });
      if (!accounts?.length) continue;

      if (ensureCorrectChain) await ensureChain(provider);

      const wallet = createWalletClient({ chain, transport: custom(provider) });
      return { wallet, account: getAddress(accounts[0]) };
    } catch {
      // ignore provider and continue to the next injected wallet
    }
  }

  return null;
}

export async function playRound(wallet, account, pick) {
  requireGameAddress();
  requireTokenAddress();

  let entryFee;
  let inputFee;
  try {
    [entryFee, inputFee] = await Promise.all([
      publicClient.readContract({
        address: CONFIG.game,
        abi: GAME_ABI,
        functionName: "entryFee",
      }),
      publicClient.readContract({
        address: CONFIG.game,
        abi: GAME_ABI,
        functionName: "inputFee",
      }),
    ]);
  } catch (error) {
    throw new Error(`Could not read round fees. ${getErrorMessage(error, "RPC read failed.")}`, { cause: error });
  }

  const encryptedPick = clampPick(pick);
  let ciphertext;
  try {
    const client = await getInco();
    ciphertext = await client.encrypt(BigInt(encryptedPick), {
      accountAddress: account,
      dappAddress: CONFIG.game,
      handleType: handleTypes.euint256,
    });
  } catch (error) {
    throw new Error(`Encryption failed. ${getErrorMessage(error, "Inco could not seal this pick.")}`, { cause: error });
  }

  const erc20 = getContract({
    address: CONFIG.token,
    abi: ERC20_ABI,
    client: { public: publicClient, wallet },
  });

  let allowance;
  try {
    allowance = await erc20.read.allowance([account, CONFIG.game]);
  } catch (error) {
    throw new Error(`Allowance check failed. ${getErrorMessage(error, "Could not read USDC allowance.")}`, { cause: error });
  }

  if (allowance < entryFee) {
    try {
      const approveTx = await erc20.write.approve([CONFIG.game, entryFee], { account });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    } catch (error) {
      throw new Error(`USDC approval failed. ${getErrorMessage(error, "Wallet approval was rejected or malformed.")}`, { cause: error });
    }
  }

  const game = getContract({
    address: CONFIG.game,
    abi: GAME_ABI,
    client: { public: publicClient, wallet },
  });

  try {
    const tx = await game.write.enter([ciphertext], { account, value: inputFee });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    return tx;
  } catch (error) {
    throw new Error(`Entry transaction failed. ${getErrorMessage(error, "The encrypted entry transaction did not complete.")}`, { cause: error });
  }
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
  const settledLogs = await collectLogs("Settled", { rid, limit: 1 });
  if (settledLogs.length) return hydrateSettledLog(settledLogs[settledLogs.length - 1]);

  const refundedLogs = await collectLogs("RoundRefunded", { rid, limit: 1 });
  if (refundedLogs.length) return hydrateRefundedLog(refundedLogs[refundedLogs.length - 1]);

  const rolledLogs = await collectLogs("RolledOver", { rid, limit: 1 });
  if (rolledLogs.length) return hydrateRolledOverLog(rolledLogs[rolledLogs.length - 1]);

  return null;
}

export async function getRecentResults(limit = 10) {
  const logs = await collectLogs("Settled", { limit });
  const recent = sortLogsNewestFirst(logs).slice(0, limit);

  return Promise.all(recent.map((log) => hydrateSettledLog(log)));
}

export async function getAllTimeResults() {
  const previousCount = allSettledLogsCache.length;
  const logs = await collectAllSettledLogs();
  if (allSettledResultsCache.length && logs.length === previousCount) return allSettledResultsCache;

  allSettledResultsCache = await Promise.all(logs.map((log) => hydrateSettledLog(log)));
  return allSettledResultsCache;
}
