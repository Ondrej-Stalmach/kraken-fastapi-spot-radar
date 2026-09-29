const POLL_INTERVAL_MS = 10000;
const STALE_AFTER_MS = 30000;
const SIGNALS_STORAGE_KEY = "kraken-spot-radar:signals:v1";
const ACTIVE_SIGNAL_KEYS_STORAGE_KEY = "kraken-spot-radar:active-signals:v1";
const MAX_SAVED_SIGNALS = 100;
const ALERT_DELTA_THRESHOLD = 3;
const CONNECTION_CHIP_CLASSES = {
    "is-live": "chip-live",
    "is-partial": "chip-warning",
    "is-error": "chip-error",
};

const savedSignals = loadSavedSignals();

const state = {
    rows: [],
    loading: false,
    activeSignalKeys: loadActiveSignalKeys(),
    hasLoadedSnapshot: false,
    signals: savedSignals,
    audioContext: null,
    soundEnabled: false,
};

const elements = {
    connectionState: document.querySelector("#connectionState"),
    statusDot: document.querySelector("#statusDot"),
    connectionChip: document.querySelector("#connectionChip"),
    trackedCount: document.querySelector("#trackedCount"),
    positiveCount: document.querySelector("#positiveCount"),
    negativeCount: document.querySelector("#negativeCount"),
    lastUpdated: document.querySelector("#lastUpdated"),
    gainerRows: document.querySelector("#gainerRows"),
    loserRows: document.querySelector("#loserRows"),
    signalsToggle: document.querySelector("#signalsToggle"),
    signalCount: document.querySelector("#signalCount"),
    signalsSidebar: document.querySelector("#signalsSidebar"),
    closeSignals: document.querySelector("#closeSignals"),
    sidebarBackdrop: document.querySelector("#sidebarBackdrop"),
    signalsEmpty: document.querySelector("#signalsEmpty"),
    signalList: document.querySelector("#signalList"),
    soundToggle: document.querySelector("#soundToggle"),
};

function formatPrice(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return "--";
    }

    const absolute = Math.abs(number);
    const maximumFractionDigits = absolute >= 1000 ? 2 : absolute >= 1 ? 4 : 8;
    return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(number);
}

function formatUsdVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return "--";
    }

    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: 2,
    }).format(number);
}

function formatPercent(value) {
    if (value === null || value === undefined || value === "") {
        return "--";
    }

    const number = Number(value);
    if (!Number.isFinite(number)) {
        return "--";
    }

    const sign = number > 0 ? "+" : "";
    return `${sign}${number.toFixed(2)}%`;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function loadSavedSignals() {
    try {
        const stored = window.localStorage.getItem(SIGNALS_STORAGE_KEY);
        const signals = stored ? JSON.parse(stored) : [];
        if (!Array.isArray(signals)) {
            return [];
        }

        return signals.filter((signal) => (
            signal
            && typeof signal.symbol === "string"
            && ["gainer", "loser"].includes(signal.direction)
            && Number.isFinite(signal.delta5m)
            && typeof signal.timestamp === "string"
            && Number.isFinite(new Date(signal.timestamp).getTime())
        )).slice(0, MAX_SAVED_SIGNALS);
    } catch {
        return [];
    }
}

function loadActiveSignalKeys() {
    const legacySignalKeys = new Set(
        savedSignals.map((signal) => `${signal.direction}:${signal.symbol}`),
    );

    try {
        const stored = window.localStorage.getItem(ACTIVE_SIGNAL_KEYS_STORAGE_KEY);
        if (stored === null) {
            return legacySignalKeys;
        }

        const keys = JSON.parse(stored);
        if (!Array.isArray(keys)) {
            return legacySignalKeys;
        }

        return new Set(keys.filter((key) => typeof key === "string"));
    } catch {
        return legacySignalKeys;
    }
}

function saveSignals() {
    try {
        window.localStorage.setItem(SIGNALS_STORAGE_KEY, JSON.stringify(state.signals));
    } catch (error) {
        console.warn("Unable to save signal history", error);
    }
}

function saveActiveSignalKeys() {
    try {
        window.localStorage.setItem(
            ACTIVE_SIGNAL_KEYS_STORAGE_KEY,
            JSON.stringify([...state.activeSignalKeys]),
        );
    } catch (error) {
        console.warn("Unable to save active signal state", error);
    }
}

function renderEmptyRow(message, withSpinner = false) {
    const spinner = withSpinner ? '<div class="spinner" role="presentation"></div>' : "";
    return `<tr><td class="empty-state" colspan="6"><div class="empty-loader">${spinner}<span>${escapeHtml(message)}</span></div></td></tr>`;
}

function renderLoadingRows() {
    const row = renderEmptyRow("Loading market data...", true);
    elements.gainerRows.innerHTML = row;
    elements.loserRows.innerHTML = row;
}

function formatSignalTime(value) {
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) {
        return "--";
    }

    return timestamp.toLocaleString(undefined, {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function renderSignals() {
    const hasSignals = state.signals.length > 0;
    elements.signalCount.textContent = state.signals.length.toLocaleString("en-US");
    elements.signalsEmpty.hidden = hasSignals;
    elements.signalList.hidden = !hasSignals;
    elements.signalList.innerHTML = state.signals.map((signal) => {
        const direction = signal.direction === "gainer" ? "gainer" : "loser";
        const movement = signal.delta5m > 0 ? "positive" : "negative";

        return `
            <li class="signal-entry signal-${direction}">
                <div class="signal-entry-heading">
                    <strong class="signal-pair">${escapeHtml(signal.symbol)}</strong>
                    <time datetime="${escapeHtml(signal.timestamp)}">${escapeHtml(formatSignalTime(signal.timestamp))}</time>
                </div>
                <div class="signal-entry-detail">
                    <span class="signal-direction ${direction}">TOP ${direction.toUpperCase()}</span>
                    <strong class="signal-delta ${movement}">${formatPercent(signal.delta5m)}</strong>
                </div>
            </li>
        `;
    }).join("");
}

function getTopRows(rows, descending) {
    return rows
        .filter((row) => {
            const change = Number(row.oc);
            return Number.isFinite(change) && (descending ? change > 0 : change < 0);
        })
        .sort((first, second) => {
            const difference = Number(first.oc) - Number(second.oc);
            return descending ? -difference : difference;
        })
        .slice(0, 10);
}

function renderRows(rows, target) {
    if (!rows.length) {
        target.innerHTML = renderEmptyRow("No market data");
        return;
    }

    target.innerHTML = rows.map((row) => {
        const change = Number(row.oc);
        const movementClass = change > 0 ? "positive" : change < 0 ? "negative" : "";
        const delta5m = row.delta5m === null || row.delta5m === undefined
            ? NaN
            : Number(row.delta5m);
        const deltaMovementClass = delta5m > 0 ? "positive" : delta5m < 0 ? "negative" : "";

        return `
            <tr>
                <td class="symbol-cell">
                    <span class="pair-badge">${escapeHtml(row.symbol)}</span>
                </td>
                <td class="number-cell" data-label="Open price">${formatPrice(row.openPrice)}</td>
                <td class="number-cell" data-label="Last price">${formatPrice(row.currentPrice)}</td>
                <td class="number-cell volume-cell" data-label="Volume">${formatUsdVolume(row.volumeUsdToday)}</td>
                <td class="oc-cell ${movementClass}" data-label="OC">
                    <span class="pill-badge ${movementClass}">${formatPercent(change)}</span>
                </td>
                <td class="number-cell delta5m-cell ${deltaMovementClass}" data-label="5m delta">
                    <span class="pill-badge ${deltaMovementClass}">${formatPercent(row.delta5m)}</span>
                </td>
            </tr>
        `;
    }).join("");
}

function updateSignalHistory(gainers, losers, snapshotTime) {
    const activeSignalKeys = new Set();
    const newSignals = [];
    const timestamp = Number.isFinite(snapshotTime.getTime())
        ? snapshotTime.toISOString()
        : new Date().toISOString();
    const candidates = [
        ...gainers.map((row) => ({ row, direction: "gainer" })),
        ...losers.map((row) => ({ row, direction: "loser" })),
    ];

    for (const candidate of candidates) {
        const delta5m = candidate.row.delta5m === null || candidate.row.delta5m === undefined
            ? NaN
            : Number(candidate.row.delta5m);
        const crossedThreshold = candidate.direction === "gainer"
            ? delta5m > ALERT_DELTA_THRESHOLD
            : delta5m < -ALERT_DELTA_THRESHOLD;
        if (!crossedThreshold) {
            continue;
        }

        const key = `${candidate.direction}:${candidate.row.symbol}`;
        activeSignalKeys.add(key);
        if (!state.activeSignalKeys.has(key)) {
            newSignals.push({
                symbol: String(candidate.row.symbol),
                direction: candidate.direction,
                delta5m,
                timestamp,
            });
        }
    }

    state.activeSignalKeys = activeSignalKeys;
    if (newSignals.length) {
        state.signals = [...newSignals.reverse(), ...state.signals].slice(0, MAX_SAVED_SIGNALS);
        saveSignals();
        playAlertSound();
    }
    saveActiveSignalKeys();

    renderSignals();
}

function render(snapshotTime = new Date()) {
    const gainers = getTopRows(state.rows, true);
    const losers = getTopRows(state.rows, false);
    const positiveRows = state.rows.filter((row) => Number(row.oc) > 0).length;
    const negativeRows = state.rows.filter((row) => Number(row.oc) < 0).length;

    elements.trackedCount.textContent = state.rows.length.toLocaleString("en-US");
    elements.positiveCount.textContent = positiveRows.toLocaleString("en-US");
    elements.negativeCount.textContent = negativeRows.toLocaleString("en-US");
    renderRows(gainers, elements.gainerRows);
    renderRows(losers, elements.loserRows);
    if (state.hasLoadedSnapshot) {
        updateSignalHistory(gainers, losers, snapshotTime);
    } else {
        renderSignals();
    }
}

function setConnectionState(label, stateClass) {
    elements.connectionState.textContent = label;
    elements.statusDot.className = `live-dot ${stateClass}`;

    const connectionChip = elements.connectionChip;
    if (!connectionChip) {
        return;
    }

    const chipClass = CONNECTION_CHIP_CLASSES[stateClass] ?? "chip-live";
    connectionChip.className = `stat-chip ${chipClass}`;
    connectionChip.textContent = label;
}

function setSignalsPanelOpen(isOpen) {
    elements.signalsSidebar.classList.toggle("is-open", isOpen);
    elements.signalsSidebar.setAttribute("aria-hidden", String(!isOpen));
    elements.signalsSidebar.toggleAttribute("inert", !isOpen);
    if (elements.sidebarBackdrop) {
        elements.sidebarBackdrop.classList.toggle("is-open", isOpen);
    }
    elements.signalsToggle.setAttribute("aria-expanded", String(isOpen));
    elements.signalsToggle.setAttribute(
        "aria-label",
        isOpen ? "Close signal history" : "Open signal history",
    );

    if (isOpen) {
        elements.closeSignals.focus();
    } else {
        elements.signalsToggle.focus();
    }
}

async function toggleSound() {
    if (state.soundEnabled) {
        state.soundEnabled = false;
        elements.soundToggle.textContent = "Sound off";
        elements.soundToggle.setAttribute("aria-pressed", "false");
        return;
    }

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
        elements.soundToggle.textContent = "Audio unavailable";
        elements.soundToggle.disabled = true;
        return;
    }

    try {
        state.audioContext ??= new AudioContextConstructor();
        await state.audioContext.resume();
        state.soundEnabled = state.audioContext.state === "running";
    } catch (error) {
        console.warn("Unable to enable sound alerts", error);
        state.soundEnabled = false;
    }

    elements.soundToggle.textContent = state.soundEnabled ? "Sound on" : "Sound off";
    elements.soundToggle.setAttribute("aria-pressed", String(state.soundEnabled));
}

function playAlertSound() {
    const audioContext = state.audioContext;
    if (!state.soundEnabled || !audioContext || audioContext.state !== "running") {
        return;
    }

    [880, 660].forEach((frequency, index) => {
        const startAt = audioContext.currentTime + index * 0.2;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.linearRampToValueAtTime(0.16, startAt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.17);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + 0.18);
    });
}

async function loadTickers() {
    if (state.loading) {
        return;
    }

    state.loading = true;

    try {
        const response = await fetch("/kraken-tickers", { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`Kraken ticker request failed with ${response.status}`);
        }

        const payload = await response.json();
        const updatedAt = payload.updatedAt ? new Date(payload.updatedAt) : null;
        const hasValidTimestamp = updatedAt && Number.isFinite(updatedAt.getTime());
        state.rows = Array.isArray(payload.data) ? payload.data : [];
        state.hasLoadedSnapshot = true;
        render(hasValidTimestamp ? updatedAt : new Date());

        const isStale = !hasValidTimestamp || Date.now() - updatedAt.getTime() > STALE_AFTER_MS;
        if (hasValidTimestamp) {
            const label = isStale ? "Last data" : "Updated";
            elements.lastUpdated.textContent = `${label} ${updatedAt.toLocaleTimeString()}`;
        }

        setConnectionState(isStale ? "Stale" : "Live", isStale ? "is-partial" : "is-live");
    } catch (error) {
        console.error(error);
        setConnectionState("Retrying", "is-error");
    } finally {
        state.loading = false;
    }
}

elements.signalsToggle.addEventListener("click", () => {
    const isOpen = elements.signalsSidebar.classList.contains("is-open");
    setSignalsPanelOpen(!isOpen);
});
elements.closeSignals.addEventListener("click", () => setSignalsPanelOpen(false));
elements.sidebarBackdrop?.addEventListener("click", () => setSignalsPanelOpen(false));
elements.soundToggle.addEventListener("click", () => {
    void toggleSound();
});
window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.signalsSidebar.classList.contains("is-open")) {
        setSignalsPanelOpen(false);
    }
});

document.querySelectorAll("[data-poll-seconds]").forEach((node) => {
    node.textContent = `${POLL_INTERVAL_MS / 1000}s`;
});

renderLoadingRows();
render();
loadTickers();
window.setInterval(loadTickers, POLL_INTERVAL_MS);