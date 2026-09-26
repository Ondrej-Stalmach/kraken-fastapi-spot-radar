import asyncio
import logging
from collections import deque
from contextlib import asynccontextmanager, suppress
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
from connector_kraken import KrakenAPIError, KrakenClient
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

TICKERS_REFRESH_INTERVAL_SECONDS = 10
HTTP_TIMEOUT_SECONDS = 10
FIVE_MINUTE_WINDOW = timedelta(minutes=5)
MAX_PRICE_SAMPLE_GAP = timedelta(seconds=TICKERS_REFRESH_INTERVAL_SECONDS * 2)

_ticker_data: list[dict[str, object]] = []
_price_history: dict[str, deque[tuple[datetime, float]]] = {}
_last_updated_at: datetime | None = None
_online_spot_pairs: set[str] = set()
_online_pairs_updated_on: date | None = None
_http_client: httpx.AsyncClient | None = None
_refresh_lock: asyncio.Lock | None = None

logger = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).with_name("static")


async def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS)
    return _http_client


def _record_price_and_calculate_five_minute_delta(
    history: deque[tuple[datetime, float]],
    price: float,
    observed_at: datetime,
) -> float | None:
    history.append((observed_at, price))
    comparison_at = observed_at - FIVE_MINUTE_WINDOW

    while len(history) > 1 and history[1][0] <= comparison_at:
        history.popleft()

    if not history or history[0][0] > comparison_at:
        return None

    sample_at, baseline_price = history[0]
    if baseline_price <= 0 or comparison_at - sample_at > MAX_PRICE_SAMPLE_GAP:
        return None

    return float(round((price - baseline_price) / baseline_price * 100, 2))


async def refresh_ticker_data() -> list[dict[str, object]]:
    global _ticker_data, _last_updated_at, _refresh_lock
    global _online_spot_pairs, _online_pairs_updated_on

    client = await get_http_client()
    if _refresh_lock is None:
        _refresh_lock = asyncio.Lock()

    async with _refresh_lock:
        kraken_client = KrakenClient(client)
        current_date = datetime.now(timezone.utc).date()
        if _online_pairs_updated_on != current_date:
            trading_pairs = await kraken_client.get_spot_trading_pairs()
            _online_spot_pairs = {
                pair.upper().replace("/", "") for pair in trading_pairs
            }
            _online_pairs_updated_on = current_date

        spot_tickers = await kraken_client.get_spot_tickers()
        observed_at = datetime.now(timezone.utc)
        ticker_data: list[dict[str, object]] = []
        for ticker in spot_tickers:
            if ticker["pair"].upper().replace("/", "") not in _online_spot_pairs:
                continue

            open_price = ticker["open"]
            current_price = ticker["close_price"]
            if open_price <= 0 or current_price < 0:
                continue

            current_price_value = float(current_price)
            history = _price_history.setdefault(ticker["pair"], deque())
            delta_5m = _record_price_and_calculate_five_minute_delta(
                history, current_price_value, observed_at
            )
            ticker_data.append(
                {
                    "symbol": ticker["pair"],
                    "openPrice": float(open_price),
                    "currentPrice": current_price_value,
                    "volumeUsdToday": ticker["volume_usd_today_thousands"] * 1000,
                    "delta5m": delta_5m,
                    "oc": float(
                        round((current_price - open_price) / open_price * 100, 2)
                    ),
                }
            )

        _ticker_data = ticker_data
        _last_updated_at = observed_at
        return list(_ticker_data)


async def refresh_ticker_data_periodically() -> None:
    while True:
        try:
            await refresh_ticker_data()
        except Exception:
            logger.exception("Failed to refresh Kraken ticker data")

        await asyncio.sleep(TICKERS_REFRESH_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _http_client, _last_updated_at, _refresh_lock, _ticker_data
    global _online_spot_pairs, _online_pairs_updated_on, _price_history

    _ticker_data = []
    _price_history = {}
    _last_updated_at = None
    _online_spot_pairs = set()
    _online_pairs_updated_on = None
    _http_client = httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS)
    _refresh_lock = asyncio.Lock()
    refresh_task = asyncio.create_task(refresh_ticker_data_periodically())

    try:
        yield
    finally:
        refresh_task.cancel()
        with suppress(asyncio.CancelledError):
            await refresh_task
        if _http_client is not None and not _http_client.is_closed:
            await _http_client.aclose()
        _http_client = None
        _refresh_lock = None


app = FastAPI(
    title="Kraken Spot Radar",
    version="0.1.0",
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def read_dashboard():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def read_health():
    return {
        "status": "ok",
        "exchange": "kraken",
        "lastUpdated": _last_updated_at.isoformat() if _last_updated_at else None,
    }


@app.get("/kraken-tickers")
async def read_kraken_tickers():
    if not _ticker_data:
        try:
            await refresh_ticker_data()
        except (KrakenAPIError, httpx.HTTPError, ValueError) as err:
            raise HTTPException(status_code=502, detail=str(err)) from err

    return {
        "count": len(_ticker_data),
        "data": list(_ticker_data),
        "updatedAt": _last_updated_at.isoformat() if _last_updated_at else None,
    }
