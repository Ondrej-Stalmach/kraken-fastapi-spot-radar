const POLL_INTERVAL_MS = 10000;
const STALE_AFTER_MS = 30000;

const state = {
    rows: [],
    loading: false,
};

const elements = {
    connectionState: document.querySelector("#connectionState"),
    statusDot: document.querySelector("#statusDot"),
    trackedCount: document.querySelector("#trackedCount"),
    positiveCount: document.querySelector("#positiveCount"),
    negativeCount: document.querySelector("#negativeCount"),
    lastUpdated: document.querySelector("#lastUpdated"),
    gainerRows: document.querySelector("#gainerRows"),
    loserRows: document.querySelector("#loserRows"),
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

function formatPercent(value) {
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
        target.innerHTML = '<tr><td class="empty-state" colspan="4">No market data</td></tr>';
        return;
    }

    target.innerHTML = rows.map((row) => {
        const change = Number(row.oc);
        const movementClass = change > 0 ? "positive" : change < 0 ? "negative" : "";

        return `
            <tr>
                <td class="symbol-cell">${escapeHtml(row.symbol)}</td>
                <td class="number-cell" data-label="Open price">${formatPrice(row.openPrice)}</td>
                <td class="number-cell" data-label="Last price">${formatPrice(row.currentPrice)}</td>
                <td class="oc-cell ${movementClass}">${formatPercent(change)}</td>
            </tr>
        `;
    }).join("");
}

function render() {
    const gainers = getTopRows(state.rows, true);
    const losers = getTopRows(state.rows, false);
    const positiveRows = state.rows.filter((row) => Number(row.oc) > 0).length;
    const negativeRows = state.rows.filter((row) => Number(row.oc) < 0).length;

    elements.trackedCount.textContent = state.rows.length.toLocaleString("en-US");
    elements.positiveCount.textContent = positiveRows.toLocaleString("en-US");
    elements.negativeCount.textContent = negativeRows.toLocaleString("en-US");
    renderRows(gainers, elements.gainerRows);
    renderRows(losers, elements.loserRows);
}

function setConnectionState(label, stateClass) {
    elements.connectionState.textContent = label;
    elements.statusDot.className = `live-dot ${stateClass}`;
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
        state.rows = Array.isArray(payload.data) ? payload.data : [];
        render();

        const updatedAt = payload.updatedAt ? new Date(payload.updatedAt) : null;
        const hasValidTimestamp = updatedAt && Number.isFinite(updatedAt.getTime());
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

render();
loadTickers();
window.setInterval(loadTickers, POLL_INTERVAL_MS);