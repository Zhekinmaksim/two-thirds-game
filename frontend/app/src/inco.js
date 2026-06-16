// inco.js - browser-side integration for the TwoThirds game.
//
// Safety model:
//  - private key never touched; the wallet signs everything.
//  - account requested only on user action; chain checked/switched before any tx.
//  - the guess is encrypted IN THE BROWSER (Inco SDK); plaintext never leaves the page.
//  - exact entry fee approved, never unlimited.

import {
  createWalletClient, createPublicClient, custom, http,
  decodeFunctionData, defineChain, getAddress, getContract, parseAbi,
} from "viem";
import * as IncoLite from "@inco/js/lite";
import { handleTypes } from "@inco/js";

// ---------------------------------------------------------------- CONFIG
function requireEnv(name, fallback = "") {
  const value = import.meta.env[name] ?? fallback;
  if (value === "") throw new Error(`Missing required env ${name}`);
  return value;
}

export const CONFIG = {
  pepper: requireEnv("VITE_INCO_PEPPER", "testnet"),
  chainId: Number(requireEnv("VITE_CHAIN_ID")),
  chainName: requireEnv("VITE_CHAIN_NAME"),
  rpcUrl: requireEnv("VITE_RPC_URL"),
  game: getAddress(requireEnv("VITE_GAME_ADDRESS")),
  token: getAddress(requireEnv("VITE_TOKEN_ADDRESS")),
};

const GAME_ABI = parseAbi([
  "function enter(bytes ciphertext)",
  "function roundId() view returns (uint256)",
  "function entryFee() view returns (uint256)",
  "function rakeBps() view returns (uint16)",
  "function roundDuration() view returns (uint64)",
  "function getRound(uint256 rid) view returns (uint64 closesAt, bool settled, uint256 pot, uint256 playerCount)",
  "function getPlayers(uint256 rid) view returns (address[])",
  "function settle(uint256[] values, bytes[][] signatures)",
  "event Settled(uint256 indexed rid, uint16 target, uint16 avgX1, uint256 netPot, uint256 payPerWinner, uint256 winners)",
]);
const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const chain = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
});

export const publicClient = createPublicClient({ chain, transport: http(CONFIG.rpcUrl) });

let _inco = null;
const resultCache = new Map();

async function getInco() {
  if (_inco) return _inco;
  _inco = await IncoLite.Lightning.latest(CONFIG.pepper, CONFIG.chainId);
  return _inco;
}

function clampGuess(value) {
  const num = Number(value);
  return Math.max(0, Math.min(100, Math.round(num)));
}

async function hydrateSettledLog(log) {
  const cacheKey = `${log.transactionHash}:${log.args.rid}`;
  if (resultCache.has(cacheKey)) return resultCache.get(cacheKey);

  const base = {
    rid: Number(log.args.rid),
    target: Number(log.args.target),
    avg: Number(log.args.avgX1),
    netPot: log.args.netPot,
    payPerWinner: log.args.payPerWinner,
    winners: Number(log.args.winners),
    winnerAddresses: [],
    guesses: [],
    txHash: log.transactionHash,
  };

  try {
    const [tx, players] = await Promise.all([
      publicClient.getTransaction({ hash: log.transactionHash }),
      publicClient.readContract({
        address: CONFIG.game,
        abi: GAME_ABI,
        functionName: "getPlayers",
        args: [log.args.rid],
      }),
    ]);

    const decoded = decodeFunctionData({ abi: GAME_ABI, data: tx.input });
    if (decoded.functionName === "settle") {
      const [values] = decoded.args;
      const guesses = values.map(clampGuess);
      base.guesses = guesses;
      const target = Number(log.args.target);
      let minDistance = Number.POSITIVE_INFINITY;

      for (const guess of guesses) {
        const distance = Math.abs(guess - target);
        if (distance < minDistance) minDistance = distance;
      }

      base.winnerAddresses = players.filter((_, index) =>
        Math.abs((guesses[index] ?? 0) - target) === minDistance);
    }
  } catch {
    // keep base result if calldata or players are unavailable
  }

  resultCache.set(cacheKey, base);
  return base;
}

function getInjectedProvider() {
  const { ethereum } = window;
  if (!ethereum) return null;

  const providers = Array.isArray(ethereum.providers) && ethereum.providers.length
    ? ethereum.providers
    : [ethereum];

  const preferred =
    providers.find((provider) => provider?.isMetaMask) ||
    providers.find((provider) => provider?.isRabby) ||
    providers.find((provider) => provider?.isCoinbaseWallet) ||
    providers.find((provider) => typeof provider?.request === "function");

  return preferred ?? null;
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

// ---------------------------------------------------------------- connect
export async function connectWallet() {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("No wallet found. Install MetaMask or similar.");

  try {
    await ensureChain(provider);
  } catch (error) {
    // Some wallets require account authorization before chain operations.
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
  const [account] = accounts;
  return { wallet, account };
}

// ---------------------------------------------------------------- play
/** Encrypt a guess (0..100) locally and join the current round. */
export async function playRound(wallet, account, guess) {
  const g = Math.max(0, Math.min(100, Math.round(Number(guess))));
  const entryFee = await publicClient.readContract({
    address: CONFIG.game,
    abi: GAME_ABI,
    functionName: "entryFee",
  });

  const inco = await getInco();
  const ciphertext = await inco.encrypt(BigInt(g), {
    accountAddress: account,
    dappAddress: CONFIG.game,
    handleType: handleTypes.euint256, // 8
  });

  // approve EXACT entry fee if needed
  const erc20 = getContract({ address: CONFIG.token, abi: ERC20_ABI, client: { public: publicClient, wallet } });
  const allowance = await erc20.read.allowance([account, CONFIG.game]);
  if (allowance < entryFee) {
    const aTx = await erc20.write.approve([CONFIG.game, entryFee], { account });
    await publicClient.waitForTransactionReceipt({ hash: aTx });
  }

  const game = getContract({ address: CONFIG.game, abi: GAME_ABI, client: { public: publicClient, wallet } });
  const tx = await game.write.enter([ciphertext], { account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  return tx;
}

// ---------------------------------------------------------------- reads
export async function getCurrentRound() {
  const rid = await publicClient.readContract({ address: CONFIG.game, abi: GAME_ABI, functionName: "roundId" });
  const [closesAt, settled, pot, playerCount] =
    await publicClient.readContract({ address: CONFIG.game, abi: GAME_ABI, functionName: "getRound", args: [rid] });
  return { rid, closesAt: Number(closesAt), settled, pot, playerCount: Number(playerCount) };
}

export async function getGameMeta() {
  const [entryFee, rakeBps, roundDuration] = await Promise.all([
    publicClient.readContract({ address: CONFIG.game, abi: GAME_ABI, functionName: "entryFee" }),
    publicClient.readContract({ address: CONFIG.game, abi: GAME_ABI, functionName: "rakeBps" }),
    publicClient.readContract({ address: CONFIG.game, abi: GAME_ABI, functionName: "roundDuration" }),
  ]);

  return {
    entryFee,
    rakeBps: Number(rakeBps),
    roundDuration: Number(roundDuration),
  };
}

/** Result of a settled round, read from the Settled event (null if not settled yet). */
export async function getRoundResult(rid) {
  const logs = await publicClient.getContractEvents({
    address: CONFIG.game, abi: GAME_ABI, eventName: "Settled",
    args: { rid }, fromBlock: "earliest", toBlock: "latest",
  });
  if (!logs.length) return null;
  return hydrateSettledLog(logs[logs.length - 1]);
}

/** Recent settled rounds, newest first, for the history/hi-scores panel. */
export async function getRecentResults(limit = 10) {
  const logs = await publicClient.getContractEvents({
    address: CONFIG.game, abi: GAME_ABI, eventName: "Settled",
    fromBlock: "earliest", toBlock: "latest",
  });
  const recent = logs.slice(-limit).reverse();
  return Promise.all(recent.map((log) => hydrateSettledLog(log)));
}
