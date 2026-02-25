# Polymarket CLI - Common Commands

## Browse Markets

- `markets` — list trending markets
- `markets --search "bitcoin"` — search markets by keyword
- `market --id <CONDITION_ID>` — get details for a specific market

## Browse Events

- `events` — list current events
- `event --id <EVENT_ID>` — get details for a specific event

## Prices & Order Book

- `clob prices --id <TOKEN_ID>` — get current prices for a market
- `clob spread --id <TOKEN_ID>` — get bid/ask spread
- `clob book --id <TOKEN_ID>` — get full order book
- `clob trades --id <TOKEN_ID>` — get recent trades

## Portfolio & Positions

- `data portfolio` — view your portfolio summary
- `data positions` — list open positions
- `data profit` — view profit/loss
- `data activity` — view recent trading activity

## Leaderboard

- `data leaderboard` — view top traders
