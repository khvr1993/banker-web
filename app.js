// ==========================================================================
// Business Game Banker — Frontend Application Engine
// ==========================================================================

const PALETTE = [
  { name: "Crimson", bg: "#e11d48", text: "#fff" },
  { name: "Royal Blue", bg: "#2563eb", text: "#fff" },
  { name: "Emerald", bg: "#059669", text: "#fff" },
  { name: "Amber", bg: "#d97706", text: "#fff" },
  { name: "Purple", bg: "#9333ea", text: "#fff" },
  { name: "Teal", bg: "#0d9488", text: "#fff" },
  { name: "Coral", bg: "#ea580c", text: "#fff" },
  { name: "Pink", bg: "#db2777", text: "#fff" }
];

const STATE = {
  currentGameId: null,
  game: null,
  players: [],
  transactions: [],
  rounds: [],
  bankInfo: null,
  categories: [],
  prevBalances: new Map(), // playerId -> balance (for animation)
  soundEnabled: localStorage.getItem("banker_sound") !== "false",
  pollInterval: null,
  pendingVoidTxnId: null,
  pendingBankruptPid: null,
  activeTransferTab: "rent",
  appMode: "banker", // "banker" or "player"
  myPlayerId: null
};

// ==================== AUDIO SYNTHESIZER ====================

class SoundSynth {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx && typeof window.AudioContext !== "undefined") {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  playCoin() {
    if (!STATE.soundEnabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc1.type = "sine";
      osc1.frequency.setValueAtTime(987.77, now); // B5
      osc1.frequency.exponentialRampToValueAtTime(1318.51, now + 0.15); // E6

      osc2.type = "triangle";
      osc2.frequency.setValueAtTime(1318.51, now);
      osc2.frequency.exponentialRampToValueAtTime(1975.53, now + 0.15); // B6

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this.ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.3);
      osc2.stop(now + 0.3);
    } catch (_) {}
  }

  playRoundBell() {
    if (!STATE.soundEnabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        const start = now + (i * 0.08);

        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, start);

        gain.gain.setValueAtTime(0.2, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(start);
        osc.stop(start + 0.5);
      });
    } catch (_) {}
  }

  playVoid() {
    if (!STATE.soundEnabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.exponentialRampToValueAtTime(100, now + 0.2);

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.2);
    } catch (_) {}
  }
}

const synth = new SoundSynth();

// ==================== API CLIENT ====================

function generateIdemKey(prefix = "txn") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

import { localApi, downloadGameCsv, exportBackup, importBackup } from "./js/api.js";

async function api(path, options = {}) {
  try {
    return await localApi(path, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body
    });
  } catch (err) {
    // Local errors already carry .message / .status / .type — keep the
    // same shape the network era produced for the UI to consume.
    console.error(`Local API Error on ${path}:`, err);
    throw err;
  }
}

// ==================== TOAST SYSTEM ====================

function showToast(message, type = "info", duration = 3500) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    toast.style.transition = "all 0.2s ease";
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// ==================== DERIVATION HELPERS ====================

function formatMoney(amount, currency) {
  const curr = currency || (STATE.game && STATE.game.currency) || "₹";
  const num = Number(amount || 0);
  return `${curr}${num.toLocaleString("en-IN")}`;
}

function derivePlayerColor(seatNo) {
  const index = Math.max(0, (seatNo - 1)) % PALETTE.length;
  return PALETTE[index];
}

function deriveNextSeat(players = []) {
  if (!players || players.length === 0) return 1;
  const maxSeat = players.reduce((max, p) => Math.max(max, p.seat_no || 0), 0);
  return maxSeat + 1;
}

// ==================== UI STATE RENDERING ====================

async function loadGame(gameId) {
  try {
    STATE.currentGameId = gameId;
    localStorage.setItem("banker_last_game_id", gameId);

    // Load saved player ID for this game if available
    if (!STATE.myPlayerId) {
      STATE.myPlayerId = localStorage.getItem("banker_player_id_" + gameId);
    }

    const [game, txnsData, bankData] = await Promise.all([
      api(`/games/${gameId}`),
      api(`/games/${gameId}/ledger`),
      api(`/games/${gameId}/bank`).catch(() => null)
    ]);

    STATE.game = game;
    STATE.players = game.players || [];
    STATE.transactions = txnsData.transactions || [];
    STATE.bankInfo = bankData;

    // Position transfer card according to current app mode
    setAppMode(STATE.appMode);

    renderHeader();
    renderMainViews();
    populateTransferSelectors();
    updateLedgerFilters();
    renderLedger();

    startPolling();
  } catch (err) {
    showToast(err.message, "error");
    renderEmptyView();
  }
}

async function refreshActiveGame() {
  if (!STATE.currentGameId) return;

  try {
    const [game, txnsData, bankData] = await Promise.all([
      api(`/games/${STATE.currentGameId}`),
      api(`/games/${STATE.currentGameId}/ledger`),
      api(`/games/${STATE.currentGameId}/bank`).catch(() => null)
    ]);

    STATE.game = game;
    STATE.players = game.players || [];
    STATE.transactions = txnsData.transactions || [];
    STATE.bankInfo = bankData;

    renderHeader();
    renderMainViews();
    populateTransferSelectors();
    renderLedger();
    if (STATE.appMode === "player" && STATE.myPlayerId) {
      renderPlayerPassbook(STATE.myPlayerId);
    }
  } catch (err) {
    console.warn("Background poll failed:", err.message);
  }
}

function startPolling() {
  if (STATE.pollInterval) clearInterval(STATE.pollInterval);
  STATE.pollInterval = setInterval(() => {
    refreshActiveGame();
  }, 2500);
}

function renderHeader() {
  const headerControls = document.getElementById("game-header-controls");
  const modeBtn = document.getElementById("btn-toggle-mode");
  const modeIcon = document.getElementById("mode-icon");
  const modeText = document.getElementById("mode-text");
  const nextRoundBtn = document.getElementById("btn-next-round");
  const newGameBtn = document.getElementById("btn-new-game-modal");
  const gamesListBtn = document.getElementById("btn-open-games-list");

  if (!STATE.game) {
    headerControls.style.display = "none";
    if (modeBtn) modeBtn.style.display = "none";
    return;
  }

  if (modeBtn) {
    modeBtn.style.display = "inline-flex";
    if (STATE.appMode === "player") {
      modeIcon.textContent = "👑";
      modeText.textContent = "Banker View";
      modeBtn.classList.remove("btn-emerald");
      modeBtn.classList.add("btn-secondary");

      // In Player View, hide Banker-only header actions
      if (nextRoundBtn) nextRoundBtn.style.display = "none";
      if (newGameBtn) newGameBtn.style.display = "none";
      if (gamesListBtn) gamesListBtn.style.display = "none";
    } else {
      modeIcon.textContent = "👤";
      modeText.textContent = "Player View";
      modeBtn.classList.remove("btn-secondary");
      modeBtn.classList.add("btn-emerald");

      if (newGameBtn) newGameBtn.style.display = "inline-flex";
      if (gamesListBtn) gamesListBtn.style.display = "inline-flex";
      if (nextRoundBtn) {
        nextRoundBtn.style.display = STATE.game.status === "active" ? "inline-flex" : "none";
      }
    }
  }

  headerControls.style.display = "flex";
  document.getElementById("hdr-game-name").textContent = STATE.game.name;

  const statusEl = document.getElementById("hdr-game-status");
  statusEl.textContent = STATE.game.status.toUpperCase();
  statusEl.className = `status-badge ${STATE.game.status}`;

  const curr = STATE.game.currency || "₹";
  document.getElementById("hdr-bank-balance").textContent = formatMoney(STATE.game.bank_balance, curr);

  const initBank = STATE.game.initial_bank_balance || 1;
  const bankPercent = Math.min(100, Math.max(0, (STATE.game.bank_balance / initBank) * 100));
  document.getElementById("hdr-bank-float-bar").style.width = `${bankPercent}%`;

  document.getElementById("hdr-round-no").textContent = STATE.game.current_round;
}

function setAppMode(mode) {
  STATE.appMode = mode;
  localStorage.setItem("banker_app_mode", mode);

  const transferCard = document.getElementById("transfer-card");
  const subviewConsole = document.getElementById("subview-console");
  const playerTransferContainer = document.getElementById("player-transfer-container");
  const bankPayoutTab = document.querySelector(`.tab-btn[data-tab="bank-pay"]`);

  if (mode === "player") {
    // Hide bank payout tab
    if (bankPayoutTab) bankPayoutTab.style.display = "none";

    // If currently on bank-pay tab, switch to rent
    if (STATE.activeTransferTab === "bank-pay") {
      document.querySelector(`.tab-btn[data-tab="rent"]`)?.click();
    }

    // Mount transfer-card in player container
    if (transferCard && playerTransferContainer && transferCard.parentElement !== playerTransferContainer) {
      playerTransferContainer.appendChild(transferCard);
    }
  } else {
    // Show bank payout tab
    if (bankPayoutTab) bankPayoutTab.style.display = "flex";

    // Mount transfer-card in banker console
    if (transferCard && subviewConsole && transferCard.parentElement !== subviewConsole) {
      subviewConsole.appendChild(transferCard);
    }
  }

  renderHeader();
  renderMainViews();
  populateTransferSelectors();
}

function renderMainViews() {
  const viewEmpty = document.getElementById("view-empty");
  const viewLobby = document.getElementById("view-lobby");
  const viewActive = document.getElementById("view-active");
  const viewPlayer = document.getElementById("view-player");

  viewEmpty.style.display = "none";
  viewLobby.style.display = "none";
  viewActive.style.display = "none";
  if (viewPlayer) viewPlayer.style.display = "none";

  if (!STATE.game) {
    renderEmptyView();
    return;
  }

  // If in Player Mode
  if (STATE.appMode === "player") {
    if (viewPlayer) viewPlayer.style.display = "flex";
    renderPlayerView();
    return;
  }

  // Banker Mode
  const curr = STATE.game.currency || "₹";

  if (STATE.game.status === "pending") {
    viewLobby.style.display = "flex";
    document.getElementById("lobby-game-title").textContent = STATE.game.name;
    document.getElementById("lobby-starting-cash").textContent = formatMoney(STATE.game.starting_cash, curr);
    document.getElementById("lobby-bank-balance").textContent = formatMoney(STATE.game.initial_bank_balance, curr);
    document.getElementById("lobby-round-salary").textContent = formatMoney(STATE.game.salary_per_round, curr);

    renderLobbyPlayers();
    updateLobbySeatDerivation();
  } else {
    viewActive.style.display = "flex";
    document.getElementById("label-curr-salary").textContent = formatMoney(STATE.game.salary_per_round, curr);

    const activeCount = STATE.players.filter(p => !p.is_bankrupt).length;
    document.getElementById("active-players-badge").textContent = `${activeCount} Active / ${STATE.players.length} Total`;

    const finishedBanner = document.getElementById("finished-banner");
    const transferCard = document.getElementById("transfer-card");
    if (STATE.game.status === "finished") {
      finishedBanner.style.display = "flex";
      transferCard.style.display = "none";
    } else {
      finishedBanner.style.display = "none";
      transferCard.style.display = "block";
    }

    renderPlayerCards();
  }
}

// ==================== DEDICATED PLAYER VIEW LOGIC ====================

function renderPlayerView() {
  const pickerScreen = document.getElementById("player-picker-screen");
  const dashboardScreen = document.getElementById("player-dashboard-screen");

  if (!STATE.game) {
    if (pickerScreen) pickerScreen.style.display = "none";
    if (dashboardScreen) dashboardScreen.style.display = "none";
    return;
  }

  // Check if current selected player still exists in game
  const me = STATE.players.find(p => p.id === STATE.myPlayerId);
  if (!me) {
    if (STATE.myPlayerId) {
      showToast("Selected player is no longer in this game. Please choose your name.", "info");
      STATE.myPlayerId = null;
      if (STATE.currentGameId) {
        localStorage.removeItem("banker_player_id_" + STATE.currentGameId);
      }
    }
  }

  if (!STATE.myPlayerId || !me) {
    if (pickerScreen) pickerScreen.style.display = "block";
    if (dashboardScreen) dashboardScreen.style.display = "none";
    renderPlayerPicker();
  } else {
    if (pickerScreen) pickerScreen.style.display = "none";
    if (dashboardScreen) dashboardScreen.style.display = "block";
    renderPlayerDashboard(me);
  }
}

function renderPlayerPicker() {
  const grid = document.getElementById("player-picker-grid");
  if (!grid) return;
  grid.innerHTML = "";

  if (STATE.players.length === 0) {
    grid.innerHTML = `
      <div class="text-muted text-center p-4">
        No players seated yet in this game. Ask the Banker to seat you in the lobby!
      </div>
    `;
    return;
  }

  STATE.players.forEach(p => {
    const color = derivePlayerColor(p.seat_no);
    const card = document.createElement("div");
    card.className = "player-pick-card";
    card.innerHTML = `
      <div class="player-pick-left">
        <div class="player-avatar" style="background-color: ${color.bg};">
          ${p.name.charAt(0).toUpperCase()}
        </div>
        <div>
          <strong style="font-size: 16px; color: #fff;">${escapeHtml(p.name)}</strong>
          <div class="text-xs text-muted">Seat ${p.seat_no} ${p.is_bankrupt ? "• Bankrupt" : ""}</div>
        </div>
      </div>
      <button class="btn btn-primary btn-sm btn-select-player" data-pid="${p.id}">
        Select Me ➔
      </button>
    `;
    card.querySelector(".btn-select-player").addEventListener("click", () => {
      selectMyPlayer(p.id);
    });
    grid.appendChild(card);
  });
}

function selectMyPlayer(pid) {
  STATE.myPlayerId = pid;
  if (STATE.currentGameId) {
    localStorage.setItem("banker_player_id_" + STATE.currentGameId, pid);
  }
  const pName = STATE.players.find(p => p.id === pid)?.name || "Player";
  showToast(`Welcome, ${pName}!`, "success");
  renderPlayerView();
  populateTransferSelectors();
}

function switchMyPlayer() {
  STATE.myPlayerId = null;
  if (STATE.currentGameId) {
    localStorage.removeItem("banker_player_id_" + STATE.currentGameId);
  }
  renderPlayerView();
}

function renderPlayerDashboard(me) {
  const curr = STATE.game?.currency || "₹";

  // 1. Identity & Rank
  const sorted = [...STATE.players].sort((a, b) => b.cash - a.cash);
  const myRank = sorted.findIndex(p => p.id === me.id) + 1;

  document.getElementById("my-player-name").textContent = me.name;
  const rankEl = document.getElementById("my-player-rank");
  rankEl.textContent = me.is_bankrupt ? "Bankrupt" : `#${myRank} Leader`;
  rankEl.className = `rank-tag ${myRank <= 3 ? "rank-" + myRank : ""}`;

  document.getElementById("my-player-seat").textContent = `Seat ${me.seat_no}`;
  document.getElementById("my-player-game-round").textContent = `Round ${STATE.game.current_round || 0}`;

  const color = derivePlayerColor(me.seat_no);
  const avatar = document.getElementById("my-player-avatar");
  avatar.textContent = me.name.charAt(0).toUpperCase();
  avatar.style.backgroundColor = color.bg;

  // 2. Animated Cash Balance
  const cashBox = document.getElementById("my-player-balance-box");
  const prevCash = STATE.prevBalances.get(me.id);
  if (prevCash !== undefined) {
    if (me.cash > prevCash) {
      cashBox.classList.remove("flash-credit", "flash-debit");
      void cashBox.offsetWidth;
      cashBox.classList.add("flash-credit");
    } else if (me.cash < prevCash) {
      cashBox.classList.remove("flash-credit", "flash-debit");
      void cashBox.offsetWidth;
      cashBox.classList.add("flash-debit");
    }
  }
  STATE.prevBalances.set(me.id, me.cash);
  document.getElementById("my-player-cash").textContent = formatMoney(me.cash, curr);

  // 3. Lifecycle Banners & Payment Pad Visibility
  const pendingBanner = document.getElementById("player-pending-banner");
  const finishedBanner = document.getElementById("player-finished-banner");
  const bankruptBanner = document.getElementById("player-bankrupt-banner");
  const transferContainer = document.getElementById("player-transfer-container");
  const transferCard = document.getElementById("transfer-card");

  pendingBanner.style.display = "none";
  finishedBanner.style.display = "none";
  bankruptBanner.style.display = "none";

  if (STATE.game.status === "pending") {
    pendingBanner.style.display = "flex";
    if (transferContainer) transferContainer.style.display = "none";
  } else if (STATE.game.status === "finished") {
    finishedBanner.style.display = "flex";
    if (transferContainer) transferContainer.style.display = "none";
  } else if (me.is_bankrupt) {
    bankruptBanner.style.display = "flex";
    if (transferContainer) transferContainer.style.display = "none";
  } else {
    if (transferContainer) {
      transferContainer.style.display = "block";
      if (transferCard && transferCard.parentElement !== transferContainer) {
        transferContainer.appendChild(transferCard);
      }
    }
  }

  // 4. Table Roster
  renderTableRoster(me);

  // 5. Personal Passbook
  renderPlayerPassbook(me.id);
}

function renderTableRoster(me) {
  const container = document.getElementById("table-roster-grid");
  if (!container) return;
  container.innerHTML = "";

  const curr = STATE.game?.currency || "₹";
  const others = STATE.players.filter(p => p.id !== me.id);

  if (others.length === 0) {
    container.innerHTML = `<div class="text-muted text-xs p-2">No other players seated yet.</div>`;
    return;
  }

  others.forEach(p => {
    const color = derivePlayerColor(p.seat_no);
    const item = document.createElement("div");
    item.className = "table-roster-item";
    item.innerHTML = `
      <div class="table-roster-left">
        <div class="player-avatar" style="background-color: ${color.bg};">
          ${p.name.charAt(0).toUpperCase()}
        </div>
        <div>
          <strong style="color: #fff;">${escapeHtml(p.name)}</strong>
          <div class="text-xs text-muted">${formatMoney(p.cash, curr)} • Seat ${p.seat_no}</div>
        </div>
      </div>
      ${!p.is_bankrupt && STATE.game.status === "active" ? `
        <button class="btn btn-secondary btn-xs btn-pay-roster" data-pid="${p.id}" data-name="${escapeHtml(p.name)}">
          Pay Rent ➔
        </button>
      ` : ""}
    `;

    const payBtn = item.querySelector(".btn-pay-roster");
    if (payBtn) {
      payBtn.addEventListener("click", () => {
        document.querySelector(`.tab-btn[data-tab="rent"]`)?.click();
        document.getElementById("transfer-to-select").value = p.id;
        updateBalanceHints();
        autoSuggestDescription();
        document.getElementById("transfer-card").scrollIntoView({ behavior: "smooth", block: "start" });
        setTimeout(() => document.getElementById("transfer-amount").focus(), 250);
      });
    }

    container.appendChild(item);
  });
}

async function renderPlayerPassbook(pid) {
  const tbody = document.getElementById("player-passbook-tbody");
  if (!tbody || !STATE.currentGameId) return;

  const curr = STATE.game?.currency || "₹";

  try {
    const res = await api(`/games/${STATE.currentGameId}/players/${pid}/ledger`);
    const rows = res.statement || [];

    const badge = document.getElementById("passbook-count-badge");
    if (badge) badge.textContent = `${rows.length} entries`;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted p-4">No transactions recorded yet in your passbook.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    // Newest first
    rows.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

    rows.forEach(r => {
      const timeStr = r.created_at ? r.created_at.split("T")[1]?.substring(0, 8) : "";
      const tr = document.createElement("tr");
      if (r.voided) tr.className = "is-voided";

      tr.innerHTML = `
        <td class="text-xs text-muted">${timeStr}</td>
        <td><span class="badge badge-info">R${r.round}</span></td>
        <td><span class="category-tag cat-${r.account_category}">${r.account_category}</span></td>
        <td><span class="counterparty-pill">${escapeHtml(r.counterparty || "-")}</span></td>
        <td style="text-align: right;" class="${r.dr > 0 ? "amount-dr" : "text-dim"}">${r.dr > 0 ? formatMoney(r.dr, curr) : "-"}</td>
        <td style="text-align: right;" class="${r.cr > 0 ? "amount-cr" : "text-dim"}">${r.cr > 0 ? formatMoney(r.cr, curr) : "-"}</td>
        <td class="text-xs text-muted">${escapeHtml(r.description || "-")}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-ruby text-center p-4">${err.message}</td></tr>`;
  }
}

function renderEmptyView() {
  document.getElementById("view-empty").style.display = "flex";
  document.getElementById("view-lobby").style.display = "none";
  document.getElementById("view-active").style.display = "none";
  document.getElementById("game-header-controls").style.display = "none";
}

// ==================== LOBBY RENDERING ====================

function renderLobbyPlayers() {
  const listEl = document.getElementById("lobby-players-list");
  listEl.innerHTML = "";
  document.getElementById("lobby-player-count").textContent = STATE.players.length;

  if (STATE.players.length === 0) {
    listEl.innerHTML = `<div class="text-muted text-center p-4">No players seated yet. Add at least 1 player below.</div>`;
    return;
  }

  STATE.players.forEach(p => {
    const color = derivePlayerColor(p.seat_no);
    const row = document.createElement("div");
    row.className = "lobby-player-row";
    row.innerHTML = `
      <div class="lobby-player-left">
        <div class="player-avatar" style="background-color: ${color.bg};">
          ${p.name.charAt(0).toUpperCase()}
        </div>
        <div>
          <strong>${escapeHtml(p.name)}</strong>
          <div class="text-xs text-muted">Seat ${p.seat_no}</div>
        </div>
      </div>
      <button class="btn btn-ghost btn-xs btn-remove-player" data-pid="${p.id}" title="Remove player">
        Remove
      </button>
    `;
    listEl.appendChild(row);
  });
}

function updateLobbySeatDerivation() {
  const nextSeat = deriveNextSeat(STATE.players);
  const color = derivePlayerColor(nextSeat);

  document.getElementById("derived-seat-no").textContent = `Seat ${nextSeat}`;
  const preview = document.getElementById("derived-color-preview");
  preview.style.backgroundColor = color.bg;
  preview.title = color.name;
}

// ==================== PLAYER CARDS & WALLETS ====================

function renderPlayerCards() {
  const grid = document.getElementById("player-cards-grid");
  grid.innerHTML = "";

  const curr = STATE.game.currency || "₹";

  // Compute rankings based on cash
  const sorted = [...STATE.players].sort((a, b) => b.cash - a.cash);
  const rankMap = new Map();
  sorted.forEach((p, idx) => {
    if (!p.is_bankrupt) rankMap.set(p.id, idx + 1);
  });

  STATE.players.forEach(p => {
    const color = derivePlayerColor(p.seat_no);
    const card = document.createElement("div");
    card.className = `player-card ${p.is_bankrupt ? "is-bankrupt" : ""}`;
    card.id = `player-card-${p.id}`;

    const rank = rankMap.get(p.id);
    const rankLabel = p.is_bankrupt ? "Bankrupt" : `#${rank}`;
    const rankClass = rank <= 3 ? `rank-${rank}` : "";

    // Check balance difference for animation
    const prevCash = STATE.prevBalances.get(p.id);
    let flashClass = "";
    if (prevCash !== undefined) {
      if (p.cash > prevCash) flashClass = "flash-credit";
      else if (p.cash < prevCash) flashClass = "flash-debit";
    }
    STATE.prevBalances.set(p.id, p.cash);

    card.innerHTML = `
      <div class="player-card-header">
        <div class="player-header-left">
          <div class="player-avatar" style="background-color: ${color.bg};">
            ${p.name.charAt(0).toUpperCase()}
          </div>
          <div class="player-details">
            <div class="player-name">${escapeHtml(p.name)}</div>
            <div class="player-seat">Seat ${p.seat_no}</div>
          </div>
        </div>
        <div class="rank-tag ${rankClass}">${rankLabel}</div>
      </div>

      <div class="player-balance-box ${flashClass}">
        <div class="balance-label">Cash Wallet</div>
        <div class="balance-amount">${formatMoney(p.cash, curr)}</div>
      </div>

      <div class="player-actions-row">
        <div class="player-action-buttons-top">
          <button class="btn-player-pay" data-pid="${p.id}" ${p.is_bankrupt ? "disabled" : ""} title="Send money from this player">
            <span>💸 Pay</span> <span>↗</span>
          </button>
          <button class="btn-player-rcv" data-pid="${p.id}" ${p.is_bankrupt ? "disabled" : ""} title="Receive money to this player">
            <span>💰 Receive</span> <span>↙</span>
          </button>
        </div>
        <button class="btn-player-stmt" data-pid="${p.id}" title="View Dr/Cr statement in Ledger Book">
          <span>📜</span> View Statement
        </button>
      </div>
    `;

    grid.appendChild(card);
  });
}

// ==================== SMART TRANSFER CENTER ====================

function setupTransferTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.activeTransferTab = btn.dataset.tab;
      configureTransferFormForTab(STATE.activeTransferTab);
    });
  });
}

function configureTransferFormForTab(tab) {
  const fromSelect = document.getElementById("transfer-from-select");
  const toSelect = document.getElementById("transfer-to-select");
  const catSelect = document.getElementById("transfer-category-select");
  const helperText = document.getElementById("tab-helper-text");

  const isPlayerMode = STATE.appMode === "player" && STATE.myPlayerId;
  const me = isPlayerMode ? STATE.players.find(p => p.id === STATE.myPlayerId) : null;

  switch (tab) {
    case "rent":
      helperText.textContent = isPlayerMode
        ? `Pay rent to another player for landing on their property`
        : `Bob pays Alice for landing on her property (RENT category)`;
      fromSelect.disabled = isPlayerMode;
      toSelect.disabled = false;
      catSelect.value = "RENT";
      catSelect.disabled = true;

      // In rent tab, recipient cannot be BANK
      if (toSelect.value === "BANK") {
        const firstPlayer = Array.from(toSelect.options).find(o => o.value !== "BANK");
        if (firstPlayer) toSelect.value = firstPlayer.value;
      }
      break;

    case "pay-bank":
      helperText.textContent = isPlayerMode
        ? `Pay Bank drawer for Taxes, Fines, or Buying properties`
        : `Player pays Bank drawer for Taxes, Fines, or Buying properties`;
      fromSelect.disabled = isPlayerMode;
      toSelect.value = "BANK";
      toSelect.disabled = true;
      catSelect.disabled = false;
      if (!["INCOME_TAX", "FINE", "PROPERTY_PURCHASE", "BUILD", "EXPENSE"].includes(catSelect.value)) {
        catSelect.value = "INCOME_TAX";
      }
      break;

    case "bank-pay":
      helperText.textContent = `Bank drawer funds a player (Salary, Bonus, Mortgage, Loan)`;
      fromSelect.value = "BANK";
      fromSelect.disabled = true;
      toSelect.disabled = false;
      catSelect.disabled = false;
      if (!["SALARY", "LOAN", "MORTGAGE", "INCOME", "GIFT"].includes(catSelect.value)) {
        catSelect.value = "SALARY";
      }
      break;

    case "custom":
    default:
      helperText.textContent = isPlayerMode
        ? `Send money from your wallet to any counterparty`
        : `Free-form transfer between any accounts and categories`;
      fromSelect.disabled = isPlayerMode;
      toSelect.disabled = false;
      catSelect.disabled = false;
      break;
  }

  if (isPlayerMode && me) {
    fromSelect.value = me.id;
  }

  updateBalanceHints();
  autoSuggestDescription();
}

function populateTransferSelectors() {
  const fromSelect = document.getElementById("transfer-from-select");
  const toSelect = document.getElementById("transfer-to-select");
  const catSelect = document.getElementById("transfer-category-select");

  const prevFrom = fromSelect.value;
  const prevTo = toSelect.value;

  const isPlayerMode = STATE.appMode === "player" && STATE.myPlayerId;
  const me = isPlayerMode ? STATE.players.find(p => p.id === STATE.myPlayerId) : null;

  if (isPlayerMode && me) {
    // In Player mode, From is strictly locked to the player
    fromSelect.innerHTML = `<option value="${me.id}">👤 ${escapeHtml(me.name)} (You - Locked)</option>`;
    fromSelect.value = me.id;
    fromSelect.disabled = true;

    // To selector: Bank + other players (excluding myself)
    toSelect.innerHTML = `<option value="BANK">🏛️ Bank Drawer</option>`;
    STATE.players.forEach(p => {
      if (p.id !== me.id && !p.is_bankrupt) {
        toSelect.innerHTML += `<option value="${p.id}">👤 ${escapeHtml(p.name)}</option>`;
      }
    });

    if (prevTo && prevTo !== me.id) toSelect.value = prevTo;
  } else {
    // Banker Mode: Full two-way options
    fromSelect.disabled = false;
    fromSelect.innerHTML = `<option value="BANK">🏛️ Bank Drawer</option>`;
    toSelect.innerHTML = `<option value="BANK">🏛️ Bank Drawer</option>`;

    STATE.players.forEach(p => {
      if (!p.is_bankrupt) {
        fromSelect.innerHTML += `<option value="${p.id}">👤 ${escapeHtml(p.name)}</option>`;
        toSelect.innerHTML += `<option value="${p.id}">👤 ${escapeHtml(p.name)}</option>`;
      }
    });

    if (prevFrom) fromSelect.value = prevFrom;
    if (prevTo) toSelect.value = prevTo;
  }

  // Populate categories if not already done
  if (catSelect.options.length <= 1) {
    const cats = [
      "RENT", "SALARY", "ROUND_COMPLETE", "INCOME_TAX", "FINE",
      "PROPERTY_PURCHASE", "PROPERTY_SALE", "BUILD", "MORTGAGE",
      "MORTGAGE_REDEEM", "LOAN", "LOAN_REPAYMENT", "GIFT", "EXPENSE",
      "INCOME", "TRANSFER", "OTHERS"
    ];
    catSelect.innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join("");
  }

  // Update salary shortcut chip
  if (STATE.game) {
    const curr = STATE.game.currency || "₹";
    const chipSalary = document.getElementById("chip-salary");
    chipSalary.textContent = `+${formatMoney(STATE.game.salary_per_round, curr)} (Salary)`;
    chipSalary.dataset.add = STATE.game.salary_per_round;
  }

  configureTransferFormForTab(STATE.activeTransferTab);
}

function updateBalanceHints() {
  const fromSelect = document.getElementById("transfer-from-select");
  const toSelect = document.getElementById("transfer-to-select");
  const fromHint = document.getElementById("from-balance-hint");
  const toHint = document.getElementById("to-balance-hint");
  const curr = STATE.game ? STATE.game.currency || "₹" : "₹";

  let fromBal = 0;
  if (fromSelect.value === "BANK") {
    fromBal = STATE.game ? STATE.game.bank_balance : 0;
  } else {
    const p = STATE.players.find(x => x.id === fromSelect.value);
    if (p) fromBal = p.cash;
  }
  fromHint.textContent = `Balance: ${formatMoney(fromBal, curr)}`;

  let toBal = 0;
  if (toSelect.value === "BANK") {
    toBal = STATE.game ? STATE.game.bank_balance : 0;
  } else {
    const p = STATE.players.find(x => x.id === toSelect.value);
    if (p) toBal = p.cash;
  }
  toHint.textContent = `Balance: ${formatMoney(toBal, curr)}`;

  validateTransferForm();
}

function autoSuggestDescription() {
  const fromSelect = document.getElementById("transfer-from-select");
  const toSelect = document.getElementById("transfer-to-select");
  const catSelect = document.getElementById("transfer-category-select");
  const descInput = document.getElementById("transfer-description");

  const fromName = fromSelect.value === "BANK" ? "Bank" : (STATE.players.find(p => p.id === fromSelect.value)?.name || "Payer");
  const toName = toSelect.value === "BANK" ? "Bank" : (STATE.players.find(p => p.id === toSelect.value)?.name || "Recipient");

  descInput.placeholder = `${catSelect.value}: ${fromName} -> ${toName}`;
}

function validateTransferForm() {
  const fromSelect = document.getElementById("transfer-from-select");
  const toSelect = document.getElementById("transfer-to-select");
  const amountInput = document.getElementById("transfer-amount");
  const valMsg = document.getElementById("transfer-validation-msg");
  const submitBtn = document.getElementById("btn-submit-transfer");

  const amount = parseInt(amountInput.value || "0", 10);
  valMsg.textContent = "";

  if (fromSelect.value === toSelect.value) {
    valMsg.textContent = "Payer and Recipient cannot be the same account";
    submitBtn.disabled = true;
    return false;
  }

  let fromBal = 0;
  if (fromSelect.value === "BANK") {
    fromBal = STATE.game ? STATE.game.bank_balance : 0;
    if (amount > fromBal) {
      valMsg.textContent = `Bank drawer has insufficient funds (Deficit: ${formatMoney(amount - fromBal, STATE.game?.currency)})`;
      submitBtn.disabled = true;
      return false;
    }
  } else {
    const p = STATE.players.find(x => x.id === fromSelect.value);
    fromBal = p ? p.cash : 0;
    if (amount > fromBal) {
      valMsg.textContent = `Insufficient cash (Player has ${formatMoney(fromBal, STATE.game?.currency)}, deficit ${formatMoney(amount - fromBal, STATE.game?.currency)})`;
      submitBtn.disabled = true;
      return false;
    }
  }

  submitBtn.disabled = false;
  return true;
}

// ==================== LEDGER TABLE ====================

function updateLedgerFilters() {
  const filterRound = document.getElementById("filter-round");
  const filterCategory = document.getElementById("filter-category");
  const filterPlayer = document.getElementById("filter-player");

  // Rounds
  const maxRound = STATE.game?.current_round || 0;
  let roundHtml = `<option value="">All Rounds</option>`;
  for (let r = 1; r <= maxRound; r++) {
    roundHtml += `<option value="${r}">Round ${r}</option>`;
  }
  filterRound.innerHTML = roundHtml;

  // Categories
  const cats = [...new Set(STATE.transactions.map(t => t.account_category))].sort();
  filterCategory.innerHTML = `<option value="">All Categories</option>` + cats.map(c => `<option value="${c}">${c}</option>`).join("");

  // Players
  let playerHtml = `<option value="">All Counterparties</option>`;
  STATE.players.forEach(p => {
    playerHtml += `<option value="${p.id}">👤 ${escapeHtml(p.name)}</option>`;
  });
  filterPlayer.innerHTML = playerHtml;
}

function renderLedger() {
  const tbody = document.getElementById("ledger-tbody");
  tbody.innerHTML = "";

  const rFilter = document.getElementById("filter-round").value;
  const cFilter = document.getElementById("filter-category").value;
  const pFilter = document.getElementById("filter-player").value;
  const showVoided = document.getElementById("filter-show-voided").checked;

  let txns = [...STATE.transactions];

  if (rFilter) txns = txns.filter(t => String(t.round) === rFilter);
  if (cFilter) txns = txns.filter(t => t.account_category === cFilter);
  if (!showVoided) txns = txns.filter(t => !t.voided_by_txn);
  if (pFilter) {
    txns = txns.filter(t => {
      return (t.entries || []).some(e => e.account_ref === pFilter);
    });
  }

  // Sort newest first
  txns.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

  document.getElementById("ledger-count-label").textContent = `${txns.length} transactions`;
  const tabLedgerCount = document.getElementById("tab-ledger-count");
  if (tabLedgerCount) tabLedgerCount.textContent = STATE.transactions.length;

  if (txns.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted p-4">No ledger transactions match current filters.</td></tr>`;
    return;
  }

  const curr = STATE.game?.currency || "₹";

  txns.forEach(t => {
    const isVoided = Boolean(t.voided_by_txn);

    // Extract Dr and Cr
    let drRef = "BANK", crRef = "BANK";
    (t.entries || []).forEach(e => {
      if (e.direction === "DR") drRef = e.account_ref;
      if (e.direction === "CR") crRef = e.account_ref;
    });

    const drName = drRef === "BANK" ? "🏛️ Bank" : (STATE.players.find(p => p.id === drRef)?.name || drRef);
    const crName = crRef === "BANK" ? "🏛️ Bank" : (STATE.players.find(p => p.id === crRef)?.name || crRef);

    const timeStr = t.created_at ? t.created_at.split("T")[1]?.substring(0, 8) : "";

    const tr = document.createElement("tr");
    if (isVoided) tr.className = "is-voided";

    tr.innerHTML = `
      <td class="text-xs text-muted">${timeStr}</td>
      <td><span class="badge badge-info">R${t.round}</span></td>
      <td><span class="category-tag cat-${t.account_category}">${t.account_category}</span></td>
      <td>
        <div class="flow-pill-container">
          <span class="counterparty-pill">${escapeHtml(drName)}</span>
          <span class="text-muted">➔</span>
          <span class="counterparty-pill">${escapeHtml(crName)}</span>
        </div>
      </td>
      <td style="text-align: right; font-weight: 700;">${formatMoney(t.amount, curr)}</td>
      <td class="text-xs text-muted">${escapeHtml(t.description || "-")}</td>
      <td style="text-align: center;">
        ${!isVoided && STATE.game?.status === "active" ? `
          <button class="btn btn-ghost btn-xs text-ruby btn-trigger-void" data-txid="${t.id}" data-amount="${formatMoney(t.amount, curr)}" data-cat="${t.account_category}" title="Void transaction">
            Void
          </button>
        ` : isVoided ? `<span class="badge badge-warning text-xs">Voided</span>` : "-"}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ==================== EVENT LISTENERS & WIRING ====================

function initEventListeners() {
  setupTransferTabs();

  // Mode Switch
  const modeBtn = document.getElementById("btn-toggle-mode");
  if (modeBtn) {
    modeBtn.addEventListener("click", () => {
      const nextMode = STATE.appMode === "banker" ? "player" : "banker";
      setAppMode(nextMode);
    });
  }

  // Player View Navigation
  const btnSwitchPlayer = document.getElementById("btn-switch-my-player");
  if (btnSwitchPlayer) {
    btnSwitchPlayer.addEventListener("click", switchMyPlayer);
  }

  const btnRefreshPassbook = document.getElementById("btn-refresh-passbook");
  if (btnRefreshPassbook) {
    btnRefreshPassbook.addEventListener("click", () => {
      if (STATE.myPlayerId) renderPlayerPassbook(STATE.myPlayerId);
    });
  }

  // Main View Navigation (Banker Console vs Ledger Book)
  const tabConsole = document.getElementById("tab-btn-console");
  const tabLedger = document.getElementById("tab-btn-ledger");
  const subviewConsole = document.getElementById("subview-console");
  const subviewLedger = document.getElementById("subview-ledger");

  const switchView = (view) => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (view === "ledger") {
      tabConsole?.classList.remove("active");
      tabLedger?.classList.add("active");
      if (subviewConsole) subviewConsole.style.display = "none";
      if (subviewLedger) subviewLedger.style.display = "flex";
      renderLedger();
    } else {
      tabLedger?.classList.remove("active");
      tabConsole?.classList.add("active");
      if (subviewLedger) subviewLedger.style.display = "none";
      if (subviewConsole) subviewConsole.style.display = "flex";
    }
  };

  tabConsole?.addEventListener("click", () => switchView("console"));
  tabLedger?.addEventListener("click", () => switchView("ledger"));

  // Navigation actions
  document.getElementById("btn-new-game-modal").addEventListener("click", () => openModal("modal-new-game"));
  document.getElementById("btn-empty-new-game").addEventListener("click", () => openModal("modal-new-game"));
  document.getElementById("btn-modal-create-game").addEventListener("click", () => {
    closeModal("modal-games-list");
    openModal("modal-new-game");
  });

  document.getElementById("btn-open-games-list").addEventListener("click", openGamesListModal);
  document.getElementById("btn-empty-select-game").addEventListener("click", openGamesListModal);
  document.getElementById("btn-switch-game").addEventListener("click", openGamesListModal);

  document.getElementById("btn-bank-info").addEventListener("click", openBankInfoModal);

  // Sound toggle
  document.getElementById("btn-toggle-sound").addEventListener("click", () => {
    STATE.soundEnabled = !STATE.soundEnabled;
    localStorage.setItem("banker_sound", STATE.soundEnabled ? "true" : "false");
    updateSoundIcons();
    showToast(STATE.soundEnabled ? "Audio cues enabled" : "Audio cues muted", "info", 1500);
  });
  updateSoundIcons();

  // Backup & Restore Modal
  document.getElementById("btn-backup").addEventListener("click", () => {
    openModal("modal-backup");
  });

  document.getElementById("btn-export-backup").addEventListener("click", async () => {
    try {
      await exportBackup();
      showToast("Backup downloaded. Open it here or on another device to restore.", "success", 4000);
    } catch (err) {
      console.error("Backup export failed:", err);
      showToast("Could not create backup: " + (err?.message || err), "error");
    }
  });

  document.getElementById("btn-import-backup").addEventListener("click", () => {
    document.getElementById("input-backup-file").click();
  });

  document.getElementById("input-backup-file").addEventListener("change", async e => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const confirmed = window.confirm(
      "Restoring replaces ALL current games in this browser with the backup contents.\n\nContinue?"
    );
    if (!confirmed) return;
    try {
      await importBackup(file);
      showToast("Backup restored! Reloading…", "success", 2000);
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      console.error("Backup restore failed:", err);
      showToast("Restore failed: " + (err?.message || err), "error");
    }
  });

  // Modal close buttons
  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });

  // Escape key closes open modals
  window.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-backdrop").forEach(m => m.style.display = "none");
    }
  });

  // Create Game Form
  document.getElementById("form-new-game").addEventListener("submit", async e => {
    e.preventDefault();
    const name = document.getElementById("new-game-name").value.trim();
    const startingCash = parseInt(document.getElementById("new-starting-cash").value, 10);
    const initialBank = parseInt(document.getElementById("new-bank-balance").value, 10);
    const salary = parseInt(document.getElementById("new-salary").value, 10);
    const currency = document.getElementById("new-currency").value.trim() || "₹";

    try {
      const game = await api("/games", {
        method: "POST",
        body: {
          name,
          starting_cash: startingCash,
          initial_bank_balance: initialBank,
          salary_per_round: salary,
          currency
        }
      });
      closeModal("modal-new-game");
      showToast(`Game "${game.name}" created!`, "success");
      loadGame(game.id);
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Add Player Form
  document.getElementById("form-add-player").addEventListener("submit", async e => {
    e.preventDefault();
    const nameInput = document.getElementById("input-player-name");
    const name = nameInput.value.trim();
    if (!name || !STATE.currentGameId) return;

    const nextSeat = deriveNextSeat(STATE.players);

    try {
      await api(`/games/${STATE.currentGameId}/players`, {
        method: "POST",
        body: { name, seat: nextSeat }
      });
      nameInput.value = "";
      showToast(`Seated ${name} at Seat ${nextSeat}`, "success");
      await refreshActiveGame();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Remove Player
  document.getElementById("lobby-players-list").addEventListener("click", async e => {
    const btn = e.target.closest(".btn-remove-player");
    if (!btn) return;
    const pid = btn.dataset.pid;

    try {
      await api(`/games/${STATE.currentGameId}/players/${pid}`, { method: "DELETE" });
      showToast("Player removed", "info");
      await refreshActiveGame();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Start Game
  document.getElementById("btn-start-game").addEventListener("click", async () => {
    if (STATE.players.length === 0) {
      showToast("Seat at least 1 player before starting!", "error");
      return;
    }

    try {
      await api(`/games/${STATE.currentGameId}/start`, { method: "POST" });
      synth.playRoundBell();
      showToast("Game started! Starting cash distributed.", "success");
      await refreshActiveGame();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Next Round Button
  document.getElementById("btn-next-round").addEventListener("click", async () => {
    if (!STATE.currentGameId) return;

    try {
      const nextRound = (STATE.game.current_round || 0) + 1;
      const idemKey = generateIdemKey(`round-${nextRound}`);

      await api(`/games/${STATE.currentGameId}/rounds`, {
        method: "POST",
        headers: { "Idempotency-Key": idemKey }
      });

      synth.playRoundBell();
      showToast(`Round ${nextRound} started! Salary paid to all active players.`, "success");
      await refreshActiveGame();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Quick Amount Chips
  document.querySelectorAll(".quick-amount-chips .chip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const amountInput = document.getElementById("transfer-amount");
      if (btn.classList.contains("chip-clear")) {
        amountInput.value = "";
      } else {
        const add = parseInt(btn.dataset.add, 10) || 0;
        const current = parseInt(amountInput.value || "0", 10);
        amountInput.value = current + add;
      }
      validateTransferForm();
    });
  });

  // Dynamic updates on transfer inputs
  document.getElementById("transfer-from-select").addEventListener("change", () => {
    updateBalanceHints();
    autoSuggestDescription();
  });
  document.getElementById("transfer-to-select").addEventListener("change", () => {
    updateBalanceHints();
    autoSuggestDescription();
  });
  document.getElementById("transfer-category-select").addEventListener("change", () => {
    autoSuggestDescription();
  });
  document.getElementById("transfer-amount").addEventListener("input", validateTransferForm);

  // Submit Transfer Form
  document.getElementById("form-transfer").addEventListener("submit", async e => {
    e.preventDefault();
    if (!validateTransferForm()) return;

    const fromVal = document.getElementById("transfer-from-select").value;
    const toVal = document.getElementById("transfer-to-select").value;
    const cat = document.getElementById("transfer-category-select").value;
    const amount = parseInt(document.getElementById("transfer-amount").value, 10);
    const descInput = document.getElementById("transfer-description");
    const desc = descInput.value.trim() || descInput.placeholder;

    const fromAccount = fromVal === "BANK"
      ? { type: "bank", id: "BANK" }
      : { type: "player", id: fromVal };

    const toAccount = toVal === "BANK"
      ? { type: "bank", id: "BANK" }
      : { type: "player", id: toVal };

    const idemKey = generateIdemKey("transfer");

    try {
      await api(`/games/${STATE.currentGameId}/transfers`, {
        method: "POST",
        headers: { "Idempotency-Key": idemKey },
        body: {
          from: fromAccount,
          to: toAccount,
          amount,
          account_category: cat,
          description: desc
        }
      });

      synth.playCoin();
      showToast(`Transferred ${formatMoney(amount, STATE.game?.currency)} (${cat})`, "success");
      document.getElementById("transfer-amount").value = "";
      descInput.value = "";
      await refreshActiveGame();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Player Grid delegation (Pay, Receive, Statement, Bankrupt)
  document.getElementById("player-cards-grid").addEventListener("click", async e => {
    const payBtn = e.target.closest(".btn-player-pay");
    if (payBtn) {
      const pid = payBtn.dataset.pid;
      document.getElementById("transfer-from-select").value = pid;
      updateBalanceHints();
      autoSuggestDescription();
      document.getElementById("transfer-card").scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => document.getElementById("transfer-amount").focus(), 250);
      return;
    }

    const rcvBtn = e.target.closest(".btn-player-rcv");
    if (rcvBtn) {
      const pid = rcvBtn.dataset.pid;
      document.getElementById("transfer-to-select").value = pid;
      updateBalanceHints();
      autoSuggestDescription();
      document.getElementById("transfer-card").scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => document.getElementById("transfer-amount").focus(), 250);
      return;
    }

    const stmtBtn = e.target.closest(".btn-player-stmt");
    if (stmtBtn) {
      openPlayerStatement(stmtBtn.dataset.pid);
      return;
    }

    const brkBtn = e.target.closest(".btn-trigger-bankrupt");
    if (brkBtn) {
      STATE.pendingBankruptPid = brkBtn.dataset.pid;
      document.getElementById("bankrupt-player-name").textContent = brkBtn.dataset.name;
      openModal("modal-confirm-bankrupt");
      return;
    }
  });

  // Execute Bankruptcy
  document.getElementById("btn-execute-bankrupt").addEventListener("click", async () => {
    if (!STATE.pendingBankruptPid || !STATE.currentGameId) return;

    try {
      await api(`/games/${STATE.currentGameId}/players/${STATE.pendingBankruptPid}/bankrupt`, {
        method: "POST"
      });
      synth.playVoid();
      closeModal("modal-confirm-bankrupt");
      showToast("Player declared bankrupt and remaining cash swept to Bank", "info");
      await refreshActiveGame();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Ledger Void Trigger
  document.getElementById("ledger-tbody").addEventListener("click", e => {
    const btn = e.target.closest(".btn-trigger-void");
    if (!btn) return;

    STATE.pendingVoidTxnId = btn.dataset.txid;
    document.getElementById("void-preview-info").innerHTML = `
      <div><strong>Txn ID:</strong> <code>${btn.dataset.txid}</code></div>
      <div><strong>Category:</strong> ${btn.dataset.cat}</div>
      <div><strong>Amount:</strong> ${btn.dataset.amount}</div>
    `;
    openModal("modal-confirm-void");
  });

  // Execute Void
  document.getElementById("btn-execute-void").addEventListener("click", async () => {
    if (!STATE.pendingVoidTxnId || !STATE.currentGameId) return;

    try {
      await api(`/games/${STATE.currentGameId}/transfers/${STATE.pendingVoidTxnId}/void`, {
        method: "POST"
      });
      synth.playVoid();
      closeModal("modal-confirm-void");
      showToast("Transaction voided with reversal entry!", "success");
      await refreshActiveGame();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Ledger Filter changes
  document.getElementById("filter-round").addEventListener("change", renderLedger);
  document.getElementById("filter-category").addEventListener("change", renderLedger);
  document.getElementById("filter-player").addEventListener("change", renderLedger);
  document.getElementById("filter-show-voided").addEventListener("change", renderLedger);

  // Edit Round Salary
  document.getElementById("btn-patch-salary").addEventListener("click", () => {
    if (!STATE.game) return;
    document.getElementById("patch-salary-input").value = STATE.game.salary_per_round;
    openModal("modal-patch-salary");
  });

  document.getElementById("form-patch-salary").addEventListener("submit", async e => {
    e.preventDefault();
    const newSalary = parseInt(document.getElementById("patch-salary-input").value, 10);
    try {
      await api(`/games/${STATE.currentGameId}`, {
        method: "PATCH",
        body: { round_salary: newSalary }
      });
      closeModal("modal-patch-salary");
      showToast(`Round salary updated to ${formatMoney(newSalary, STATE.game?.currency)}`, "success");
      await refreshActiveGame();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Finish Game
  document.getElementById("btn-finish-game").addEventListener("click", async () => {
    if (!confirm("Are you sure you want to finish this game? The ledger will become read-only.")) return;
    try {
      await api(`/games/${STATE.currentGameId}/finish`, { method: "POST" });
      showToast("Game finished and archived!", "info");
      await refreshActiveGame();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Export CSV
  const triggerExport = () => {
    if (!STATE.currentGameId) return;
    downloadGameCsv(STATE.currentGameId);
  };
  document.getElementById("btn-export-csv").addEventListener("click", triggerExport);
  document.getElementById("btn-export-csv-banner").addEventListener("click", triggerExport);
  document.getElementById("btn-export-csv-tab")?.addEventListener("click", triggerExport);
}

// ==================== MODAL HELPERS ====================

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = "flex";
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = "none";
}

async function openGamesListModal() {
  openModal("modal-games-list");
  const container = document.getElementById("games-list-container");
  container.innerHTML = `<div class="text-muted text-center p-4">Loading game sessions...</div>`;

  try {
    const data = await api("/games");
    const games = data.games || [];

    if (games.length === 0) {
      container.innerHTML = `<div class="text-muted text-center p-4">No games found. Click "+ New Game" to start one!</div>`;
      return;
    }

    renderGamesList(games);

    // Search filter
    document.getElementById("search-games").oninput = e => {
      const q = e.target.value.toLowerCase();
      const filtered = games.filter(g => g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q));
      renderGamesList(filtered);
    };
  } catch (err) {
    container.innerHTML = `<div class="text-ruby text-center p-4">${err.message}</div>`;
  }
}

function renderGamesList(games) {
  const container = document.getElementById("games-list-container");
  container.innerHTML = "";

  games.forEach(g => {
    const isCurrent = g.id === STATE.currentGameId;
    const item = document.createElement("div");
    item.className = "lobby-player-row mb-2";
    item.style.marginBottom = "8px";
    item.innerHTML = `
      <div>
        <strong style="color: #fff;">${escapeHtml(g.name)}</strong>
        <span class="status-badge ${g.status} ml-2">${g.status.toUpperCase()}</span>
        <div class="text-xs text-muted">Round ${g.current_round} • Drawer: ${formatMoney(g.bank_balance, g.currency)}</div>
      </div>
      <button class="btn ${isCurrent ? "btn-emerald" : "btn-secondary"} btn-xs btn-pick-game" data-gid="${g.id}">
        ${isCurrent ? "Current" : "Open"}
      </button>
    `;
    item.querySelector(".btn-pick-game").addEventListener("click", () => {
      closeModal("modal-games-list");
      loadGame(g.id);
    });
    container.appendChild(item);
  });
}

async function openBankInfoModal() {
  if (!STATE.currentGameId) return;
  openModal("modal-bank-info");

  try {
    const info = await api(`/games/${STATE.currentGameId}/bank`);
    const curr = STATE.game?.currency || "₹";
    document.getElementById("modal-bank-drawer-cash").textContent = formatMoney(info.bank_balance, curr);
    document.getElementById("modal-bank-active-players").textContent = info.active_players || 0;
    document.getElementById("modal-bank-bankrupt-players").textContent = info.bankrupt_players || 0;
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function openPlayerStatement(pid) {
  const p = STATE.players.find(x => x.id === pid);
  if (!p || !STATE.currentGameId) return;

  const curr = STATE.game?.currency || "₹";
  document.getElementById("stmt-player-name").textContent = `${p.name}'s Statement`;
  document.getElementById("stmt-player-balance").textContent = `Current Balance: ${formatMoney(p.cash, curr)}`;

  openModal("modal-player-statement");
  const tbody = document.getElementById("stmt-tbody");
  tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted p-4">Loading statement...</td></tr>`;

  try {
    const res = await api(`/games/${STATE.currentGameId}/players/${pid}/ledger`);
    const rows = res.statement || [];

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted p-4">No transactions on record for this player.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    rows.forEach(r => {
      const timeStr = r.created_at ? r.created_at.split("T")[1]?.substring(0, 8) : "";
      const tr = document.createElement("tr");
      if (r.voided) tr.className = "is-voided";

      tr.innerHTML = `
        <td class="text-xs text-muted">${timeStr}</td>
        <td><span class="badge badge-info">R${r.round}</span></td>
        <td><span class="category-tag cat-${r.account_category}">${r.account_category}</span></td>
        <td><span class="counterparty-pill">${escapeHtml(r.counterparty || "-")}</span></td>
        <td style="text-align: right;" class="${r.dr > 0 ? "amount-dr" : "text-dim"}">${r.dr > 0 ? formatMoney(r.dr, curr) : "-"}</td>
        <td style="text-align: right;" class="${r.cr > 0 ? "amount-cr" : "text-dim"}">${r.cr > 0 ? formatMoney(r.cr, curr) : "-"}</td>
        <td class="text-xs text-muted">${escapeHtml(r.description || "-")}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-ruby text-center p-4">${err.message}</td></tr>`;
  }
}

function updateSoundIcons() {
  const iconOn = document.getElementById("sound-icon-on");
  const iconOff = document.getElementById("sound-icon-off");
  if (STATE.soundEnabled) {
    iconOn.style.display = "block";
    iconOff.style.display = "none";
  } else {
    iconOn.style.display = "none";
    iconOff.style.display = "block";
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ==================== APP BOOTSTRAP ====================

async function loadFallbackGame() {
  try {
    const res = await api("/games");
    const games = res.games || [];
    if (games.length > 0) {
      await loadGame(games[0].id);
    } else {
      renderEmptyView();
    }
  } catch (_) {
    renderEmptyView();
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  initEventListeners();

  const urlParams = new URLSearchParams(window.location.search);
  const modeParam = urlParams.get("mode");
  const gameParam = urlParams.get("game");
  const playerParam = urlParams.get("player");

  // Determine initial mode: URL param overrides localStorage
  const savedMode = localStorage.getItem("banker_app_mode");
  const initialMode = modeParam ? modeParam : (savedMode || "banker");
  STATE.appMode = initialMode;

  // Determine game to load: URL param overrides localStorage
  let targetGameId = gameParam || localStorage.getItem("banker_last_game_id");

  // If player param specified in URL, set myPlayerId
  if (playerParam) {
    STATE.myPlayerId = playerParam;
    if (targetGameId) {
      localStorage.setItem("banker_player_id_" + targetGameId, playerParam);
    }
  }

  if (targetGameId) {
    try {
      await loadGame(targetGameId);
    } catch (_) {
      await loadFallbackGame();
    }
  } else {
    await loadFallbackGame();
  }
});

// ==================== OFFLINE (SERVICE WORKER) ====================

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
