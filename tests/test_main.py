import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import httpx
from connector_kraken import KrakenAPIError, SpotTickerMetric

from main import PriceHistory, _record_price_and_calculate_five_minute_delta, app


SAMPLE_TICKERS: list[SpotTickerMetric] = [
    {
        "pair": "XBT/USD",
        "open": Decimal("100.0"),
        "high_price": Decimal("111.0"),
        "low_price": Decimal("99.0"),
        "close_price": Decimal("110.5"),
        "volume_usd_today_thousands": 1,
        "volume_usd_24h_thousands": 2,
    }
]
OFFLINE_TICKER: SpotTickerMetric = {
    "pair": "ETH/USD",
    "open": Decimal("100.0"),
    "high_price": Decimal("111.0"),
    "low_price": Decimal("99.0"),
    "close_price": Decimal("110.5"),
    "volume_usd_today_thousands": 1,
    "volume_usd_24h_thousands": 2,
}


class MainAppTests(unittest.IsolatedAsyncioTestCase):
    def test_five_minute_delta_remains_frozen_for_five_minutes_and_updates_periodically(
        self,
    ) -> None:
        history = PriceHistory()
        started_at = datetime(2026, 1, 1, tzinfo=timezone.utc)

        self.assertIsNone(
            _record_price_and_calculate_five_minute_delta(
                history, 100.0, started_at
            )
        )
        self.assertIsNone(
            _record_price_and_calculate_five_minute_delta(
                history, 100.5, started_at + timedelta(seconds=10)
            )
        )
        self.assertEqual(
            _record_price_and_calculate_five_minute_delta(
                history, 103.0, started_at + timedelta(minutes=5)
            ),
            3.0,
        )
        # During the 5-minute frozen window, delta remains frozen even when price changes
        self.assertEqual(
            _record_price_and_calculate_five_minute_delta(
                history, 110.0, started_at + timedelta(minutes=5, seconds=10)
            ),
            3.0,
        )
        self.assertEqual(
            _record_price_and_calculate_five_minute_delta(
                history, 95.0, started_at + timedelta(minutes=5, seconds=30)
            ),
            3.0,
        )
        self.assertEqual(
            _record_price_and_calculate_five_minute_delta(
                history, 120.0, started_at + timedelta(minutes=9, seconds=50)
            ),
            3.0,
        )
        # After 5 minutes elapse, delta updates using the baseline from 5 minutes ago (103.0 at t=5m)
        self.assertEqual(
            _record_price_and_calculate_five_minute_delta(
                history, 106.09, started_at + timedelta(minutes=10)
            ),
            3.0,
        )
        # Remains frozen again for the new 5-minute window
        self.assertEqual(
            _record_price_and_calculate_five_minute_delta(
                history, 150.0, started_at + timedelta(minutes=10, seconds=10)
            ),
            3.0,
        )

    def test_five_minute_delta_requires_a_fresh_baseline(self) -> None:
        history = PriceHistory()
        started_at = datetime(2026, 1, 1, tzinfo=timezone.utc)

        self.assertIsNone(
            _record_price_and_calculate_five_minute_delta(
                history, 100.0, started_at
            )
        )
        self.assertIsNone(
            _record_price_and_calculate_five_minute_delta(
                history, 100.5, started_at + timedelta(seconds=10)
            )
        )
        # At t=5m30s, comparison_at is 30s. Sample at 10s is 20s older (<= MAX_PRICE_SAMPLE_GAP)
        self.assertEqual(
            _record_price_and_calculate_five_minute_delta(
                history, 103.0, started_at + timedelta(minutes=5, seconds=30)
            ),
            2.49,
        )
        # At t=5m31s, delta remains frozen from t=5m30s
        self.assertEqual(
            _record_price_and_calculate_five_minute_delta(
                history, 104.0, started_at + timedelta(minutes=5, seconds=31)
            ),
            2.49,
        )

        # A gap larger than MAX_PRICE_SAMPLE_GAP (20s) without baseline yields None
        fresh_history = PriceHistory()
        _record_price_and_calculate_five_minute_delta(
            fresh_history, 100.0, started_at
        )
        self.assertIsNone(
            _record_price_and_calculate_five_minute_delta(
                fresh_history, 104.0, started_at + timedelta(minutes=5, seconds=21)
            )
        )

    async def _get(
        self,
        path: str,
        tickers: list[SpotTickerMetric],
        online_pairs: list[str] | None = None,
        error: Exception | None = None,
    ) -> httpx.Response:
        with patch(
            "main.KrakenClient.get_spot_tickers",
            new_callable=AsyncMock,
            return_value=tickers,
            side_effect=error,
        ), patch(
            "main.KrakenClient.get_spot_trading_pairs",
            new_callable=AsyncMock,
            return_value=online_pairs if online_pairs is not None else ["XBT/USD"],
        ):
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app),
                    base_url="http://testserver",
                ) as client:
                    return await client.get(path)

    async def test_dashboard_is_served(self) -> None:
        response = await self._get("/", [])
        self.assertEqual(response.status_code, 200)
        self.assertIn("Kraken Spot Radar", response.text)
        self.assertIn("Volume", response.text)

    async def test_ticker_route_returns_only_online_market_data(self) -> None:
        response = await self._get(
            "/kraken-tickers",
            [*SAMPLE_TICKERS, OFFLINE_TICKER],
            online_pairs=["XBTUSD"],
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["count"], 1)
        self.assertEqual(
            response.json()["data"],
            [
                {
                    "symbol": "XBT/USD",
                    "openPrice": 100.0,
                    "currentPrice": 110.5,
                    "volumeUsdToday": 1000,
                    "delta5m": None,
                    "oc": 10.5,
                }
            ],
        )
        self.assertIsNotNone(response.json()["updatedAt"])

    async def test_ticker_route_maps_connector_errors_to_bad_gateway(self) -> None:
        response = await self._get(
            "/kraken-tickers",
            [],
            error=KrakenAPIError("Kraken spot API error: unavailable"),
        )
        self.assertEqual(response.status_code, 502)

    async def test_health_route_reports_exchange_and_status(self) -> None:
        response = await self._get("/health", [])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(response.json()["exchange"], "kraken")