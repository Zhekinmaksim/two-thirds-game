const MAX_PLAYERS = 50;
const RECENT_LIMIT = 16;
const $ = (id) => document.getElementById(id);
const ENV = import.meta.env ?? {};
const APP_CONFIG = {
  chainId: Number(ENV.VITE_CHAIN_ID ?? 8453),
  game: ENV.VITE_GAME_ADDRESS ?? "",
};

const usd = (value) => `$${(Number(value) / 1e6).toFixed(2)}`;
const shortAddr = (value) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const shortTx = (value) => `${value.slice(0, 4)}…${value.slice(-4)}`;
const formatRound = (rid) => `#${String(Number(rid)).padStart(3, "0")}`;
const explorerBase = APP_CONFIG.chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";

let integrationPromise = null;

let wallet = null;
let account = null;
let guess = 33;
let myRid = null;
let currentRound = null;
let refreshInFlight = false;
let gameMeta = null;
let shownResultRid = null;
let resolvedPersonalResult = null;
const myGuesses = new Map();

async function loadIntegration() {
  if (!integrationPromise) integrationPromise = import("./inco.js");
  return integrationPromise;
}

function formatUiError(error, fallback) {
  const raw = error?.shortMessage || error?.message || "";
  if (!raw) return fallback;

  const firstLine = raw.split("\n")[0].trim();
  if (firstLine.startsWith("Address ") || firstLine.includes("hex value of 20 bytes")) {
    return fallback;
  }
  if (firstLine.length > 180) return fallback;
  return `${fallback} ${firstLine}`;
}

function setGuess(value) {
  guess = Math.max(0, Math.min(100, Math.round(Number(value))));
  $("range").value = guess;
  $("range").style.background = `linear-gradient(90deg,var(--accent) 0%,var(--accent) ${guess}%,#241a0c ${guess}%)`;
  $("readout").textContent = guess;
}

function setContractInfo() {
  if (!APP_CONFIG.game) {
    $("contractShort").textContent = "unavailable";
    $("contractLink").removeAttribute("href");
    $("contractLink").classList.add("is-disabled");
    $("verifyOnchainLink").removeAttribute("href");
    $("verifyOnchainLink").classList.add("is-disabled");
    return;
  }

  $("contractShort").textContent = shortAddr(APP_CONFIG.game);
  $("contractLink").href = `${explorerBase}/address/${APP_CONFIG.game}`;
  $("contractLink").classList.remove("is-disabled");
  $("verifyOnchainLink").href = `${explorerBase}/address/${APP_CONFIG.game}`;
  $("verifyOnchainLink").classList.remove("is-disabled");
}

function buildCard({ mine = false, empty = false } = {}) {
  return `
    <div class="tt-cardcell${empty ? " is-empty" : ""}">
      <div class="tt-face">
        <span class="tt-num"></span>
        <span class="tt-sub"></span>
      </div>
      <div class="tt-cover">
        <div class="tt-sheen"></div>
        <span class="tt-cover-t">SCRATCH</span>
        <span class="tt-cover-d">◆</span>
      </div>
      ${mine ? '<div class="tt-youring"><span>YOU</span></div>' : ""}
    </div>
  `;
}

function renderBoard() {
  const count = Math.min(Number(currentRound?.playerCount ?? 0), MAX_PLAYERS);
  const mineSeat = myRid && currentRound && Number(myRid) === Number(currentRound.rid) && count > 0 ? count - 1 : -1;
  const cards = [];

  for (let i = 0; i < count; i += 1) {
    cards.push(buildCard({ mine: i === mineSeat }));
  }
  const board = $("board");
  board.classList.toggle("is-empty", count === 0);
  board.innerHTML = count
    ? cards.join("")
    : '<div class="tt-empty-field">Waiting for the first sealed entry in this round.</div>';
}

function renderStatus() {
  if (!currentRound) {
    $("sRound").textContent = "#--";
    $("sPot").textContent = "--";
    $("sPlayers").textContent = `0/${MAX_PLAYERS}`;
    $("sTimer").textContent = "--:--";
    $("boardHd").textContent = "▸ SEALED ENTRIES — VALUES HIDDEN UNTIL SETTLE";
    return;
  }

  const left = Math.max(0, currentRound.closesAt - Math.floor(Date.now() / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  const playerCount = Math.min(currentRound.playerCount, MAX_PLAYERS);

  $("sRound").textContent = formatRound(currentRound.rid);
  $("sPot").textContent = usd(currentRound.pot);
  $("sPlayers").textContent = `${playerCount}/${MAX_PLAYERS}`;
  $("sTimer").textContent = left > 0 ? `${mm}:${ss}` : "SETTLING";

  if (resolvedPersonalResult) {
    $("boardHd").textContent = "▸ ROUND RESOLVED — VIEW THE LAST REVEAL BELOW";
  } else if (myRid && Number(myRid) === Number(currentRound.rid)) {
    $("boardHd").textContent = "▸ SEALED ENTRIES — WAITING TO SETTLE";
  } else {
    $("boardHd").textContent = "▸ SEALED ENTRIES — VALUES HIDDEN UNTIL SETTLE";
  }
}

function renderMeta(meta) {
  gameMeta = meta;
  $("entryFee").textContent = usd(meta.entryFee);
  $("sealFee").textContent = `${usd(meta.entryFee)} USDC`;
  $("sealCost").textContent = usd(meta.entryFee);
}

function renderVerify(result) {
  if (!result?.txHash) {
    $("lastTx").textContent = "waiting for settle";
    $("lastTxLink").removeAttribute("href");
    $("lastTxLink").classList.add("is-disabled");
    if (APP_CONFIG.game) $("verifyOnchainLink").href = `${explorerBase}/address/${APP_CONFIG.game}`;
    return;
  }

  $("lastTx").textContent = shortTx(result.txHash);
  $("lastTxLink").href = `${explorerBase}/tx/${result.txHash}`;
  $("lastTxLink").classList.remove("is-disabled");
  $("verifyOnchainLink").href = `${explorerBase}/tx/${result.txHash}`;
}

function renderReveal(result) {
  if (!result) {
    $("reveal").hidden = true;
    $("reveal").innerHTML = "";
    return;
  }

  const guesses = result.guesses ?? [];
  const bins = new Array(20).fill(0);
  for (const value of guesses) {
    bins[Math.min(19, Math.floor(value / 5))] += 1;
  }

  const max = Math.max(1, ...bins);
  const targetBin = Math.min(19, Math.floor(Number(result.target) / 5));
  const myGuess = myGuesses.get(Number(result.rid));
  const myBin = typeof myGuess === "number" ? Math.min(19, Math.floor(myGuess / 5)) : -1;
  const hist = bins.map((count, index) => {
    const height = Math.max(8, (count / max) * 88);
    const cls = index === targetBin ? "tgt" : index === myBin ? "you" : "";
    return `<i class="${cls}" style="height:${height.toFixed(0)}%"></i>`;
  }).join("");

  const isPersonal = myRid && Number(myRid) === Number(result.rid);
  const youWon = isPersonal && account && (result.winnerAddresses ?? []).some((winner) => winner.toLowerCase() === account.toLowerCase());
  const youOff = typeof myGuess === "number" ? Math.abs(myGuess - Number(result.target)) : null;

  let verdict = `AUTO-PAID BY CONTRACT — ${usd(result.payPerWinner)}`;
  let verdictColor = "var(--green)";
  let verdictGlow = "rgba(69,230,69,.45)";
  let shareBig = `LAST PAYOUT ${usd(result.payPerWinner)}`;
  let shareClass = "tt-share-card";
  let shareButtonClass = "tt-btn share";
  let shareText = `Round ${formatRound(result.rid)} settled on TWO·THIRDS. Target ${result.target}, average ${result.avg}, payout ${usd(result.payPerWinner)} per winner.`;

  if (isPersonal && youWon) {
    verdict = `★ YOU WIN — ${usd(result.payPerWinner)}`;
    shareBig = `I WON ${usd(result.payPerWinner)}`;
    shareText = `I won ${usd(result.payPerWinner)} on TWO·THIRDS — guessed ${myGuess}, target was ${result.target}. Sealed on Inco and paid automatically by the contract.`;
  } else if (isPersonal && youOff !== null) {
    verdict = `YOU GUESSED ${myGuess} · OFF BY ${youOff}`;
    verdictColor = "var(--red)";
    verdictGlow = "rgba(255,59,92,.4)";
    shareBig = `OFF BY ${youOff}`;
    shareClass = "tt-share-card loss";
    shareButtonClass = "tt-btn share loss";
    shareText = `I guessed ${myGuess} on TWO·THIRDS — target landed on ${result.target}. Sealed on Inco and settled automatically by the contract.`;
  }

  $("reveal").hidden = false;
  $("reveal").innerHTML = `
    <div class="tt-reveal-hd tt-px">▸ DECRYPTED FIELD</div>
    <div class="tt-hist">${hist || '<i style="height:8%"></i>'}</div>
    <div class="tt-axis"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
    <div class="tt-target-wrap"><small>⅔ × AVG ${result.avg} = </small><div class="tt-target tt-px">${result.target}</div></div>
    <div class="tt-resline"><span class="k">AVERAGE</span> ${result.avg} &nbsp;|&nbsp; <span class="k">WINNERS</span> ${(result.winnerAddresses ?? []).length || result.winners}</div>
    <div class="tt-verdict tt-px" style="color:${verdictColor};text-shadow:0 0 10px ${verdictGlow}">${verdict}</div>
    <div class="tt-resline"><span class="k">NET POT</span> ${usd(result.netPot)} · <span class="k">PAY/WIN</span> <span class="pay">${usd(result.payPerWinner)}</span></div>
    <div class="${shareClass}">
      <span class="tt-share-dom">twothird.fun</span>
      <div class="tt-share-logo">TWO<span style="color:var(--red)">·</span>THIRDS</div>
      <div class="tt-share-big" style="color:${verdictColor};text-shadow:0 0 14px ${verdictGlow}">${shareBig}</div>
      <div class="tt-share-sub">target ${result.target} · avg ${result.avg} · round ${formatRound(result.rid)}</div>
      <div class="tt-share-seal">✓ sealed via confidential compute · auto-paid by contract</div>
    </div>
    <button class="${shareButtonClass}" id="btnShare" type="button">▸ SHARE TO 𝕏</button>
  `;

  $("btnShare").addEventListener("click", () => {
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent("https://x.com/twothirdsfun")}`;
    window.open(intent, "_blank", "noopener");
  });
}

function renderHistory(results) {
  const source = results.length
    ? results
    : [
        { target: 18 },
        { target: 24 },
        { target: 37 },
        { target: 31 },
        { target: 42 },
        { target: 50 },
      ];

  const spark = source.slice(0, 12).reverse().map((row, index, list) => {
    const height = 8 + (Number(row.target) / 100) * 42;
    const cls = index === list.length - 1 ? "last" : "";
    return `<i class="${cls}" style="height:${height.toFixed(0)}px"></i>`;
  }).join("");
  $("spark").innerHTML = spark;

  if (!results.length) {
    $("history").innerHTML = '<tr><td colspan="4" class="tt-empty">no rounds settled yet — play one ▸</td></tr>';
    return;
  }

  $("history").innerHTML = results.slice(0, 7).map((row) => {
    let winner = "auto-paid split";
    if ((row.winnerAddresses ?? []).length === 1) {
      winner = shortAddr(row.winnerAddresses[0]);
    } else if ((row.winnerAddresses ?? []).length > 1) {
      winner = `${row.winnerAddresses.length}-way split`;
    }

    return `<tr>
      <td>${formatRound(row.rid)}</td>
      <td class="num">${row.target}</td>
      <td class="num">${row.avg}</td>
      <td>${winner}</td>
    </tr>`;
  }).join("");
}

function renderSparkPlaceholder() {
  const placeholder = [18, 24, 37, 31, 42, 50];
  $("spark").innerHTML = placeholder.map((value, index, list) => {
    const height = 8 + (value / 100) * 42;
    const cls = index === list.length - 1 ? "last" : "";
    return `<i class="${cls}" style="height:${height.toFixed(0)}px"></i>`;
  }).join("");
}

function renderLeaderboard(results) {
  const winners = new Map();

  for (const row of results) {
    for (const winner of row.winnerAddresses ?? []) {
      const current = winners.get(winner) ?? { address: winner, wins: 0, net: 0n, lastPaid: 0n };
      current.wins += 1;
      current.net += BigInt(row.payPerWinner);
      current.lastPaid = BigInt(row.payPerWinner);
      winners.set(winner, current);
    }
  }

  const rows = [...winners.values()]
    .sort((a, b) => {
      if (a.net === b.net) return b.wins - a.wins;
      return a.net > b.net ? -1 : 1;
    })
    .slice(0, 8);

  if (!rows.length) {
    $("lb").innerHTML = '<tr><td colspan="5" class="tt-empty">leaderboard will appear after real settlements</td></tr>';
    $("youRank").textContent = "#—";
    $("youNet").textContent = "+$0.00";
    return;
  }

  let myRank = null;
  let myNet = null;

  $("lb").innerHTML = rows.map((row, index) => {
    const isMe = account && row.address.toLowerCase() === account.toLowerCase();
    if (isMe) {
      myRank = index + 1;
      myNet = row.net;
    }

    return `<tr class="${isMe ? "me" : ""}">
      <td>${index === 0 ? "★" : "▸"} #${index + 1}</td>
      <td style="color:${isMe ? "var(--cyan)" : "var(--accent)"}">${shortAddr(row.address)}</td>
      <td class="num">${row.wins}</td>
      <td class="num">${usd(row.lastPaid)}</td>
      <td class="num" style="color:var(--green)">${usd(row.net)}</td>
    </tr>`;
  }).join("");

  $("youRank").textContent = myRank ? `#${myRank}` : "#—";
  $("youNet").textContent = myNet !== null ? `+${usd(myNet)}` : "+$0.00";
}

function renderFeed(results) {
  if (!results.length) {
    $("feed").innerHTML = '<span>Waiting for the first settled round...</span><span>Waiting for the first settled round...</span>';
    return;
  }

  const items = results.slice(0, 8).map((row) => {
    if ((row.winnerAddresses ?? []).length === 1) {
      return `${shortAddr(row.winnerAddresses[0])} won ${usd(row.payPerWinner)} in ${formatRound(row.rid)}`;
    }
    if ((row.winnerAddresses ?? []).length > 1) {
      return `${row.winnerAddresses.length}-way split · ${usd(row.payPerWinner)} each · ${formatRound(row.rid)}`;
    }
    return `${formatRound(row.rid)} settled automatically`;
  });

  $("feed").innerHTML = items.concat(items).map((item) => `<span>${item}</span>`).join("");
}

function renderPhase() {
  const hasPendingMyRound = myRid && currentRound && Number(myRid) === Number(currentRound.rid);
  $("control").hidden = Boolean(hasPendingMyRound || resolvedPersonalResult);
  $("waiting").hidden = !hasPendingMyRound || Boolean(resolvedPersonalResult);
  $("after").hidden = !resolvedPersonalResult;
}

function updateActionCopy() {
  if (resolvedPersonalResult) {
    $("btnNext").textContent = "▸ VIEW LIVE ROUND";
    return;
  }

  if (!wallet) {
    $("btnSeal").disabled = false;
    $("btnSeal").textContent = "▸ CONNECT WALLET";
    return;
  }

  if (myRid && currentRound && Number(myRid) === Number(currentRound.rid)) {
    return;
  }

  if (currentRound && currentRound.playerCount >= MAX_PLAYERS) {
    $("btnSeal").disabled = true;
    $("btnSeal").textContent = "▸ ROUND FULL";
    return;
  }

  $("btnSeal").disabled = false;
  $("btnSeal").textContent = "▸ INSERT GUESS & SEAL";
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;

  try {
    const { getCurrentRound, getRecentResults, getRoundResult } = await loadIntegration();
    const round = await getCurrentRound();

    currentRound = round;
    renderBoard();
    renderStatus();
    renderPhase();
    updateActionCopy();

    let recent = [];
    try {
      recent = await getRecentResults(RECENT_LIMIT);
    } catch {
      recent = [];
    }

    renderHistory(recent);
    renderLeaderboard(recent);
    renderFeed(recent);

    const targetResultRid = myRid ?? recent[0]?.rid ?? null;
    let activeResult = null;

    if (targetResultRid) {
      try {
        activeResult = await getRoundResult(BigInt(targetResultRid));
      } catch {
        activeResult = null;
      }
    }

    if (activeResult) {
      shownResultRid = targetResultRid;
      renderVerify(activeResult);
      renderReveal(activeResult);

      if (myRid && Number(myRid) === Number(activeResult.rid) && Number(currentRound.rid) !== Number(myRid)) {
        resolvedPersonalResult = activeResult;
        myRid = null;
      }
    } else if (shownResultRid === null) {
      renderVerify(null);
      renderReveal(null);
    }

    $("walletHelp").textContent = wallet
      ? `Wallet connected: ${shortAddr(account)}. Your guess will be encrypted in-browser before submission.`
      : "Public data is visible without a wallet. Connect only when you want to seal a real onchain guess.";
  } catch (error) {
    $("walletHelp").textContent = formatUiError(
      error,
      "Live data is temporarily unavailable. Retrying automatically.",
    );
  } finally {
    refreshInFlight = false;
  }
}

$("verifyBtn").addEventListener("click", (event) => {
  const panel = $("verifyPanel");
  const open = panel.hidden;
  panel.hidden = !open;
  event.currentTarget.textContent = open ? "HIDE ↗" : "HOW IT WORKS ↗";
});

const onGuessInput = (event) => setGuess(event.target.value);
$("range").addEventListener("input", onGuessInput);
$("range").addEventListener("change", onGuessInput);
$("range").addEventListener("touchmove", onGuessInput, { passive: true });
$("range").addEventListener("pointermove", (event) => {
  if (event.buttons !== 1) return;
  setGuess(event.target.value);
});

$("control").addEventListener("click", (event) => {
  const chip = event.target.closest(".tt-chip");
  if (!chip) return;
  setGuess(chip.dataset.v);
});

$("btnSeal").addEventListener("click", async () => {
  try {
    if (!wallet) {
      const { connectWallet } = await loadIntegration();
      $("btnSeal").disabled = true;
      $("btnSeal").textContent = "▸ CONNECTING...";
      ({ wallet, account } = await connectWallet());
      $("walletHelp").textContent = `Wallet connected: ${shortAddr(account)}. Your guess will be encrypted in-browser before submission.`;
      updateActionCopy();
    }

    if (myRid && currentRound && Number(myRid) === Number(currentRound.rid)) return;

    $("btnSeal").disabled = true;
    $("btnSeal").textContent = "▸ SEALING...";
    const { getCurrentRound, playRound } = await loadIntegration();
    const { rid } = await getCurrentRound();
    await playRound(wallet, account, guess);
    myRid = Number(rid);
    myGuesses.set(Number(rid), guess);
    resolvedPersonalResult = null;
    $("walletHelp").textContent = "Guess sealed successfully. Nobody can read the plaintext value until settlement.";
    await refresh();
  } catch (error) {
    $("walletHelp").textContent = `Action failed: ${error.shortMessage || error.message}`;
    updateActionCopy();
  }
});

$("btnNext").addEventListener("click", () => {
  resolvedPersonalResult = null;
  renderPhase();
  updateActionCopy();
});

async function init() {
  setContractInfo();
  setGuess(33);
  renderBoard();
  renderSparkPlaceholder();
  renderStatus();
  renderPhase();
  updateActionCopy();

  try {
    const { getGameMeta } = await loadIntegration();
    renderMeta(await getGameMeta());
  } catch {
    $("entryFee").textContent = "$1.00";
    $("sealFee").textContent = "$1.00 USDC";
    $("sealCost").textContent = "$1.00";
  }

  renderVerify(null);
  await refresh();
  setInterval(() => {
    renderStatus();
    updateActionCopy();
  }, 1000);
  setInterval(refresh, 5000);
}

init();
