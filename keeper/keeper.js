// keeper.js - auto-settles TwoThirds rounds so the game runs "like clockwork".
//
// Every TICK seconds it checks the current round. Once the round has closed it
// asks Inco for an attested decryption of every guess and submits settle(). Even
// an empty/under-min round is settled, which rolls it over and starts a fresh one,
// so there is always a live round.
//
// Run:  cp .env.example .env && edit, then  `node keeper.js`
//
// The settler key here must match the SETTLER_ADDRESS the contract was deployed
// with. The contract opens decryption for that address only after the round closes.

import "dotenv/config";
import nodeHttp from "node:http";
import { createRequire } from "node:module";
import {
  createPublicClient, createWalletClient, fallback, http, defineChain,
  parseAbi, getContract, bytesToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const require = createRequire(import.meta.url);
const { Lightning } = require("@inco/js/lite");

const {
  RPC_URL, SETTLER_PRIVATE_KEY, GAME_ADDRESS,
  CHAIN_ID, INCO_PEPPER = "mainnet", TICK_SECONDS = "30", PORT = "",
} = process.env;

if (!RPC_URL || !SETTLER_PRIVATE_KEY || !GAME_ADDRESS || !CHAIN_ID) {
  console.error("Missing env. See .env.example"); process.exit(1);
}

const RPC_FALLBACKS = {
  8453: [
    "https://rpc.ankr.com/base/1dfb41f645be2ab63ae3eb7463c41f98995438f00e44a579a0abee13b61cf83a",
  ],
};

const rpcUrls = [...new Set([RPC_URL, ...(RPC_FALLBACKS[Number(CHAIN_ID)] ?? [])])];

const chain = defineChain({
  id: Number(CHAIN_ID),
  name: "host",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } },
});

const account = privateKeyToAccount(SETTLER_PRIVATE_KEY);
const transport = fallback(rpcUrls.map((url) => http(url, { retryCount: 1, timeout: 8_000 })));
const publicClient = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

const ABI = parseAbi([
  "function roundId() view returns (uint256)",
  "function getRound(uint256 rid) view returns (uint64 closesAt, bool settled, uint256 pot, uint256 playerCount)",
  "function authorizeSettlerDecryption(uint256 rid)",
  "function guessHandles(uint256 rid) view returns (bytes32[])",
  "function settle(uint256[] values, bytes[][] signatures)",
]);
const game = getContract({ address: GAME_ADDRESS, abi: ABI, client: { public: publicClient, wallet } });
const state = {
  lastRoundId: null,
  lastPlayerCount: null,
  lastTickAt: null,
  status: "booting",
  lastError: null,
};

let inco;
async function getInco() {
  if (inco) return inco;
  inco = await Lightning.latest(INCO_PEPPER, Number(CHAIN_ID), {
    hostChainRpcUrls: rpcUrls,
  });
  return inco;
}

function plaintextToBig(p) {
  if (typeof p === "bigint") return p;
  if (typeof p === "number") return BigInt(p);
  if (p && p.value !== undefined) return BigInt(p.value);
  return BigInt(p);
}

async function tick() {
  state.lastTickAt = new Date().toISOString();
  try {
    const rid = await game.read.roundId();
    const [closesAt, settled, , playerCount] = await game.read.getRound([rid]);
    const now = Math.floor(Date.now() / 1000);
    state.lastRoundId = rid.toString();
    state.lastPlayerCount = Number(playerCount);

    if (settled || now < Number(closesAt)) {
      const left = Number(closesAt) - now;
      state.status = settled ? "settled" : "waiting";
      state.lastError = null;
      console.log(`round #${rid} | players ${playerCount} | ${settled ? "settled" : left + "s left"}`);
      return;
    }

    state.status = "settling";
    state.lastError = null;
    console.log(`round #${rid} closed with ${playerCount} players -> settling...`);

    // empty / under-min rounds still settle (contract rolls them over)
    let values = [];
    let signatures = [];
    if (Number(playerCount) > 0) {
      const authTx = await game.write.authorizeSettlerDecryption([rid], { account });
      await publicClient.waitForTransactionReceipt({ hash: authTx });
      const handles = await game.read.guessHandles([rid]);
      const inc = await getInco();
      const attestations = await inc.attestedDecrypt(wallet, handles);
      values = attestations.map(a => plaintextToBig(a.plaintext));
      signatures = attestations.map(a => a.covalidatorSignatures.map(bytesToHex));
    }

    const tx = await game.write.settle([values, signatures], { account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    state.status = "settled";
    console.log(`  settled round #${rid} in ${tx}`);
  } catch (e) {
    const msg = (e?.shortMessage || e?.message || String(e));
    state.lastError = msg;
    if (msg.includes("settled") || msg.includes("round open")) {
      state.status = "skipped";
      console.log("  skip:", msg);           // race with another settler, or not closed yet
    } else {
      state.status = "error";
      console.error("  keeper error:", msg);  // keep running; retry next tick
    }
  }
}

if (PORT) {
  nodeHttp.createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }

    res.writeHead(state.status === "error" ? 500 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: state.status !== "error",
      status: state.status,
      settler: account.address,
      game: GAME_ADDRESS,
      tickSeconds: Number(TICK_SECONDS),
      ...state,
    }));
  }).listen(Number(PORT), "0.0.0.0", () => {
    console.log(`health endpoint on :${PORT}/healthz`);
  });
}

console.log(`keeper up. settler=${account.address} game=${GAME_ADDRESS} every ${TICK_SECONDS}s`);
tick();
setInterval(tick, Number(TICK_SECONDS) * 1000);
