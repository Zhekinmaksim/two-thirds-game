const BOARD_SIZE = 64;
const MAX_PLAYERS = 100;
const RECENT_LIMIT = 12;
const REFRESH_MS = 12_000;
const STORAGE_PENDING = "twothirds:pending";
const STORAGE_LAST_RESULT = "twothirds:last-result";
const STORAGE_ACCOUNT = "twothirds:account";

const $ = (id) => document.getElementById(id);

let integrationPromise = null;

const state = {
  wallet: null,
  account: null,
  selectedNumber: null,
  currentRound: null,
  meta: null,
  results: [],
  activeResult: null,
  pending: loadStoredJson(STORAGE_PENDING),
  lastResultRef: loadStoredJson(STORAGE_LAST_RESULT),
  lastKnownAccount: loadStoredJson(STORAGE_ACCOUNT),
  refreshInFlight: false,
  lastRefreshAt: 0,
  connecting: false,
  submitting: false,
  statusMessage: "",
};

function loadStoredJson(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveStoredJson(key, value) {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage errors
  }
}

async function loadIntegration() {
  if (!integrationPromise) integrationPromise = import("./inco.js");
  return integrationPromise;
}

function toNumber(value) {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function usd(value) {
  return `$${(toNumber(value) / 1e6).toFixed(2)}`;
}

function shortAddr(value) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "0x…";
}

function shortTx(value) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "pending";
}

function buildSharePageUrl(result, summary) {
  const params = new URLSearchParams({
    rid: String(result.rid),
    card: String(result.yourPick),
    target: String(result.target),
    avg: String(result.avg),
    pot: usd(result.grossPot ?? result.netPot),
    won: summary.youWon ? "1" : "0",
    pay: usd(result.payPerWinner),
    off: String(summary.off ?? 0),
    winners: String(summary.winnersPlayers),
  });

  return `https://two-thirds-game.vercel.app/api/share?${params.toString()}`;
}

function formatRound(rid) {
  return `#${String(toNumber(rid)).padStart(3, "0")}`;
}

function formatTimer(secondsLeft) {
  if (secondsLeft <= 0) return "SETTLING";
  const minutes = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const seconds = String(secondsLeft % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function currentSecondsLeft() {
  if (!state.currentRound?.closesAt) return null;
  return Math.max(0, state.currentRound.closesAt - Math.floor(Date.now() / 1000));
}

function isPendingRoundLive() {
  return Boolean(
    state.pending
      && state.currentRound
      && Number(state.pending.rid) === Number(state.currentRound.rid),
  );
}

function getExplorerBase(config) {
  return config.chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
}

function formatUiError(error, fallback) {
  const raw = error?.shortMessage || error?.message || "";
  if (!raw) return fallback;

  const firstLine = raw.split("\n")[0].trim();
  if (!firstLine || firstLine.length > 180) return fallback;
  return `${fallback} ${firstLine}`;
}

function setStatusMessage(message = "") {
  state.statusMessage = message;
  renderWalletHelp();
}

function persistPending(pending) {
  state.pending = pending;
  saveStoredJson(STORAGE_PENDING, pending);
}

function persistLastResult(ref) {
  state.lastResultRef = ref;
  saveStoredJson(STORAGE_LAST_RESULT, ref);
}

function persistKnownAccount(account) {
  state.lastKnownAccount = account;
  saveStoredJson(STORAGE_ACCOUNT, account);
}

function getPersonalPick() {
  if (state.activeResult?.yourPick !== undefined) return state.activeResult.yourPick;
  if (state.pending?.pick !== undefined) return state.pending.pick;
  return state.selectedNumber;
}

function renderContractInfo(config) {
  const explorerBase = getExplorerBase(config);
  $("chainLabel").textContent = `${config.chainName} · ${config.chainId}`;

  if (!config.game) {
    $("contractShort").textContent = "unavailable";
    $("contractLink").removeAttribute("href");
    $("contractLink").classList.add("is-disabled");
    $("verifyOnchainLink").removeAttribute("href");
    $("verifyOnchainLink").classList.add("is-disabled");
    return;
  }

  $("contractShort").textContent = shortAddr(config.game);
  $("contractLink").href = `${explorerBase}/address/${config.game}`;
  $("contractLink").classList.remove("is-disabled");
  $("verifyOnchainLink").href = `${explorerBase}/address/${config.game}`;
  $("verifyOnchainLink").classList.remove("is-disabled");
}

function renderVerifyLinks() {
  const config = window.__ttConfig;
  if (!config?.game) return;

  const explorerBase = getExplorerBase(config);
  const txHash = state.activeResult?.txHash ?? null;

  if (txHash) {
    $("lastTx").textContent = shortTx(txHash);
    $("lastTxLink").href = `${explorerBase}/tx/${txHash}`;
    $("lastTxLink").classList.remove("is-disabled");
    $("verifyOnchainLink").href = `${explorerBase}/tx/${txHash}`;
  } else {
    $("lastTx").textContent = "waiting";
    $("lastTxLink").removeAttribute("href");
    $("lastTxLink").classList.add("is-disabled");
    $("verifyOnchainLink").href = `${explorerBase}/address/${config.game}`;
  }
}

function renderMeta() {
  const entry = state.meta?.entryFee ?? 1_000_000n;
  $("sEntry").textContent = usd(entry);
  $("sealFee").textContent = `${usd(entry)} USDC`;
  $("networkFee").textContent = "Base · gas ~$0.01";
}

function renderStatus() {
  if (!state.currentRound) {
    $("sRound").textContent = "#--";
    $("sPot").textContent = "$0.00";
    $("sPlayers").textContent = `0 / ${MAX_PLAYERS}`;
    $("sTimer").textContent = "--:--";
    return;
  }

  const players = toNumber(state.currentRound.playerCount);
  $("sRound").textContent = formatRound(state.currentRound.rid);
  $("sPot").textContent = usd(state.currentRound.pot);
  $("sPlayers").textContent = `${players} / ${MAX_PLAYERS}`;
  $("sTimer").textContent = formatTimer(currentSecondsLeft());
}

function getResultSummary(result) {
  const counts = new Array(BOARD_SIZE).fill(0);
  const guesses = Array.isArray(result?.guesses) ? result.guesses : [];
  for (const rawGuess of guesses) {
    const guess = Number(rawGuess);
    if (guess >= 0 && guess < BOARD_SIZE) counts[guess] += 1;
  }

  const target = Number(result?.target ?? 0);
  let minDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < counts.length; index += 1) {
    if (!counts[index]) continue;
    const distance = Math.abs(index - target);
    if (distance < minDistance) minDistance = distance;
  }

  const winNums = [];
  const winSet = {};
  let winnersPlayers = 0;

  for (let index = 0; index < counts.length; index += 1) {
    if (!counts[index]) continue;
    if (Math.abs(index - target) === minDistance) {
      winNums.push(index);
      winSet[index] = true;
      winnersPlayers += counts[index];
    }
  }

  const yourPick = Number(result?.yourPick ?? -1);
  const youWon = yourPick >= 0 && Boolean(winSet[yourPick]);
  const off = yourPick >= 0 ? Math.abs(yourPick - target) : null;
  const bins = new Array(32).fill(0);

  for (let index = 0; index < counts.length; index += 1) {
    if (!counts[index]) continue;
    bins[Math.min(31, Math.floor(index / 2))] += counts[index];
  }

  return {
    counts,
    winNums,
    winSet,
    winnersPlayers,
    youWon,
    off,
    bins,
  };
}

function clearSelection() {
  state.selectedNumber = null;
}

function renderBoard() {
  const board = $("board");
  const reveal = Boolean(state.activeResult);
  const personalPick = getPersonalPick();
  const summary = reveal ? getResultSummary(state.activeResult) : null;

  board.className = `tt-board${reveal ? " is-rev" : ""}`;
  $("boardHd").textContent = reveal
    ? "▸ ROUND DECRYPTED — WINNER PAID"
    : isPendingRoundLive()
      ? "▸ ENTRY LOCKED — WAITING FOR CLOSE"
      : "▸ CHOOSE ONE OF 64 ENCRYPTED NUMBERS";

  board.innerHTML = Array.from({ length: BOARD_SIZE }, (_, index) => {
    const count = summary?.counts[index] ?? 0;
    const mine = personalPick === index;
    const win = Boolean(summary?.winSet[index]);

    let cls = "avail";
    let ring = "";
    if (reveal) {
      cls = `${mine ? " mine" : ""}${win ? " win" : ""}`.trim();
    } else if (isPendingRoundLive() && mine) {
      cls = "mine";
      ring = '<span class="ringtag">YOU</span>';
    } else if (state.selectedNumber === index) {
      cls = "sel";
      ring = '<span class="ringtag">PICK</span>';
    }

    const sparks = win
      ? '<span class="spark-dot" style="top:18%;left:24%;width:4px;height:4px;background:#fff;box-shadow:0 0 6px rgba(255,224,150,.95)"></span>'
        + '<span class="spark-dot" style="top:24%;left:72%;width:3px;height:3px;background:#ffd98a;box-shadow:0 0 6px rgba(255,224,150,.95)"></span>'
        + '<span class="spark-dot" style="top:72%;left:20%;width:4px;height:4px;background:#fff;box-shadow:0 0 6px rgba(255,224,150,.95)"></span>'
      : "";

    return `<div class="tt-cardcell ${cls}" data-i="${index}">
      <div class="face">
        <span class="cnum2">${index}</span>
        ${reveal && count > 0 ? `<span class="cnt">×${count}</span>` : ""}
      </div>
      ${win ? `<div class="winGlow"></div><div class="winBadge tt-px">WIN</div>${sparks}` : ""}
      <div class="cover">
        <div class="csheen"></div>
        <span class="cnum">${index}</span>
      </div>
      ${ring}
    </div>`;
  }).join("");
}

function renderWalletHelp() {
  const pendingRound = isPendingRoundLive();

  if (state.statusMessage) {
    $("walletHelp").textContent = state.statusMessage;
    return;
  }

  if (pendingRound) return;

  if (state.account) {
    $("walletHelp").textContent = `Wallet connected: ${shortAddr(state.account)}. Your number is encrypted in-browser before it is sent.`;
    return;
  }

  $("walletHelp").textContent = "Public round data is visible without a wallet. Connect only when you want to sign a real encrypted entry.";
}

function renderControl() {
  const pendingRound = isPendingRoundLive();
  const reveal = Boolean(state.activeResult);

  $("control").hidden = pendingRound || reveal;
  $("waiting").hidden = !pendingRound || reveal;
  $("after").hidden = !reveal;

  if (!pendingRound && !reveal) {
    $("readout").textContent = state.selectedNumber === null ? "—" : `#${state.selectedNumber}`;
    $("readout").classList.toggle("empty", state.selectedNumber === null);
    $("hint").textContent = state.selectedNumber === null
      ? "tap any of the 64 cards →"
      : `selected card #${state.selectedNumber} · repeated picks are allowed`;

    const button = $("btnSign");
    const roundIsFull = toNumber(state.currentRound?.playerCount ?? 0) >= MAX_PLAYERS;

    if (state.connecting) {
      button.disabled = true;
      button.textContent = "▸ CONNECTING...";
    } else if (state.submitting) {
      button.disabled = true;
      button.textContent = "▸ SIGNING...";
    } else if (state.selectedNumber === null) {
      button.disabled = true;
      button.textContent = "▸ PICK A NUMBER FIRST";
    } else if (roundIsFull) {
      button.disabled = true;
      button.textContent = "▸ ROUND FULL";
    } else if (!state.account) {
      button.disabled = false;
      button.textContent = "▸ CONNECT WALLET & ENTER ($1)";
    } else {
      button.disabled = false;
      button.textContent = "▸ SIGN TX & ENTER ($1)";
    }
  }

  if (pendingRound) {
    $("waitCard").textContent = `#${state.pending.pick}`;
    $("pendingTx").textContent = shortTx(state.pending.txHash);
  }

  if (reveal) renderResultPanel();
  renderWalletHelp();
}

function renderResultPanel() {
  const result = state.activeResult;
  const summary = getResultSummary(result);
  const yourPick = Number(result.yourPick);
  const avgDisplay = Number(result.avg).toFixed(1);
  const histMax = Math.max(1, ...summary.bins);
  const targetBin = Math.min(31, Math.floor(Number(result.target) / 2));
  const yourBin = yourPick >= 0 ? Math.min(31, Math.floor(yourPick / 2)) : -1;

  const hist = summary.bins.map((count, index) => {
    const height = Math.max(5, (count / histMax) * 94);
    let style = "background:color-mix(in oklab,var(--accent),#050302 42%);";
    if (index === targetBin) style = "background:var(--red);box-shadow:0 0 8px rgba(255,59,92,.5);";
    if (index === yourBin) style = "background:var(--cyan);box-shadow:0 0 8px rgba(54,245,255,.4);";
    return `<i style="height:${height.toFixed(0)}%;${style}"></i>`;
  }).join("");

  const verdict = summary.youWon
    ? summary.winnersPlayers > 1
      ? "YOU SPLIT THE POT"
      : "YOU WIN"
    : `NO WIN - OFF BY ${summary.off ?? "0"}`;
  const verdictColor = summary.youWon ? "var(--green)" : "var(--red)";
  const verdictGlow = summary.youWon ? "rgba(69,230,69,.5)" : "rgba(255,59,92,.4)";
  const shareBig = summary.youWon ? `I WON ${usd(result.payPerWinner)}` : `OFF BY ${summary.off ?? "0"}`;
  const shareText = summary.youWon
    ? `I won ${usd(result.payPerWinner)} on TWO·THIRDS. My encrypted card #${yourPick} landed closest to ${result.target}.`
    : `Played card #${yourPick} on TWO·THIRDS. 2/3 target landed on ${result.target}. So close, next one is mine.`;
  const sharePageUrl = buildSharePageUrl(result, summary);
  const winLabel = summary.winNums.length
    ? `#${summary.winNums[0]}${summary.winNums.length > 1 ? ` +${summary.winNums.length - 1}` : ""}`
    : "—";

  $("after").innerHTML = `
    <div class="tt-verdict tt-px" style="color:${verdictColor};text-shadow:0 0 8px ${verdictGlow}">${verdict}</div>
    <div class="tt-twocard">
      <div class="c" style="border:1px solid color-mix(in oklab,var(--green),#050302 55%);background:rgba(69,230,69,.06)">
        <div class="lbl">WINNING CARD</div>
        <div class="v" style="color:var(--green);text-shadow:0 0 9px rgba(69,230,69,.55)">${winLabel}</div>
      </div>
      <div class="c" style="border:1px solid color-mix(in oklab,var(--cyan),#050302 55%);background:rgba(54,245,255,.06)">
        <div class="lbl">YOUR CARD</div>
        <div class="v" style="color:var(--cyan);text-shadow:0 0 9px rgba(54,245,255,.5)">#${yourPick}</div>
      </div>
    </div>
    <div class="tt-target">
      <small>⅔ × AVG ${avgDisplay} =</small>
      <div class="v">${result.target}</div>
    </div>
    <div class="tt-hist">${hist}</div>
    <div class="tt-axis"><span>0</span><span>where players landed</span><span>63</span></div>
    <div class="tt-pot">
      <span class="k">POT</span> ${usd(result.grossPot ?? result.netPot)}
      · <span class="k">RAKE</span> ${usd(result.rake ?? 0n)}
      · <span class="k">PAY/WIN</span> <span class="pay">${usd(result.payPerWinner)}</span>
      · ${summary.winnersPlayers} ${summary.winnersPlayers === 1 ? "winner" : "winners"}
    </div>
    <div class="tt-share" style="border:1px solid ${summary.youWon ? "color-mix(in oklab,var(--green),#050302 50%)" : "color-mix(in oklab,var(--red),#050302 50%)"};background:${summary.youWon ? "linear-gradient(135deg,#0c1308,#0a0705)" : "linear-gradient(135deg,#150a0c,#0a0705)"}">
      <span class="dom">twothirds.fun</span>
      <div class="logo">TWO<span style="color:var(--red)">·</span>THIRDS</div>
      <div class="big" style="color:${verdictColor};text-shadow:0 0 14px ${verdictGlow}">${shareBig}</div>
      <div class="sub">card #${yourPick} · target ${result.target} · round ${formatRound(result.rid)}</div>
      <div class="seal">encrypted by Inco · settled automatically by contract</div>
    </div>
    <button class="tt-btn" id="btnShare" type="button">▸ SHARE TO 𝕏</button>
    <button class="tt-btn sec" id="btnNext" type="button">▸ BACK TO LIVE ROUND</button>
  `;

  $("btnShare").onclick = () => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(sharePageUrl)}`;
    window.open(url, "_blank", "noopener");
  };

  $("btnNext").onclick = () => {
    state.activeResult = null;
    persistLastResult(null);
    clearSelection();
    renderBoard();
    renderControl();
    renderVerifyLinks();
  };
}

function renderLeaderboard() {
  const entryFee = state.meta?.entryFee ?? 1_000_000n;
  const viewerAccount = (state.account ?? state.lastKnownAccount ?? "").toLowerCase();
  const stats = new Map();

  for (const result of state.results) {
    for (const player of result.players ?? []) {
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

    for (const winner of result.winnerAddresses ?? []) {
      const key = winner.toLowerCase();
      const row = stats.get(key) ?? {
        address: winner,
        games: 0,
        wins: 0,
        net: 0n,
      };
      row.wins += 1;
      row.net += BigInt(result.payPerWinner);
      stats.set(key, row);
    }
  }

  const rows = [...stats.values()]
    .sort((left, right) => {
      if (left.net === right.net) return right.wins - left.wins;
      return left.net > right.net ? -1 : 1;
    })
    .slice(0, 8);

  if (!rows.length) {
    $("lb").innerHTML = '<tr><td colspan="5" class="tt-empty">leaderboard will appear after real settlements</td></tr>';
    $("youRank").textContent = "#—";
    $("youNet").textContent = "+$0.00";
    return;
  }

  let youRank = "#—";
  let youNet = "+$0.00";

  $("lb").innerHTML = rows.map((row, index) => {
    const isYou = Boolean(viewerAccount) && row.address.toLowerCase() === viewerAccount;
    const winPct = row.games ? Math.round((row.wins / row.games) * 100) : 0;
    const netText = `${row.net >= 0n ? "+" : "-"}${usd(row.net >= 0n ? row.net : -row.net)}`;

    if (isYou) {
      youRank = `#${index + 1}`;
      youNet = netText;
    }

    return `<tr class="${isYou ? "me" : ""}">
      <td>${index === 0 ? "★" : "▸"} #${index + 1}</td>
      <td style="color:${isYou ? "var(--cyan)" : "var(--accent)"}">${shortAddr(row.address)}</td>
      <td class="num">${row.games}</td>
      <td class="num">${winPct}%</td>
      <td class="num" style="color:${row.net >= 0n ? "var(--green)" : "var(--red)"}">${netText}</td>
    </tr>`;
  }).join("");

  $("youRank").textContent = youRank;
  $("youNet").textContent = youNet;
}

function renderFeed() {
  if (!state.results.length) {
    $("feed").innerHTML = "<span>Waiting for the first settled round...</span><span>Waiting for the first settled round...</span>";
    return;
  }

  const items = state.results.slice(0, 8).map((row) => {
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

async function syncResultState(integration) {
  if (state.pending?.rid !== undefined) {
    const pendingResult = await integration.getRoundResult(state.pending.rid);
    if (pendingResult) {
      const resolvedResult = {
        ...pendingResult,
        yourPick: state.pending.pick,
      };
      const summary = getResultSummary(resolvedResult);

      persistPending(null);
      clearSelection();

      if (!summary.youWon) {
        state.activeResult = null;
        persistLastResult(null);
        setStatusMessage("Round settled. No win this time, the board is reset for the live round.");
        return;
      }

      state.activeResult = resolvedResult;
      persistLastResult({ rid: pendingResult.rid, pick: resolvedResult.yourPick });
      return;
    }
  }

  if (state.lastResultRef?.rid !== undefined) {
    const recentResult = await integration.getRoundResult(state.lastResultRef.rid);
    if (recentResult) {
      state.activeResult = {
        ...recentResult,
        yourPick: state.lastResultRef.pick,
      };
      return;
    }
  }

  state.activeResult = null;
}

async function refresh() {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;

  try {
    const integration = await loadIntegration();
    window.__ttConfig = integration.CONFIG;

    if (!state.wallet || !state.account) {
      const resumed = await integration.resumeWalletConnection().catch(() => null);
      if (resumed) {
        state.wallet = resumed.wallet;
        state.account = resumed.account;
        persistKnownAccount(resumed.account);
      }
    }

    const [round, recent, meta] = await Promise.all([
      integration.getCurrentRound(),
      integration.getRecentResults(RECENT_LIMIT).catch(() => []),
      state.meta ? Promise.resolve(state.meta) : integration.getGameMeta().catch(() => null),
    ]);

    if (meta) state.meta = meta;
    state.currentRound = round;
    state.results = recent;
    renderContractInfo(integration.CONFIG);
    await syncResultState(integration);
    renderMeta();
    renderStatus();
    renderBoard();
    renderControl();
    renderLeaderboard();
    renderFeed();
    renderVerifyLinks();
    if (!state.account) setStatusMessage("");
  } catch (error) {
    setStatusMessage(formatUiError(error, "Live data is temporarily unavailable. Retrying automatically."));
    renderStatus();
    renderBoard();
    renderControl();
    renderLeaderboard();
    renderFeed();
  } finally {
    state.lastRefreshAt = Date.now();
    state.refreshInFlight = false;
  }
}

async function handleConnectAndEnter() {
  if (state.selectedNumber === null || state.submitting || state.connecting) return;

  try {
    const integration = await loadIntegration();
    if (!state.account) {
      state.connecting = true;
      renderControl();
      const resumed = await integration.resumeWalletConnection({ ensureCorrectChain: true }).catch(() => null);
      const { wallet, account } = resumed ?? await integration.connectWallet();
      state.wallet = wallet;
      state.account = account;
      persistKnownAccount(account);
      state.connecting = false;
      setStatusMessage("");
      renderControl();
      renderLeaderboard();
    }

    state.submitting = true;
    renderControl();

    const round = await integration.getCurrentRound();
    const txHash = await integration.playRound(state.wallet, state.account, state.selectedNumber);

    persistLastResult(null);
    persistPending({
      rid: Number(round.rid),
      pick: state.selectedNumber,
      txHash,
    });
    state.activeResult = null;
    setStatusMessage("Encrypted entry submitted. The round will settle automatically after close.");
    await refresh();
  } catch (error) {
    setStatusMessage(`Action failed: ${error?.shortMessage || error?.message || "wallet request failed"}`);
  } finally {
    state.connecting = false;
    state.submitting = false;
    renderControl();
  }
}

function bindEvents() {
  $("verifyBtn").addEventListener("click", () => {
    const panel = $("verifyPanel");
    const open = panel.hidden;
    panel.hidden = !open;
    $("verifyBtn").textContent = open ? "HIDE ↗" : "HOW IT WORKS ↗";
  });

  $("board").addEventListener("click", (event) => {
    if (state.activeResult || isPendingRoundLive()) return;
    const card = event.target.closest(".tt-cardcell");
    if (!card) return;
    setStatusMessage("");
    state.selectedNumber = Number(card.dataset.i);
    renderBoard();
    renderControl();
  });

  $("btnSign").addEventListener("click", handleConnectAndEnter);
}

function startLoops() {
  window.setInterval(() => {
    renderStatus();
    const secondsLeft = currentSecondsLeft();
    if (secondsLeft === null) return;
    if (secondsLeft === 0 && Date.now() - state.lastRefreshAt > 1_250) refresh();
  }, 1_000);

  window.setInterval(() => {
    refresh();
  }, REFRESH_MS);
}

async function init() {
  bindEvents();

  const integration = await loadIntegration();
  window.__ttConfig = integration.CONFIG;

  const resumed = await integration.resumeWalletConnection().catch(() => null);
  if (resumed) {
    state.wallet = resumed.wallet;
    state.account = resumed.account;
    persistKnownAccount(resumed.account);
  }

  renderContractInfo(integration.CONFIG);
  renderMeta();
  renderStatus();
  renderBoard();
  renderControl();
  renderLeaderboard();
  renderFeed();
  renderVerifyLinks();
  await refresh();
  startLoops();
}

init().catch((error) => {
  setStatusMessage(formatUiError(error, "Initialization failed."));
  renderControl();
});
