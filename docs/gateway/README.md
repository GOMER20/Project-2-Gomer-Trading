# Bot gateway

How trading programs connect to Gomer Trading: what the gateway is made of,
every message of both wire protocols, and how to run and test it.

Contents: [At a glance](#at-a-glance) · [Architecture](#architecture) ·
[Admitting a program](#admitting-a-program) · [Sessions and limits](#sessions-and-limits) ·
[Orders](#orders) · [Execution reports](#execution-reports) · [Market data](#market-data) ·
[JSON over WebSocket](#standard-gateway-json-over-websocket) · [REST](#standard-gateway-rest) ·
[Binary protocol](#low-latency-gateway-binary-over-tcp-or-a-unix-socket) ·
[P&L hook](#real-time-pl-hook) · [Running it](#running-it) · [Latency](#latency-measured) ·
[What it is not](#what-it-is-not)

## At a glance

| | Standard gateway | Low-latency gateway |
| --- | --- | --- |
| For | Ordinary trading programs, anywhere | Programs running beside the exchange, counting microseconds |
| Transport | WebSocket at `/gateway`, and REST at `/api/gateway/v1` | TCP socket, and Unix domain socket |
| Encoding | JSON | Fixed-layout little-endian structs ([`gomer_gateway.h`](gomer_gateway.h)) |
| Reaches | Wherever the app itself is reachable, including its internet address (`wss://`) | The exchange's own machine (and its network, if you bind it there) |
| Sign-in | API key | The same API key |

Both do the same things: sign in, stream market data (best bid and offer,
trades, depth), send orders (market, limit, stop, stop-limit; GTC, IOC, FOK),
cancel them, ask their status, and receive an execution report for every step
in the life of every order.

Working example programs are in [`examples/bots`](../../examples/bots): a
market maker in JavaScript over WebSocket, and a client for the binary protocol
in C and in Python.

## Architecture

```
                         trading programs
        ┌──────────────┬──────────────┬──────────────┬──────────────┐
        │ REST         │ WebSocket    │ binary, TCP  │ binary, Unix │
        │ /api/gateway │ /gateway     │ 127.0.0.1:…  │ socket       │   transports
        │ /v1          │ (JSON)       │              │              │   rest.ts, wsGateway.ts,
        └──────┬───────┴──────┬───────┴──────┬───────┴──────┬───────┘   binaryGateway.ts
               │              │              │              │
               ▼              ▼              ▼              ▼
        ┌────────────────────────────────────────────────────────────┐
        │ API key → account + sandbox      keys.service.ts           │   authentication,
        │ session registry, order throttle, logon lock-out           │   session.ts
        └──────────────────────────┬─────────────────────────────────┘
                                   ▼
        ┌────────────────────────────────────────────────────────────┐
        │ order pipeline                    pipeline.ts              │
        │   shape → throttle → market → risk → match                 │
        └──────────────────────────┬─────────────────────────────────┘
                                   ▼
        ┌────────────────────────────────────────────────────────────┐
        │ matching engine         engine/matchingEngine.ts           │
        │   trades against the Level 2 book, under the account lock  │
        └───────┬──────────────────────────────────────┬─────────────┘
                │ order events                         │ quotes, fills
                ▼                                      ▼
   execution reports to the sessions        market data hub   feed.ts
   of the account concerned                 bbo / trades / depth pub-sub
                │
                ▼
   P&L hook → Redis leaderboard and fill stream   pnlHook.ts
```

Everything under the transports is shared. An order is checked, matched,
reported and scored the same way whichever door it came in through, and the
same way as an order a person places in the trading terminal. There is one
matching engine and one set of risk rules, not a second copy for programs.

**Life of an order.**

1. A transport decodes the message into a `NewOrderSingle`.
2. *Shape*: symbol, side, type, quantity and prices are valid and consistent.
3. *Throttle*: the key has not exceeded its orders per second.
4. *Market*: the symbol exists and is quoting.
5. *Risk and match*: the matching engine, which holds every account in
   memory, checks cash, margin and short inventory against the order's worst
   price, books the order, and trades it against the book. It does all of that
   without pausing, so nothing else can run in between; that is what stops two
   orders sent at the same instant from both spending the same buying power.
   The decision is appended to a journal file, then answered. The database is
   written a few milliseconds later, in the background.
6. The engine emits an order event. The gateway turns it into execution
   reports for every session of that account; the P&L hook writes the fill to
   Redis; the market data hub republishes the book the fill just changed.
7. An order that did not finish (a resting limit, a stop, the unfilled part of
   a large order) stays in the engine's book and produces further events, and
   so further execution reports, as it fills, triggers or is cancelled.

**One process, one thread of control.** The gateway runs inside the API
process. Node.js runs it on a single thread, so there are no locks between
sessions and no reordering: messages from one connection are handled in the
order they arrive. An order waits for nothing: not for the database, which is
written behind it, and not for other orders, which are decided one after
another in microseconds.

## Admitting a program

An administrator admits a program in the Admin console (**Trading programs
(bots)**) or over the admin API. That creates:

- an **account** for the program (`BOT-…`, flagged as a bot, with a password
  nobody knows), unless the key is being given to an existing trader;
- a **portfolio** in the chosen competition. That competition is the program's
  **sandbox**: its own starting balance, its own positions, its own line on the
  leaderboard, isolated from every other account;
- an **API key**, shown once. Only a SHA-256 of its secret is stored.

The key is pinned to one competition. **Changing the bot's sandbox is the
administrative switch**: it enrols the account in the other competition (a
fresh portfolio at that competition's starting balance if it has none there),
re-points the key, and drops the program's connections. The program logs on
again and finds itself in the new sandbox. Switching a bot off, changing its
throttle, issuing a new key or deleting it drop its connections the same way.

| Admin API (needs an administrator's session) | |
| --- | --- |
| `GET /api/bots` | Every key, its sandbox, whether its program is connected, and where programs connect |
| `POST /api/bots` `{ label, competitionId, traderId?, ordersPerSecond? }` | Admit a program. Reply carries `apiKey`, once |
| `PUT /api/bots/:id` `{ competitionId?, ordersPerSecond?, enabled? }` | Move it, re-throttle it, switch it off or on |
| `POST /api/bots/:id/rotate` | New key; the old one stops working |
| `DELETE /api/bots/:id` | Remove the key. An account created for the program is deactivated; its trades stay on record |

## Sessions and limits

- **API key**: `gtk_<10 hex>_<43 characters>`. Send it in the logon message
  (WebSocket, binary) or with every request (REST: `X-API-Key`, or
  `Authorization: Bearer`).
- **Logon lock-out**: ten wrong keys from one address in a minute and that
  address is refused for the rest of the minute. Programs on the exchange's
  own machine are exempt: they all share one address, and one of them with a
  wrong key must not lock out the others.
- **Logon timeout**: a connection that has not logged on is closed after 10
  seconds (WebSocket) or 5 seconds (binary).
- **Order throttle**: each key has an orders-per-second limit (default 50, up
  to 5,000), enforced as a token bucket with a burst of one second's worth and
  shared by all of the key's connections and REST calls. An order over the
  limit is refused with `THROTTLED`; nothing else happens to the session.
- **Message ceiling**: 12,000 messages a second per WebSocket session, 500
  requests a second per key over REST. REST calls also count towards the
  API's general limit of 6,000 requests a minute per address.
- **Several connections** on one key are allowed. Each receives every
  execution report for the account.
- **Slow readers**: market data is dropped for a session with more than 1 MB
  unsent, so one slow program never delays the others. Execution reports are
  never dropped; a session that lets 16 MB of them pile up is disconnected.
- **Heartbeat**: the WebSocket gateway pings every 30 seconds and closes a
  connection that does not answer. On the binary gateway the client may send
  `HEARTBEAT` at any time to measure its round trip.

## Orders

| Type | |
| --- | --- |
| `MARKET` | Trades through the book at once. Needs no price |
| `LIMIT` | Trades at `price` or better. What cannot trade at once rests |
| `STOP` | Waits for the market to reach `stopPrice`, then becomes a market order |
| `STOP_LIMIT` | Waits for `stopPrice`, then becomes a limit order at `price` |

| Time in force | |
| --- | --- |
| `GTC` (default) | Works until filled or cancelled, or the competition ends |
| `IOC` | Immediate or cancel: trades what it can at once; the rest is cancelled. Never rests |
| `FOK` | Fill or kill: trades in full at once, or is refused and nothing is done |

`IOC` and `FOK` apply to market and limit orders. Prices are in whole cents.
Quantity is a whole number of shares, at most the platform's order size limit
(100,000 by default).

**`clOrdId`** is the program's own reference for an order: up to 36 characters
(letters, digits, `. _ : -`) in JSON, an unsigned 64-bit integer in binary. It
must be unique within the account. Sending the same one twice is refused with
`DUPLICATE_CL_ORD_ID`, which makes retrying after a lost connection safe: the
order cannot trade twice.

**Pre-trade risk**, in the order the checks run:

| Check | Refused with |
| --- | --- |
| Order rate within the key's throttle | `THROTTLED` |
| Symbol exists and is quoting | `UNKNOWN_SYMBOL` |
| Competition is running | `SANDBOX_CLOSED` |
| Short inventory: with shorting off, a sell cannot exceed shares held less shares already committed to resting sells | `RISK` |
| Virtual margin and cash: an order that grows a position, plus its commission, fits in buying power (equity × leverage − exposure − reservations for resting orders) | `RISK` |

A refused order is never recorded and produces no execution report; the
refusal itself carries the reason.

**Market hours.** The exchange trades during US market hours only (9:30 am to
4:00 pm New York time on trading days), whether its prices are real or come
from the practice market, unless the practice market has been set to run around
the clock. `GET /session` says which it is right now (`market.open`). While it
is closed, market data stands still at the last close, and:

- a `MARKET` order is refused with `RISK` ("The market is closed…");
- an `IOC` or `FOK` limit order has nothing to trade against, so it is
  cancelled or refused at once;
- a `GTC` limit, stop or stop-limit order is accepted and waits for the open.

The open is usually away from the last close. An order that was already
waiting when the market jumped past its price trades at the market's price,
which is better than its own; a stop the open has jumped past is triggered and
trades at the open, which is worse than its stop price. Both are what a real
exchange does.

## Execution reports

One for every step in the life of an order, sent to every session of the
account the order belongs to (including orders the account placed some other
way: from the terminal, or bracket exits and margin-call liquidations the
platform placed for it).

| Field (JSON) | Meaning |
| --- | --- |
| `orderId` | The exchange's id for the order |
| `clOrdId` | The program's own, or null |
| `symbol`, `side`, `ordType`, `timeInForce` | As sent |
| `execType` | What this report is about: `NEW`, `PARTIAL_FILL`, `FILL`, `CANCELED`, `REJECTED`, `TRIGGERED` (a stop was reached), `STATUS` (answer to a status request), `RESTATED` |
| `ordStatus` | Where the order stands now: `NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELED`, `REJECTED` |
| `orderQty`, `cumQty`, `leavesQty` | Shares ordered, done so far, still working |
| `lastQty`, `lastPx` | Shares that traded in this step and their average price. Zero and null when the step is not a fill |
| `avgPx` | Average price of everything done so far |
| `commission` | Charged on the order so far |
| `arrivalPx` | The price on the order's side of the book when it arrived: the ask for a buy, the bid for a sell |
| `slippage`, `slippageBps` | `avgPx` against `arrivalPx`, per share and in basis points. Positive means worse than arrival |
| `text` | Why, for a rejection or a cancellation the program did not ask for |
| `transactTime` | Milliseconds since the epoch (nanoseconds in binary) |

**Partial executions.** An order larger than the best offer trades through the
book level by level. All the levels it takes in one step are one report
(`lastQty` their total, `lastPx` their average). An order larger than the whole
visible book fills what it can (`PARTIAL_FILL`) and, if GTC, keeps working: a
further `PARTIAL_FILL` arrives each time more of it trades, then `FILL`.

**IOC that trades in part** is two things at once, so it is two reports: a
`PARTIAL_FILL` (with `leavesQty` showing what was left), then `CANCELED`.

**Order of arrival.** Reports come from the engine's event stream, not from
the reply to the request. On the WebSocket gateway the `order.ack` reply and
the first `exec` for the same order can arrive in either order.

## Market data

Three channels per symbol. Subscribe to any combination.

| Channel | Published | Content |
| --- | --- | --- |
| `bbo` | The moment the best bid, best offer or either size changes | Bid, bid size, ask, ask size |
| `trades` | Each trade as it prints | Price, size |
| `depth` | When the book changes, at most every 50 ms per symbol | Up to ten levels a side, best first |

A subscription is answered at once with the current `bbo` and `depth`, so a
program never has to wait for the market to move to know where it is. Market
data is not batched: an update goes to its subscribers in the same turn of the
event loop that produced it. Each update is encoded once per wire format and
shared by every subscriber.

Only the best bid and offer come from the price feed. **The levels behind them
are modelled** (see the main README, *Level 2 and partial fills*); orders trade
against them, and what an order takes stays out of the book for a few seconds.
Depth is by price level (Level 2). There is no order-by-order (Level 3) feed,
because there are no individual resting orders behind the modelled levels to
show.

## Standard gateway: JSON over WebSocket

Connect to `ws://<host>/gateway` (or `wss://` at the app's internet address).
Every message is one JSON object with an `op`. A request may carry an `id` of
your choosing, which is echoed in its reply.

**Requests**

```jsonc
{ "op": "logon", "apiKey": "gtk_…", "id": 1 }
{ "op": "ping", "t": 1791580000000, "id": 2 }
{ "op": "subscribe",   "channels": ["bbo", "trades", "depth"], "symbols": ["AAPL", "MSFT"], "id": 3 }
{ "op": "unsubscribe", "channels": ["depth"], "symbols": ["MSFT"], "id": 4 }
{ "op": "order.new", "clOrdId": "a-1", "symbol": "AAPL", "side": "BUY", "type": "LIMIT",
  "tif": "GTC", "qty": 100, "price": 207.20, "id": 5 }          // NewOrderSingle
{ "op": "order.new", "clOrdId": "a-2", "symbol": "AAPL", "side": "SELL", "type": "STOP",
  "qty": 100, "stopPrice": 205.00, "id": 6 }
{ "op": "order.cancel", "clOrdId": "a-1", "id": 7 }              // OrderCancelRequest (or "orderId")
{ "op": "order.status", "clOrdId": "a-1", "id": 8 }              // OrderStatusRequest (or "orderId")
{ "op": "orders.open", "id": 9 }
{ "op": "account", "id": 10 }
```

**Replies**

```jsonc
{ "op": "logon.ack", "id": 1, "sessionId": "1791580000000001", "traderId": "BOT-3FA91C",
  "competition": { "id": "…", "name": "Algo sandbox", "startingBalance": 100000 },
  "limits": { "ordersPerSecond": 50, "maxOrderQty": 100000 }, "serverTime": 1791580000123 }
{ "op": "pong", "id": 2, "t": 1791580000000, "serverTime": 1791580000124 }
{ "op": "subscribe.ack", "id": 3, "channels": ["bbo", "trades", "depth"], "symbols": ["AAPL", "MSFT"], "unknown": [] }
{ "op": "order.ack", "id": 5, "orderId": "0f8fad5b-…", "clOrdId": "a-1", "ordStatus": "NEW" }
{ "op": "order.cancel.ack", "id": 7, "orderId": "0f8fad5b-…", "clOrdId": "a-1" }
{ "op": "order.status", "id": 8, /* …an execution report with execType "STATUS"… */ }
{ "op": "orders.open", "id": 9, "orders": [ /* execution reports, execType "STATUS" */ ] }
{ "op": "account", "id": 10, "account": { "cash": 79280.0, "totalEquity": 100012.5, "buyingPower": 79280.0,
    "marginLevel": 1, "realizedPnl": 0, "commissions": 0, "positions": [ { "ticker": "AAPL", "quantity": 100, "averagePrice": 207.2, … } ], … } }
{ "op": "reject", "id": 5, "ref": "order.new", "clOrdId": "a-1", "code": "RISK",
  "text": "Insufficient buying power to buy 90000 AAPL: requires $18,650,700.00, available $100,000.00." }
```

**Pushed without being asked**

```jsonc
{ "op": "exec", "orderId": "0f8fad5b-…", "clOrdId": "a-1", "symbol": "AAPL", "side": "BUY",
  "ordType": "LIMIT", "timeInForce": "GTC", "execType": "PARTIAL_FILL", "ordStatus": "PARTIALLY_FILLED",
  "orderQty": 1000, "cumQty": 300, "leavesQty": 700, "lastQty": 300, "lastPx": 207.2, "avgPx": 207.2,
  "commission": 1.5, "arrivalPx": 207.22, "slippage": -0.02, "slippageBps": -0.97, "text": null,
  "transactTime": 1791580000456 }
{ "op": "bbo",   "s": "AAPL", "b": 207.22, "bs": 800, "a": 207.24, "as": 2900, "t": 1791580000500 }
{ "op": "trade", "s": "AAPL", "p": 207.24, "q": 300, "t": 1791580000510 }
{ "op": "depth", "s": "AAPL", "bids": [[207.22, 800], [207.21, 1900]], "asks": [[207.24, 2900], [207.25, 1000]], "t": 1791580000520 }
```

**Reject codes** (the same in both encodings; the number is what binary sends)

| Code | # | Meaning |
| --- | --- | --- |
| `NOT_LOGGED_ON` | 1 | Send logon first |
| `BAD_CREDENTIALS` | 2 | Key not valid, switched off, its sandbox gone, or the address is locked out. The connection is closed |
| `MALFORMED` | 3 | The message is not a well-formed request |
| `UNKNOWN_SYMBOL` | 4 | Not a tradable symbol here |
| `THROTTLED` | 5 | Over the key's orders per second |
| `RISK` | 6 | Refused by a pre-trade check, or a fill-or-kill that could not fill; `text` says which |
| `UNKNOWN_ORDER` | 7 | No such order in this account |
| `TOO_LATE_TO_CANCEL` | 8 | The order is already filled, cancelled or rejected |
| `DUPLICATE_CL_ORD_ID` | 9 | That client order id has been used |
| `BUSY` | 10 | The exchange is overloaded for a moment; send it again |
| `SANDBOX_CLOSED` | 11 | The competition has not started or has ended |
| `INTERNAL` | 99 | Something went wrong on the exchange's side |

## Standard gateway: REST

Base `/api/gateway/v1`. Send the key as `X-API-Key`. Errors are
`{ "error": { "code": "<reject code>", "message": "…" } }` with a matching
status (400 malformed, 401 credentials, 404 unknown, 409 duplicate or too
late, 422 risk, 429 throttled, 503 busy).

| | |
| --- | --- |
| `GET /session` | Who the key is, its sandbox and its limits, and whether the market is trading right now (`market.open`) |
| `GET /account` | Cash, equity, buying power, margin level, positions |
| `GET /marketdata/:symbol` | Best bid and offer, last trade, depth |
| `POST /orders` `{ clOrdId?, symbol, side, type, tif?, qty, price?, stopPrice? }` | NewOrderSingle. `201` with `{ order: <execution report> }` as the order stood when the request returned |
| `GET /orders` | Working orders |
| `GET /orders/:ref` | OrderStatus. `ref` is an `orderId` or a `clOrdId` |
| `DELETE /orders/:ref` | OrderCancelRequest |

```bash
curl -s -X POST http://localhost:4000/api/gateway/v1/orders \
  -H "X-API-Key: $GOMER_API_KEY" -H 'content-type: application/json' \
  -d '{"clOrdId":"r-1","symbol":"AAPL","side":"BUY","type":"MARKET","tif":"IOC","qty":50}'
```

REST has no stream. A program that wants fills as they happen, or market data
as it changes, holds a WebSocket or binary connection.

## Low-latency gateway: binary over TCP or a Unix socket

The same bytes on both. Everything is little-endian. Every message is a fixed
layout, defined as packed C structs in [`gomer_gateway.h`](gomer_gateway.h)
(the header's `_Static_assert`s check the sizes at compile time) and encoded
on the server by `backend/src/gateway/protocol.ts`.

**Conventions**

| | |
| --- | --- |
| Prices and money | `int64`, in units of 1/10000 of a dollar (`207.24` is `2072400`) |
| Quantities | `uint32`, whole shares |
| Times | `uint64`, nanoseconds since the Unix epoch |
| Text | Fixed width, ASCII, NUL padded |
| Ids | `clOrdId` is a `uint64` of the client's choosing; the exchange's order id is 16 UUID bytes |

**Header** (8 bytes, before every message)

| Offset | Type | Field | |
| --- | --- | --- | --- |
| 0 | `uint16` | `length` | Whole frame, header included |
| 2 | `uint8` | `type` | Message type |
| 3 | `uint8` | `version` | 1 |
| 4 | `uint32` | `seq` | The sender's own count of frames, from 1 |

**Client to server**

| Type | Message | Size | Body (offset: field) |
| --- | --- | --- | --- |
| `0x01` | `LOGON` | 80 | 8: `char api_key[64]` · 72: `uint32 heartbeat_ms` (0) · 76: `uint32 reserved` |
| `0x03` | `HEARTBEAT` | 16 | 8: `uint64 client_time_ns` (echoed back) |
| `0x10` | `SUBSCRIBE` | 24 | 8: `char symbol[8]` · 16: `uint8 channels` (1 bbo, 2 trades, 4 depth; a bit mask) |
| `0x11` | `UNSUBSCRIBE` | 24 | As `SUBSCRIBE` |
| `0x20` | `NEW_ORDER` | 48 | 8: `uint64 cl_ord_id` · 16: `char symbol[8]` · 24: `uint8 side` (1 buy, 2 sell) · 25: `uint8 ord_type` (1 market, 2 limit, 3 stop, 4 stop-limit) · 26: `uint8 tif` (1 GTC, 3 IOC, 4 FOK) · 28: `uint32 qty` · 32: `int64 price` · 40: `int64 stop_price` |
| `0x21` | `CANCEL` | 16 | 8: `uint64 cl_ord_id` of the order to cancel |
| `0x22` | `STATUS` | 16 | 8: `uint64 cl_ord_id` of the order asked about |

**Server to client**

| Type | Message | Size | Body (offset: field) |
| --- | --- | --- | --- |
| `0x02` | `LOGON_ACK` | 72 | 8: `uint8 status` (0 ok) · 12: `uint32 orders_per_second` · 16: `uint64 session_id` · 24: `char trader_id[24]` · 48: `uint8 competition_id[16]` · 64: `int64 starting_balance` |
| `0x04` | `HEARTBEAT_ACK` | 24 | 8: `uint64 client_time_ns` · 16: `uint64 server_time_ns` |
| `0x05` | `REJECT` | 72 | 8: `uint32 ref_seq` (the `seq` of what is refused) · 12: `uint8 ref_type` · 14: `uint16 code` · 16: `uint64 cl_ord_id` · 24: `char text[48]` |
| `0x30` | `EXEC_REPORT` | 104 | 8: `uint64 cl_ord_id` · 16: `uint8 order_id[16]` · 32: `char symbol[8]` · 40: `uint8 exec_type` · 41: `uint8 ord_status` · 42: `uint8 side` · 43: `uint8 ord_type` · 44: `uint32 order_qty` · 48: `uint32 cum_qty` · 52: `uint32 leaves_qty` · 56: `uint32 last_qty` · 64: `int64 last_px` · 72: `int64 avg_px` · 80: `int64 commission` · 88: `int64 slippage` · 96: `uint64 transact_time_ns` |
| `0x40` | `BBO` | 48 | 8: `char symbol[8]` · 16: `int64 bid` · 24: `int64 ask` · 32: `uint32 bid_size` · 36: `uint32 ask_size` · 40: `uint64 ts_ns` |
| `0x41` | `TRADE` | 40 | 8: `char symbol[8]` · 16: `int64 price` · 24: `uint32 size` · 32: `uint64 ts_ns` |
| `0x42` | `DEPTH` | 32 + 16n | 8: `char symbol[8]` · 16: `uint64 ts_ns` · 24: `uint8 n_bids` · 25: `uint8 n_asks` · 32: levels, each `int64 price`, `uint32 size`, 4 bytes padding; bids best first, then asks best first |

`exec_type`: 0 new, 1 partial fill, 2 fill, 3 canceled, 4 rejected, 5
triggered, 6 status, 7 restated. `ord_status`: 0 new, 1 partially filled, 2
filled, 3 canceled, 4 rejected.

**Rules**

- The first frame must be `LOGON`. Anything else is answered with `REJECT`
  `NOT_LOGGED_ON`.
- **An accepted order is acknowledged by its first `EXEC_REPORT`**, not by a
  separate ack: one message fewer on the hot path. Only a refusal produces a
  `REJECT`, which names the `seq` and `cl_ord_id` it refuses.
- Orders, cancels and status requests refer to orders by `cl_ord_id`. An order
  sent with `cl_ord_id` 0 cannot be referred to later.
- A `REJECT`'s `text` is cut to 48 bytes; the `code` is the stable part.
- A frame with an impossible length or an unknown version means the stream has
  lost its framing. The gateway sends `REJECT` `MALFORMED` and closes.
- `TCP_NODELAY` is set on the server side. Set it on the client too, or the
  operating system will hold small frames back waiting to batch them.

**Why a Unix domain socket, and why not shared memory.** For a program on the
exchange's own machine the Unix socket skips the TCP stack: no checksums, no
congestion control, no loopback routing. It is the fastest transport here and
is restricted by file permission to the user running the exchange. Shared
memory ring buffers would go further by removing the system call per message,
but Node.js cannot map memory shared with another process without a native
add-on, and the gain would be perhaps twenty of the roughly 140 microseconds
an order takes (see [Latency](#latency-measured)). It is not implemented.

## Real-time P&L hook

The leaderboard worker re-marks every portfolio every ten seconds, which is
right for prices drifting. A fill changes a standing at once, and a fast
program trades many times in ten seconds, so every fill is also reported
straight to the leaderboard store the moment its transaction commits
(`pnlHook.ts`), for every account, human or bot:

| Redis key | Type | Written on each fill |
| --- | --- | --- |
| `lb:<competitionId>` | Sorted set | The trader's score is set to their equity after the fill |
| `lb:<competitionId>:names` | Hash | Trader id → display name |
| `fills:<competitionId>` | Stream, capped at about 10,000 | `traderId`, `orderId`, `symbol`, `side`, `quantity`, `price` (the filled price), `equity` |
| `lb:updates` | Pub/sub channel | The new top of the board, at most every 400 ms per competition |

The trading terminals already listen to `lb:updates`, so every screen's
leaderboard moves with the trade instead of up to ten seconds later. The
`fills:` stream is there for anything else that wants to follow a competition
trade by trade (`XREAD BLOCK 0 STREAMS fills:<id> $`).

## Running it

The WebSocket and REST gateways are part of the API and are always on. The
binary listeners are switched on by configuration:

| Setting | Default | |
| --- | --- | --- |
| `GATEWAY_TCP_PORT` | unset (off) | Port for the binary protocol over TCP |
| `GATEWAY_TCP_HOST` | `127.0.0.1` | Interface to bind. Leave on loopback unless the network is trusted: the binary protocol is not encrypted |
| `GATEWAY_UNIX_SOCKET` | unset (off) | Path for the binary protocol over a Unix domain socket (created with mode `0600`) |

In development (`npm run dev`) `.env` turns both on: TCP `127.0.0.1:4010` and
`/tmp/gomer-gateway.sock`. The desktop app turns both on for programs on the
same Mac: TCP `127.0.0.1:47835` and `gateway.sock` in its data folder. The
Admin console shows the exact addresses under *Trading programs (bots)*.

**From somewhere else.** A program on another machine uses the WebSocket or
REST gateway at whatever address reaches the app, including its internet
address: `wss://<your address>/gateway`. That connection is encrypted by the
tunnel. The binary gateway is for programs beside the exchange.

**Testing.**

```bash
npm run dev            # in one terminal
npm run gateway:test   # in another: 95 checks across all four transports, then a latency table
```

`npm run gateway:bench` measures latency and throughput after a warm-up.
`npm test` runs the unit tests of the protocol, the framer, the throttle and
the lock-out. `npm run smoke` covers the engine underneath.

## Latency, measured

On the machine this was developed on (a MacBook Pro, Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz), with the exchange and the test client on the same machine, one order at a time,
after a warm-up of 3,000 orders, over 5,000 orders each. "Order" is the time
from the client writing the order to the client reading its execution report.

| | Median | 95th | 99th | Under 1 ms |
| --- | --- | --- | --- | --- |
| Binary, Unix socket: order that does not fill | 139 µs | 272 µs | 370 µs | 99.8% |
| Binary, Unix socket: market order that fills | 227 µs | 389 µs | 560 µs | 99.7% |
| Binary, TCP: order that does not fill | 170 µs | 290 µs | 401 µs | 99.9% |
| Binary, TCP: market order that fills | 223 µs | 400 µs | 564 µs | 99.7% |
| WebSocket, JSON: order that does not fill | 174 µs | 318 µs | 429 µs | 99.8% |
| Inside the exchange alone (order decoded to report handed to the socket) | 86 µs | 147 µs | 204 µs | |
| Binary, Unix socket: heartbeat (the wire alone) | 25 µs | 62 µs | 138 µs | |
| Binary, TCP: heartbeat (the wire alone) | 47 µs | 98 µs | 172 µs | |

Sent as fast as the socket will take them, the exchange answers 12,000 to
14,000 orders a second on one connection. Over REST an order takes a little
over a millisecond, which is the cost of an HTTP request.

Read it this way:

- **An order is answered in about a fifth of a millisecond**, and more than
  99.6% of orders in under one. The exchange itself spends under a tenth of a
  millisecond on an order; the rest is the two trips through the operating
  system's sockets and the client's own code.
- **About one order in a thousand takes longer**, up to around twenty
  milliseconds, when the process pauses to collect memory or the machine gives
  the processor to something else. Node.js is not a real-time runtime, and
  this is its floor. A program that cannot tolerate that needs an exchange
  written in a language without a garbage collector.
- **Orders are this fast because the database is no longer in the way.** The
  engine keeps every account in memory, decides the order there, appends the
  decision to a journal file, and answers. The database is written a few
  milliseconds behind by a background writer, many orders per transaction.
  Before this, every order was its own database transaction and took about
  two milliseconds whichever transport carried it.
- **What that costs.** A crash of the exchange process loses nothing: the
  journal is replayed on restart. A power cut to the machine can lose the
  orders answered in the last quarter of a second or so, because the journal
  is forced to disk a few times a second rather than on every order. The
  database is never left inconsistent either way.

`npm run gateway:bench` prints this table for the machine it runs on;
`GET /health` reports the exchange's own time per order (`gatewayOrders`) and
how far behind the database writer is (`engine`).

## What it is not

- **Not a FIX engine.** The messages are named after their FIX counterparts
  and carry the same information, and the binary codes follow FIX where FIX has
  one, but this is not the FIX wire protocol.
- **No Level 3.** Depth is by price level and is modelled behind the best bid
  and offer.
- **No shared-memory transport**, for the reason given above.
- **The binary protocol is not encrypted or authenticated per message.** It is
  meant for loopback and trusted networks. The key travels once, in `LOGON`.
- **One engine process.** The gateway shares the API's single thread. Heavy
  market-data fan-out and heavy order flow compete for it.
- **Paper trading.** Nothing here reaches a real exchange or moves real money.
