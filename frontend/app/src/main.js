import {
  CONFIG,
  connectWallet,
  getCurrentRound,
  getGameMeta,
  getRecentResults,
  getRoundResult,
  playRound,
} from "./inco.js";

const $ = (id) => document.getElementById(id);
const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);
const shortAddr = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

let wallet = null;
let account = null;
let guess = 33;
let myRid = null;
let lastShownResult = null;
let currentRound = null;
let refreshInFlight = false;
let gameMeta = null;

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours && minutes) return `${hours}h ${minutes}m rounds`;
  if (hours) return `${hours}h rounds`;
  if (minutes) return `${minutes}m rounds`;
  return `${seconds}s rounds`;
}

function setGuess(value) {
  guess = Math.max(0, Math.min(100, Math.round(Number(value))));
  $("range").value = guess;
  $("range").style.setProperty("--p", `${guess}%`);
  $("readout").textContent = guess;
}

function buildSeatGrid() {
  const grid = $("seat-grid");
  grid.innerHTML = "";

  for (let i = 0; i < 100; i += 1) {
    const seat = document.createElement("div");
    seat.className = "seat";
    seat.id = `seat-${i}`;
    grid.appendChild(seat);
  }
}

function renderSeatGrid(count) {
  $("seat-count").textContent = `${count} / 100 FILLED`;

  for (let i = 0; i < 100; i += 1) {
    const seat = $(`seat-${i}`);
    if (!seat) continue;

    const filled = i < count;
    const mine = filled && myRid === currentRound?.rid && i === count - 1;
    seat.classList.toggle("filled", filled);
    seat.classList.toggle("mine", mine);
    seat.textContent = filled && !mine ? String(i + 1).padStart(2, "0") : "";
  }
}

function renderGameMeta(meta) {
  gameMeta = meta;
  $("meta-entry").textContent = `${usd(meta.entryFee)} USDC`;
  $("seal-cost").textContent = `${usd(meta.entryFee)} USDC`;
  $("meta-rake").textContent = `${(meta.rakeBps / 100).toFixed(2)}%`;
  $("meta-duration").textContent = formatDuration(meta.roundDuration);
  $("network-pill").textContent = CONFIG.chainName;
  $("network-chain").textContent = `LIVE ON ${CONFIG.chainName.toUpperCase()}`;
}

function renderHistoryCount(rid) {
  const passed = Math.max(0, Number(rid) - 1);
  $("history-count").textContent = `${passed} ROUNDS PASSED`;
}

function renderRound(round) {
  currentRound = round;
  $("s-round").textContent = `#${round.rid}`;
  $("s-pot").textContent = usd(round.pot);
  $("s-players").textContent = `${round.playerCount} / 100`;
  renderHistoryCount(round.rid);
  renderSeatGrid(round.playerCount);
  renderTimer();
}

function renderTimer() {
  if (!currentRound) return;

  const left = Math.max(0, currentRound.closesAt - Math.floor(Date.now() / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  $("s-timer").textContent = left > 0 ? `${mm}:${ss}` : "SETTLING";

  if (wallet && left > 0 && currentRound.playerCount < 100 && myRid !== currentRound.rid) {
    $("btn-seal").disabled = false;
    $("btn-seal").textContent = "▸ INSERT GUESS & SEAL";
  }
}

function showResult(result) {
  $("r-target").textContent = result.target;
  $("r-avg").textContent = result.avg;
  $("r-pot").textContent = usd(result.netPot);
  $("r-pay").textContent = usd(result.payPerWinner);
  $("result-target-big").textContent = result.target;
  $("r-verdict").textContent = result.winners > 1 ? `${result.winners}-WAY SPLIT` : "SINGLE WINNER";
  $("result-badge").textContent = result.winners > 1 ? "AUTO-SPLIT" : "AUTO-PAYOUT";

  const winnersLabel = result.winnerAddresses?.length
    ? `Winner${result.winnerAddresses.length > 1 ? "s" : ""}: ${result.winnerAddresses.map(shortAddr).join(" · ")}`
    : `${result.winners} wallet${result.winners > 1 ? "s" : ""} paid automatically on settlement`;
  $("r-winners").textContent = winnersLabel;

  if (myRid === result.rid) {
    $("play-status").textContent = "Your sealed entry has settled. Payout is sent by the contract automatically if you won.";
    myRid = null;
  }
}

function renderHistory(rows) {
  const table = $("history");
  if (!rows.length) {
    table.innerHTML = '<tr><td colspan="4" class="muted">No settled rounds yet.</td></tr>';
    return;
  }

  table.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const winners = row.winnerAddresses?.length
      ? row.winnerAddresses.map(shortAddr).join(" · ")
      : `${row.winners}-way split`;
    tr.innerHTML = `<td>#${row.rid}</td><td class="num">${row.target}</td><td>${winners}</td><td class="num">${usd(row.payPerWinner)}</td>`;
    table.appendChild(tr);
  }
}

function renderLeaderboard(rows) {
  const table = $("leaderboard");
  const byWinner = new Map();

  for (const row of rows) {
    for (const winner of row.winnerAddresses ?? []) {
      const current = byWinner.get(winner) ?? { address: winner, wins: 0, totalPaid: 0n };
      current.wins += 1;
      current.totalPaid += BigInt(row.payPerWinner);
      byWinner.set(winner, current);
    }
  }

  const leaderboard = [...byWinner.values()]
    .sort((a, b) => {
      if (a.totalPaid === b.totalPaid) return b.wins - a.wins;
      return a.totalPaid > b.totalPaid ? -1 : 1;
    })
    .slice(0, 8);

  if (!leaderboard.length) {
    table.innerHTML = '<tr><td colspan="4" class="muted">Leaderboard will appear after real settled rounds.</td></tr>';
    return;
  }

  table.innerHTML = "";
  for (const [index, row] of leaderboard.entries()) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="place">#${index + 1}</td><td class="addr">${shortAddr(row.address)}</td><td class="num win">${row.wins}</td><td class="num win">${usd(row.totalPaid)}</td>`;
    table.appendChild(tr);
  }
}

function renderFeed(rows) {
  const feed = $("feed-track");
  if (!rows.length) {
    feed.innerHTML = '<span class="ticker-item">Waiting for the first settled round...</span><span class="ticker-item">Waiting for the first settled round...</span>';
    return;
  }

  const items = rows.slice(0, 8).map((row) => {
    if (row.winnerAddresses?.length === 1) {
      return `${shortAddr(row.winnerAddresses[0])} won ${usd(row.payPerWinner)} in round #${row.rid}`;
    }
    if (row.winnerAddresses?.length > 1) {
      return `${row.winnerAddresses.length}-way split · ${usd(row.payPerWinner)} each · round #${row.rid}`;
    }
    return `Round #${row.rid} settled for ${usd(row.payPerWinner)} per winner`;
  });

  const doubled = items.concat(items);
  feed.innerHTML = doubled.map((item) => `<span class="ticker-item">${item}</span>`).join("");
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;

  try {
    const [round, recent] = await Promise.all([
      getCurrentRound(),
      getRecentResults(12),
    ]);

    renderRound(round);
    renderHistory(recent);
    renderLeaderboard(recent);
    renderFeed(recent);

    const targetRid = myRid ?? (recent[0]?.rid ?? (round.rid > 1 ? round.rid - 1 : null));
    if (targetRid && targetRid !== lastShownResult) {
      const result = await getRoundResult(BigInt(targetRid));
      if (result) {
        showResult(result);
        lastShownResult = targetRid;
      }
    }
  } catch {
    $("play-status").textContent = "Live data is temporarily unavailable. The page will retry automatically.";
  } finally {
    refreshInFlight = false;
  }
}

$("btn-connect").addEventListener("click", async () => {
  try {
    $("btn-connect").disabled = true;
    ({ wallet, account } = await connectWallet());
    $("wallet-copy").textContent = "WALLET CONNECTED";
    $("account").textContent = `connected ${shortAddr(account)}`;
    $("account").classList.remove("hide");
    $("account").classList.add("live");
    $("btn-connect").classList.add("hide");
    $("btn-seal").disabled = false;
    $("btn-seal").textContent = "▸ INSERT GUESS & SEAL";
    $("play-status").textContent = "Wallet connected. Your guess is encrypted in-browser before it touches the chain.";
  } catch (error) {
    $("btn-connect").disabled = false;
    $("play-status").textContent = `Connect failed: ${error.shortMessage || error.message}`;
  }
});

$("btn-seal").addEventListener("click", async () => {
  if (!wallet) return;

  try {
    $("btn-seal").disabled = true;
    $("play-status").textContent = "Encrypting your guess and sealing the entry onchain...";
    const { rid } = await getCurrentRound();
    await playRound(wallet, account, guess);
    myRid = rid;
    $("play-status").textContent = "Sealed successfully. Your entry is hidden until the keeper settles the round.";
    await refresh();
  } catch (error) {
    $("btn-seal").disabled = false;
    $("play-status").textContent = `Seal failed: ${error.shortMessage || error.message}`;
  }
});

$("range").addEventListener("input", (event) => setGuess(event.target.value));
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => setGuess(chip.dataset.v));
});

async function init() {
  buildSeatGrid();
  setGuess(33);
  renderSeatGrid(0);
  renderHistoryCount(1);

  try {
    renderGameMeta(await getGameMeta());
  } catch {
    $("meta-entry").textContent = "$1.00 USDC";
    $("seal-cost").textContent = "$1.00 USDC";
    $("meta-rake").textContent = "--";
    $("meta-duration").textContent = "--";
    $("network-pill").textContent = CONFIG.chainName;
    $("network-chain").textContent = `LIVE ON ${CONFIG.chainName.toUpperCase()}`;
  }

  await refresh();
  setInterval(renderTimer, 1000);
  setInterval(refresh, 5000);
}

init();
