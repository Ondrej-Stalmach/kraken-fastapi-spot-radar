# Kraken Spot Radar

A small FastAPI web app that tracks Kraken spot pairs quoted in USD.
It shows the ten strongest gainers and losers by 24-hour change, alongside
the pair count and the number of markets above or below their 24-hour open.

The dashboard and API use `connector-kraken` to read Kraken's public Ticker
endpoint; no API key or account access is needed.

## Run locally

Requirements: Python 3.12+ and [uv](https://docs.astral.sh/uv/).

```bash
uv sync --locked
uv run fastapi dev main.py
```

Open <http://127.0.0.1:8000>. The app needs network access to Kraken's public
API to load market data.

## API

- `GET /` - dashboard
- `GET /kraken-tickers` - current ticker snapshot, refreshed by the server
	every ten seconds
- `GET /health` - process health and the timestamp of the last successful
	market-data refresh
- `GET /docs` - interactive API documentation

The ticker response has a `count`, an `updatedAt` timestamp, and a `data`
array. Each row contains `symbol`, `openPrice`, `currentPrice`, and `oc`, where
`oc` is the percentage move from the 24-hour open.

## Tests

The tests mock the connector methods and do not make network requests:

```bash
uv run python -m unittest discover -s tests -v
```

GitHub Actions runs the test suite on Python 3.12 and 3.14.

See [architecture.md](docs/architecture.md) for the request flow, module
responsibilities, and cache behavior.

## License

Distributed under the [MIT License](LICENSE).
