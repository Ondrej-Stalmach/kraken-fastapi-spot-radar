import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
from connector_kraken import KrakenAPIError, KrakenClient
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

TICKERS_REFRESH_INTERVAL_SECONDS = 10
HTTP_TIMEOUT_SECONDS = 10

_ticker_data: list[dict[str, object]] = []
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
        ticker_data: list[dict[str, object]] = []
        for ticker in spot_tickers:
            if ticker["pair"].upper().replace("/", "") not in _online_spot_pairs:
                continue

            open_price = ticker["open"]
            current_price = ticker["close_price"]
            if open_price <= 0 or current_price < 0:
                continue

            ticker_data.append(
                {
                    "symbol": ticker["pair"],
                    "openPrice": float(open_price),
                    "currentPrice": float(current_price),
                    "oc": float(
                        round((current_price - open_price) / open_price * 100, 2)
                    ),
                }
            )

        _ticker_data = ticker_data
        _last_updated_at = datetime.now(timezone.utc)
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
    global _online_spot_pairs, _online_pairs_updated_on

    _ticker_data = []
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
