# Gomer Trading — Paper Trading Simulator & Competition Platform

A real-time paper trading terminal in the style of a professional day-trading
desk such as Sterling Trader Pro. Traders log in with a Trader ID and password,
get an isolated virtual account per competition ($100,000 unless the organiser
chooses another amount), trade against live
Level 1 quotes, and are ranked on a live leaderboard. When the competition ends
it is settled and the winner is declared.

No real money is involved anywhere. Orders are executed by this project's own
matching engine, never sent to a broker.

It runs three ways from the same code: as a **macOS app** (`Gomer Trading.dmg`,
everything bundled, nothing to install), as a **server** other people join from
their browsers (`npm run serve`), or as a development stack (`npm run dev`).

| Layer | Stack |
| --- | --- |
| Frontend | Next.js 16 (React 19), Tailwind CSS 4, Zustand, TradingView Lightweight Charts |
| Backend | Node.js, Express 5, TypeScript, `ws` WebSockets |
| Data | PostgreSQL (users, competitions, portfolios, positions, orders), Redis (quote cache, leaderboard sorted sets, pub/sub) |
| Market data | Real-time US stock quotes through a market-data key, or the built-in practice market |

## Desktop app (macOS)

```bash
npm install
npm run app:build
```

This produces `release/Gomer Trading.dmg`. Open it and drag **Gomer Trading** to Applications.

The app is the whole platform in one bundle: on launch it starts its own
PostgreSQL, Redis, trading server and leaderboard worker, all listening on
`127.0.0.1` only, and stops them again when you quit. Nothing else needs to be
installed or running.

- **Signing in.** The first launch creates an administrator and ten practice traders with random passwords. The login screen has a **Start trading** button (your `TRADER01` account) and an **Open the admin console** button; the app signs you in itself, with no password. Those two buttons keep working whatever you change the passwords to. To use the Admin console from another device, open it in the app once, click **Password** in the terminal's top bar, and choose a password you know.
- **Your data** lives in `~/Library/Application Support/Gomer Trading` (database, `config.json`, logs). The **Help** menu has *Open Data Folder*, *Show Log File* and *Reset All Data…*.
- **Live prices.** Click the **Simulated market** badge (or *Gomer Trading → Market Data…*) and paste your market-data key. See [Real-time prices](#real-time-prices).
- **Self-healing.** If the trading server or the leaderboard worker ever stops, the app restarts it and the window reconnects by itself.
- **Closing the window.** Normally closing the window quits the app. While it is shared (on the internet or on your network) it is a server for other people, so closing the window leaves it running in the Dock with the link up; click the Dock icon to get the window back. *Quit* then asks before taking the link down. Shutting down or logging out is never held up.
- **Staying awake for the market.** From 15 minutes before the US open (AT starts itself ten minutes before) to the close, the app keeps the Mac from going to sleep, so the practice market, AT and HFT all run (*Trading → Keep Mac Awake During US Market Hours* switches it off). One thing no app can override: with the lid closed on battery, macOS sleeps anyway. So when the open is near and the Mac is on battery, the app says so, and if the Mac did sleep through part of a session it tells you which stretch was missed.
- **Old copies tidied.** The app keeps the newest three copies taken before an update (`backups/before-upgrade-*.tgz`, about 17 MB each) and moves older ones to the Trash, where they can still be recovered. Its own automatic backups (small, every six hours) are kept for a week as before.
- **Backups.** The app saves a backup of every account, competition and trade by itself: shortly after it starts and every six hours while it is open, keeping about a week of them. *Help → Back Up Now* makes one on the spot, *Open Backups Folder* shows them, and *Restore a Backup…* puts one back (the current data is backed up first, so a restore can be undone). *Reset All Data…* also saves a backup before erasing. A backup is one small `.gtbackup` file of data, so it can be restored on another Mac or into a later version; copy one off this Mac now and then, because backups kept only here do not survive losing the Mac.
- `npm run app:dev` runs the app straight from the source tree without packaging.

Things to know before sharing the DMG with someone else:

- It is an **Intel (x64) build**. It runs on Apple Silicon Macs through Rosetta 2. macOS 13 or newer.
- It is **not notarized by Apple** (that needs a paid Apple Developer ID). A Mac that downloads it will refuse to open it until the user allows it under System Settings → Privacy & Security → Open Anyway. A copy built on your own Mac opens normally.
- The copy on someone else's Mac is its own separate world. To compete together, one of you hosts and the others join from a browser: see [Competing with other people](#competing-with-other-people).
- It bundles Electron, PostgreSQL, Redis, Cloudflare's `cloudflared` and Tailscale's client, each under its own licence. Check Redis's licence terms in particular before distributing the app commercially.

How it is put together is in [`desktop/main.mjs`](desktop/main.mjs) (the shell) and [`desktop/scripts/stage.mjs`](desktop/scripts/stage.mjs) (what gets bundled).

## Competing with other people

Everyone trades in one shared competition on one machine, and joins from a web
browser. Nobody but the host installs anything.

**How much money.** Each competition sets the money every account starts with:
any amount from $100 to $1,000,000,000 (one click for $100K, $1M, $10M or
$100M). It can be changed while the competition runs, from the admin console
(the competition → *Starting money → Change*) or, for AT's sandbox, from the AT
window. Every account in the competition gets the difference added to, or taken
from, its cash, so what each trader has made or lost so far stays exactly the
same and the leaderboard measures from the new amount; traders who join later
start with it. It cannot be lowered below what someone has already spent, and a
finished competition's results are final. The change is one journal entry for
all the accounts and the competition together, so it survives a crash whole.

**More money for one account.** One account can also be given its own amount
(admin console → the competition → *Money for one account*, or *AT's starting
money* in the AT window), leaving everyone else as they are. Its cash moves by
the difference, so its profit and loss are kept, and its return is measured
from its own amount. The leaderboard and the final results therefore rank by
**return** (profit as a share of the money each trader started with): when
everyone starts with the same amount this is exactly the order of their equity,
and an account given more money gets no head start. Changing the whole
competition afterwards keeps the one account's extra.

**Inviting people.** Every competition has a six-character **invite code**
(Admin console → the competition → *Copy invite link*). Whoever opens the link,
or types the code at `/join`, chooses their own Trader ID and password and
starts with a fresh balance. Someone who already has an account just joins.
*Close sign-up* stops the code working; nobody can create an account without one.

**For people anywhere: share from the desktop app.**

1. *Gomer Trading → Share on the Internet… → Turn On.*
2. In about ten seconds the app shows a secure link such as `https://four-random-words.trycloudflare.com`.
3. Open the Admin console and use *Copy invite link*. It already contains that address: `https://four-random-words.trycloudflare.com/join?code=K7QF3M`. Send it by WhatsApp, email, anything.

What to know before relying on it:

- **Your Mac is the server.** It must stay on, online, with the app open and the lid up, for as long as people trade. The app stops it going to sleep by itself; plug it in.
- **The link is new every time** sharing is turned on or the app restarts, and the old one stops working. If the connection ever has to be re-made mid-session the app notifies you; send the new link. People's accounts and positions are unaffected, they just sign in again at the new address.
- **It is encrypted** (https) between each trader's browser and Cloudflare, and between Cloudflare and your Mac. Cloudflare, as the relay in the middle, could see the traffic. Nothing on the Mac is opened to the network: the app makes an outgoing connection, so there is no router or firewall setting, and macOS does not ask for permission.
- **It runs on Cloudflare's free "quick tunnel" service**, using their open-source `cloudflared` program, which is included in the app (`Contents/Resources/tunnel`, Apache 2.0 licence beside it). Cloudflare relays the traffic, gives no uptime guarantee for quick tunnels, and limits one tunnel to 200 requests in flight at once. Each connected trader holds one, so plan on **about 100 traders at a time**. Past that, or for something public and permanent, run the server below.
- Anyone who has the link can see the sign-in page, but nobody can create an account without an invite code, and sign-in, sign-up and invite checks are rate limited per visitor.

*Turn Off* in the same menu item takes the link down immediately.

**A permanent address.** In the same dialog, *Make It Permanent…* swaps the
temporary link for an address that never changes, such as
`https://gomer-trading.your-name.ts.net`, so an invite link sent once keeps
working and traders stay signed in across restarts.

- It is provided free by Tailscale (their *Funnel* feature). You sign in once with a Google, Microsoft, GitHub or Apple account; the app opens the sign-in page, and the first time a second page to approve public access.
- The app runs Tailscale's open-source programs itself (`Contents/Resources/tunnel`, BSD licence beside them) as ordinary processes: no administrator password, no system network extension, nothing installed outside the app. This Mac's Tailscale identity is kept in the data folder (`tailscale/`), which is what makes the address permanent. It survives *Reset All Data…*; delete that folder, or remove the device at login.tailscale.com, to give the address up.
- The very first time, the address takes about five minutes to appear on the internet. After that it is back about half a minute after the app starts.
- Only the trading server is published. Tailscale relays the traffic and, like Cloudflare, could see it and gives no uptime promise on the free plan; it also applies its own bandwidth limits. Measured from India, an action takes about a quarter of a second through it.
- Tailscale's program opens one network listener of its own, which answers only other devices signed in to your Tailscale account. If the macOS firewall asks whether `tailscaled` may accept incoming connections, either answer is fine: visitors arrive over a connection the Mac makes outwards.
- Tailscale signs devices out after 180 days unless you turn off key expiry for the device at login.tailscale.com. When that happens the app asks you to sign in again; the address stays the same.
- *Use a Temporary Link* switches back.

**Looking after traders.** The Admin console's *Accounts* list shows who has the terminal open right now, and next to each account:

- *Reset password* gives a trader who has forgotten theirs a temporary one. It is shown once; send it to them. They change it under **Password** in the terminal's top bar.
- *Deactivate* signs a trader out on the spot and stops them logging in. Their trades and their place in the standings stay. *Reactivate* lets them back in.

Changing a password, by either route, signs that account out everywhere else immediately.

**On the same Wi-Fi or office network: host from the desktop app.**

1. *Gomer Trading → Host on This Network… → Turn On and Restart.*
2. The first time, macOS asks whether Gomer Trading may accept incoming connections. Choose **Allow**, or nobody will be able to connect. (macOS asks again after each new build of the app.)
3. Open the Admin console and send people the invite link. It looks like `http://192.168.1.20:47831/join?code=K7QF3M`.

Your Mac is the server while this is on: it must stay on with the app open (the
app keeps it awake). Connections on the network are not encrypted, so host at
home or at work, not on public Wi-Fi. Only the trading server is opened to the
network; the database stays private to the Mac.

**For a permanent address or a bigger crowd: run it on a server.**

```bash
npm ci
npm run build:server
npm run serve
```

This serves the interface, the API and the live feed on one address
(`http://<server>:4000`), creates the tables and the admin account on first
start, and restarts either of its two processes if one ever stops. It needs
Node.js 20.12+, PostgreSQL and Redis (`docker compose up -d` provides both),
and in `.env`: `NODE_ENV=production`, a long random `JWT_SECRET`, real database
credentials, and `SEED_ADMIN_ID` / `SEED_ADMIN_PASSWORD` for the first admin.

Before giving the address to anyone outside your network, put it behind HTTPS:
a reverse proxy with a certificate (Caddy, nginx) or a tunnel service, with
`TRUST_PROXY=1` set so rate limits see real client addresses. Passwords must
not travel over plain HTTP on the internet. The page talks to whatever address
served it, so no rebuild is needed when the address changes.

## Trading programs (bots)

Programs can trade alongside people. An administrator admits one under
*Admin console → Trading programs (bots)*: name it, pick the competition it
trades in (its sandbox, with its own balance), and copy the API key that is
shown once. The same panel moves a bot to another competition, changes how
many orders a second it may send, switches it off, or issues a new key, and
shows whether it is connected.

A program connects with that key through the **bot gateway**:

| | For | Where |
| --- | --- | --- |
| WebSocket, JSON | Any program, anywhere | `/gateway` on the app's address (`wss://` over the internet) |
| REST | Programs that prefer requests | `/api/gateway/v1` |
| Binary, TCP or Unix socket | Programs on the same machine that count microseconds | Shown in the Admin console |

All of them stream market data (best bid and offer, trades, depth), take
market, limit, stop and stop-limit orders with GTC, IOC or FOK, and send an
execution report for every fill, partial fill, cancel and reject, with the
slippage against the price that was showing when the order arrived. Orders go
through the same risk checks and the same matching engine as a person's, and
every fill updates the leaderboard at once.

The full design, every message of both protocols, and measured latency are in
[`docs/gateway/README.md`](docs/gateway/README.md); the binary layouts as C
structs are in [`docs/gateway/gomer_gateway.h`](docs/gateway/gomer_gateway.h);
working example bots in JavaScript, Python and C are in
[`examples/bots`](examples/bots). `npm run gateway:test` checks all of it
against a running stack.

## HFT (the order book engine, in test mode)

HFT is an order book matching engine written in C++ for nanosecond-scale
matching: the "Project 1 - Low Latency Order Book" repository, carried here in
[`hft/`](hft/). Where the exchange's own engine fills an order against an
*estimate* of the order book, HFT keeps a real one: every order rests in a
queue at its price, and orders trade with each other in strict price and time
order.

It runs beside the trading server in **test mode**. The server gives HFT a copy
of everything it sees and HFT decides nothing:

- **Prices.** For every symbol the server tells HFT what the market should be
  bidding and offering, ten levels a side around the live quote, and HFT keeps
  real orders resting to match.
- **Orders.** Every market and limit order the exchange handles is copied to
  HFT, and every stop order when it triggers. When the exchange finishes with
  an order, its copy is taken out of HFT's book.
- **Fills still come from the exchange's own engine.** What HFT would have
  filled is counted and shown beside what the exchange filled, and goes no
  further. Nothing HFT does can touch an account, and if HFT stops, trading
  carries on without it; the server starts it again.

*Admin console → HFT · order book engine* shows whether it is running and how
it is doing: orders, trades and shares, how long it takes to handle an order
(the typical time, and the time 99 in 100 and 999 in 1,000 beat), its busiest
second, and anything it refused or lost.

Each US market session is a session of its own in HFT: at the opening bell it
starts again with empty books sized for that day's prices. For every session it
leaves three files in the app's data folder under `hft/` (with the desktop app,
*Help → Open Data Folder*):

| File | What it is |
| --- | --- |
| `hft-session-<date>-<time>-<n>.stats.txt` | The session's statistics, as a page to read. `hft-stats.txt` is always the latest. |
| `…stats.json` | The same, for a program. |
| `….rec` | A recording of everything HFT was sent. `hft verify <file> <fingerprint>` replays it from nothing and confirms the engine did exactly the same again; the fingerprint is in the statistics. |

**Disk.** The recordings are the only part of this that takes real space, and
they are held to a fixed budget: a session's recording stops growing at 250 MB
(the session carries on unrecorded, and the statistics say so), and only the
two newest are kept, so HFT's folder never holds more than about 500 MB.
`HFT_RECORD_LIMIT_MB` and `HFT_KEEP_SESSIONS` change the budget. A session that
starts with less than 5 GB free on the disk is not recorded at all. Each
session's statistics, a few kilobytes, are also copied to `hft/history/`, where
they stay after the recordings have been cleared away. The Admin console shows
what HFT is using.

Running from source, build HFT once with `npm run hft:build` (it needs only a
C++ compiler; `npm run build:server` and the desktop app's build do it for
you). `HFT_MODE=off` switches it off. `npm run hft:sync` brings in a newer
version of the engine from its own repository.

What test mode is not: HFT's fills and the exchange's are worked out from
different books, so they agree only roughly; and orders that were already
working when a session began are not copied into it.

### The realistic sandbox: HFT decides the fills

A competition created with **Realistic fills** (*Admin console → New
competition*, or `fillModel: "hft"` over the API) is not filled from the
modelled book. Its orders are matched by an HFT of its own
([`backend/src/hft/hftVenue.ts`](backend/src/hft/hftVenue.ts)), and every other
competition carries on exactly as before.

- **Orders wait in line.** The market's own bids and offers rest in HFT's book
  as real orders: for every quote, the ten-level book `market/depth.ts` models
  for it. An order joins the back of the queue at its price. When the market
  shows less at a price, its newest orders there go first, whole.
- **The market's trades are real.** Each trade the feed prints goes into HFT as
  an order from "the street", at the print's price and size, and trades with
  the queue it meets in time order: the market's own orders first, then
  whoever joined after them.
- **The market moving through an order fills it** at the order's own price, as
  in standard competitions.
- **Orders take time to arrive.** Each order and cancel reaches the book after
  the competition's *order delay*, plus up to half as much again at random.
  An order can fill while its cancel is on the way, and a cancel is reported
  only when HFT confirms it.
- **The engine still owns every account.** It checks each order's risk, books
  every fill and reports it; only the matching happens in HFT. A market order
  there trades what the book holds and has the rest cancelled, as an IOC does.
  Stop orders wait in the engine until their price is reached, then go to HFT.

Each realistic competition gets its own HFT process, started with its first
order, so that sandboxes can never trade with each other (traders in one
sandbox do trade with each other). At most four run at once. Each records its
sessions under `hft-venue/<competition>/`, capped at 100 MB a session with two
kept (`HFT_VENUE_RECORD_LIMIT_MB`, `HFT_VENUE_KEEP_SESSIONS`): 200 MB at most a
sandbox. *Admin console → HFT* shows each one: orders working, fills, and how
many of the street's shares reached traders.

### HFT Strategy

HFT Strategy is a market-making program from Project 1 (`hftbot`) that trades
here through the binary gateway, in a realistic sandbox. It is started by hand,
never by itself, and writes `status.json` once a second, its session reports
and the market it saw to `hft-strategy/` in the data folder.

*Admin console → HFT Strategy · market maker* shows it while it runs: its
success rate as "X% (N of M trades)", live profit and loss (the exchange's own
figure for its account), each trade's average, its worst trade and drawdown,
its fill rate and adverse selection, what it holds, and how long its orders
take to be answered. **Kill switch** tells it to withdraw every order, close
every position and stop; if it is not running, the exchange cancels the
account's orders and closes its positions itself.

## The AT and HFT windows

Gomer Trading is one of three projects that fit together (see the
[Model Project](https://github.com/GOMER20/Model-Project) overview):
**HFT** is the order book engine (Project 1), Gomer Trading is the exchange
people trade on (Project 2), and **AT** is the trading algorithm that trades
on it (Project 3). In the desktop app the opening screen has a **Test Lab**
beside the sign-in box: a box for AT above a box for HFT, each with live
figures and a button that opens a window of its own (signing the owner in if
needed). The same windows open from *Trading → Algorithmic Trading (AT)* ⇧⌘A
and *Trading → High-Frequency Trading (HFT)* ⇧⌘H, and from the **AT ↗** and
**HFT ↗** links in the terminal's top bar.

- **AT window** (`/at`, `GET /api/at`): the success rate first ("X% (N of M
  trades)"), net result, equity, profit factor, average win and loss, longest
  losing run; the running result trade by trade; results by session; every
  finished trade with entry, exit and hold time; what is open now; the latest
  fills. Trades are rebuilt from the exchange's own fills, so they are what
  actually happened here. Below that, what AT measures about itself: the
  research that chose its settings (success rate on sessions it had never seen,
  against random entries) and its own report for each live session, read from
  AT's folder (`AT_HOME`, or `atHome` in the desktop app's `config.json`).
  AT is found by the label of its API keys (`AT_LABEL`, default `AT`).
- **HFT window** (`/hft`, `GET /api/hft`, `GET /api/hft/sessions`): the live
  panel from the admin console, and every recorded session side by side: time
  per order (typical and 99 in 100), orders, trades, anything refused or lost,
  and each recording's fingerprint.

"Owner" means an administrator, or the trader account the desktop app signs
its own user in to. Other traders, including those who join over the internet,
do not see the Test Lab, the links or the windows, and the server refuses them
the data.

## Quick start (web stack)

Requires Node.js 20.12 or newer. Docker is **not** required.

```bash
npm install
npm run dev
```

`npm run dev` does everything: creates `.env` (with a generated JWT secret),
starts project-local PostgreSQL and Redis if they are not already running,
applies migrations, seeds demo data, then runs the API, the leaderboard worker
and the web app together.

- Trading terminal: http://localhost:3000
- API: http://localhost:4000 (`GET /health`)

Log in as a demo trader (`TRADER01` … `TRADER10`) or as the administrator
(`ADMIN`). The passwords are the `SEED_TRADER_PASSWORD` and
`SEED_ADMIN_PASSWORD` values in `.env`. They are development defaults: change
them before anyone else can reach the app.

Out of the box prices come from the **built-in practice market** (the terminal
shows a "Simulated market" badge). See [Real-time prices](#real-time-prices) to
switch to real quotes.

### Other commands

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests for the accounting, pricing and risk rules, and the Alpaca integration against a local stand-in |
| `npm run smoke` | End-to-end test against a running stack: logs in, creates a competition, trades every order type, checks the money reconciles, the leaderboard updates, and a competition is settled with a winner. Creates its own throwaway traders. |
| `npm run loadtest` | Simulates a crowd of traders against a running stack. See [Staying up under load](#staying-up-under-load). |
| `npm run typecheck` | Type-checks backend and frontend |
| `npm run build` | Production build of both |
| `npm run services` | Only the local PostgreSQL + Redis |
| `npm run build:server` / `npm run serve` | Builds and runs the single-address server other people join. See [Competing with other people](#competing-with-other-people). |
| `npm run app:build` | Builds the macOS app: `release/Gomer Trading.dmg` |
| `npm run app:dev` | Runs the desktop app unpackaged |
| `npm run db:migrate` / `npm run db:seed` | Apply migrations / seed (both idempotent) |

To start over with a clean database, stop the app and delete `.data/`.

If you prefer Docker for the data stores, run `docker compose up -d` first;
`npm run dev` detects them on ports 5432 / 6379 and uses them instead.

## Folder structure

```
Project 2/
├── package.json               npm workspaces + top-level scripts
├── .env.example               every setting, documented
├── docker-compose.yml         optional Postgres + Redis
├── scripts/
│   ├── dev.mjs                one-command dev environment
│   ├── dev-services.mjs       project-local Postgres + Redis
│   ├── build-server.mjs       builds the single-address server
│   ├── serve.mjs              runs and supervises it
│   ├── build-hft.mjs          compiles HFT (npm run hft:build)
│   └── sync-hft.mjs           copies a newer HFT in from its own repository
├── hft/                       HFT, the order book engine (C++): its source, and how it is built
├── backend/
│   ├── db/migrations/
│   │   └── 001_init.sql       Phase 1: schema
│   ├── scripts/smoke.ts       end-to-end test
│   ├── test/                  unit tests
│   └── src/
│       ├── index.ts           API process entry (HTTP + WebSocket + feed + engine)
│       ├── app.ts             Express app
│       ├── config.ts          validated environment config
│       ├── types.ts           shared types and row/DTO mapping
│       ├── db/                pool, transactions, migration runner, seed
│       ├── redis/             client and key names
│       ├── middleware/        auth (JWT), risk gate, rate limits, errors
│       ├── controllers/       request validation, thin handlers       ┐ Phase 2
│       ├── routes/            URL → middleware → controller wiring    │
│       ├── services/          auth, users, competitions, portfolios,  │
│       │                      leaderboard                             ┘
│       ├── market/            feed hub, practice market (model.ts),   ┐
│       │                      real-time data adapter                  │
│       ├── ws/gateway.ts      WebSocket server                        │ Phase 3
│       ├── engine/            matching engine, pricing, accounting,   │
│       │                      risk rules                              ┘
│       ├── hft/               HFT in test mode: starts it, copies every price and order
│       │                      to it (hftMirror.ts), talks its protocol (hftClient.ts)
│       └── workers/
│           └── leaderboard.worker.ts                                    Phase 5
├── desktop/                   the macOS app
│   ├── main.mjs               Electron shell: starts Postgres, Redis, API, worker; opens the window
│   ├── preload.cjs            the bridge exposed to the page (one-click sign-in, open settings)
│   ├── settings.html          Market Data window, wired by settings-preload.cjs
│   ├── selftest.mjs           built-in diagnostics (GOMER_SELFTEST_DIR)
│   ├── loading.html           splash shown while services start
│   └── scripts/               stage.mjs (assemble resources), build-redis.mjs, make-icon.mjs
└── frontend/
    └── src/
        ├── app/               login, terminal (/), admin console
        ├── components/terminal/
        │   ├── Terminal.tsx   multi-panel layout                      ┐
        │   ├── ChartPanel.tsx Lightweight Charts, live candles        │
        │   ├── OrderTicket.tsx                                        │ Phase 4
        │   ├── Blotter.tsx    positions, open orders, history         │
        │   ├── Leaderboard.tsx                                        │
        │   ├── Watchlist.tsx, TopBar.tsx, Toasts.tsx                  ┘
        ├── store/             Zustand: auth, market, trading, ui
        └── lib/               API client, WebSocket client, formatting
```

## What traders get

**Order types**

| Type | Behaviour |
| --- | --- |
| Market | Trades through the book at once: the ask first (the bid, for a sell), plus $0.01 a share slippage, then worse prices if the order is bigger than what is offered there. |
| Limit | Fills at your price or better. What cannot fill straight away rests at your price until the market reaches it. |
| Stop | Waits for the market to reach the stop price, then goes in as a market order. The usual stop-loss. |
| Stop-limit | Waits for the stop price, then works as a limit order, so it never fills beyond the limit. |

A buy stop must be above the market and a sell stop below it; the ticket says so if not.

**Alerts** (the *Alerts* tab under the chart). A short chime when an order fills,
and a system notification when the app is not the window in front; both can be
switched off. **Price alerts**: pick a symbol, type a price and you are told the
moment it gets there (on screen, with a chime and a notification); it works out
for itself whether that means rising or falling to it, and goes off once. Price
alerts are checked in the terminal against every quote, so they work while the
terminal is open (the desktop app keeps it open in the Dock).

**Brackets.** Switch **Bracket** on in the ticket and give a *Target +* and a
*Stop −*, each a distance in dollars per share from the entry (either can be
left empty). When the order fills, a take-profit limit and a stop-loss go to
work for the same size:

- one cancels the other: when either fills, its partner is cancelled;
- they only ever reduce the position. They never open one the other way, they do not tie up shares or buying power, and they do not stop you closing by hand;
- closing the position by any route cancels both.

The same distances serve buys and shorts; the ticket shows the exit prices for
each before you send. With hotkeys armed, **B** and **S** carry the bracket too.
An order that would reduce a position goes without one. Exits appear in *Open
orders* tagged OCO and on the chart as TARGET and STOP-LOSS lines.

**Level 2 and partial fills.** The panel under the watchlist shows the order
book: the shares bid and offered at each price, ten levels a side (**L2**; the
**Tape** button swaps it for time and sales). Click a price to load it into the
ticket. Orders trade against this book:

- an order takes the shares at each level in turn, so one bigger than the best offer fills in pieces at successively worse prices. Every piece is listed under **Fills**; the order's *Avg fill* is their average;
- an order bigger than the whole book fills what it can and keeps working, showing as PARTIAL, while the book refills. Cancelling it keeps what has filled;
- a resting limit order fills at its own price for as many shares as the market offers there, so it too can fill in pieces;
- what an order takes stays out of the book for a few seconds, so slicing a large order into small ones gets no better a price.

Only the best bid and offer come from the price feed. **The levels behind them
are modelled** (a price every cent, with sizes that grow away from the touch),
on real-time prices just as on the practice market: no feed available to this
app carries the exchanges' real depth. On the practice market a fill also moves
the price; real prices cannot be moved.

**Commission.** A competition can charge commission per share (set when it is
created; zero by default). It is charged on every share that trades and comes
straight out of cash, so equity, return and the leaderboard are after
commission. The ticket shows what an order will cost; *Order history*, *Fills*
and *Performance* show what was paid.

**Margin calls.** An account that borrows (leverage above 1) or sells short can
lose more than it put up, so each competition has a margin call level (25% by
default; zero switches it off). The top bar shows **Margin**: equity as a share
of everything held. If it falls below the call level, the platform cancels the
account's working orders and closes its positions at the market, marked
*Margin call* in the order history. A warning appears before that point. An
account that neither borrows nor shorts sits at 100% and can never be called.

**Hotkeys.** Off until you click **Hotkeys** in the order ticket. They use the
quantity in the ticket and send immediately, with no confirmation.

| Key | Action |
| --- | --- |
| `B` / `S` | Buy / sell at market |
| `Shift+B` / `Shift+S` | Buy limit at the bid / sell limit at the ask |
| `F` | Flatten the position in the current symbol |
| `C` | Cancel working orders in the current symbol |
| `+` / `-` | Quantity up / down 100 |

**Charts.** Candles over 1m / 5m / 15m / 1h with volume, EMA 9, EMA 20 and VWAP
overlays, and lines for your average price, working limits and stops.

**Time & Sales.** Every trade in the selected symbol as it prints.

**Performance.** Your rank, return, realized P&L, number of trades, win rate,
profit factor and best / worst trade. The order history exports to CSV.

**Results and the winner.** *Full table* on the leaderboard shows every trader's
standing and record at any time. When the competition's end time passes, the
worker settles it once: every open position is closed at the final price, so
each account is plain cash and can no longer move. The trader with the highest
equity is the winner (equal equity is a tie), the terminal announces it, and the
standings are marked final.

## How it works

```
                 ┌─────────────── API process ────────────────┐
 Alpaca stream ─▶│ MarketDataService ──▶ WebSocket gateway ───┼──▶ browsers
 (or simulator)  │        │   │                               │
                 │        │   └──▶ MatchingEngine ──▶ Postgres│
                 │        ▼                                   │
                 │   Redis quote cache        Express REST ◀──┼─── browsers
                 └────────┼───────────────────────▲───────────┘
                          ▼                       │ pub/sub
                 ┌─ Leaderboard worker ─┐         │
                 │ every 10s: NAV per   ├─▶ Redis sorted sets
                 │ portfolio            ├─▶ Postgres (equity, buying power)
                 └──────────────────────┘
```

### Phase 1 — data model

`backend/db/migrations/001_init.sql`

- **users** — `trader_id` (unique), bcrypt `password_hash`, `role` (`ADMIN` / `TRADER`).
- **competitions** — name, start/end, `starting_balance` (default 100,000), plus two risk settings: `allow_shorting` and `leverage`.
- **portfolios** — one per (user, competition): `cash`, `buying_power`, `total_equity`, `realized_pnl`.
- **positions** — (portfolio, ticker) → signed `quantity` (negative = short) and `average_price`. A flat position has no row.
- **orders** — type (`MARKET` / `LIMIT`), side, status (`OPEN` / `FILLED` / `CANCELLED` / `REJECTED`), quantity, `limit_price`, `fill_price`, `realized_pnl`, timestamps.

All money is `NUMERIC` in the database and `Decimal` in the engine; it never
passes through a floating-point number on the way to a balance.

### Phase 2 — API

All routes are under `/api` and, except login, need `Authorization: Bearer <jwt>`.

| Method & path | Who | Purpose |
| --- | --- | --- |
| `POST /auth/login` | anyone | Trader ID + password → JWT (rate limited) |
| `POST /auth/join` | anyone with an invite code | Create your own account and join that competition |
| `GET /invites/:code` | anyone | What an invite code opens |
| `POST /invites/:code/join` | user | Join another competition with its code |
| `PUT /competitions/:id/invite` | admin | Open or close sign-up by invite code |
| `GET /market/hours` | anyone | US market hours as absolute times, and whether this server's prices ignore them (`alwaysOpen`) |
| `GET /auth/me` | user | Current user |
| `GET /users`, `POST /users` | admin | List / create accounts |
| `GET /competitions` | user | Competitions you are in (admins see all) |
| `POST /competitions` | admin | Create a tournament, optionally enrolling `traderIds` |
| `POST /competitions/:id/participants` | admin | Enrol traders, each with a fresh starting balance (idempotent) |
| `PUT /competitions/:id/balance` | owner | Change the money every account starts with `{ startingBalance }`; cash moves by the difference |
| `GET /competitions/:id/leaderboard` | participant | Top N from Redis plus your own rank |
| `GET /competitions/:id/results` | participant | Every trader's standing and record; the winner once final |
| `GET /portfolios/:competitionId` | user | Cash, buying power, equity, P&L, open positions |
| `GET /portfolios/:competitionId/positions` | user | Open positions marked to market |
| `GET /portfolios/:competitionId/orders` | user | Account history (`?status=&limit=&offset=`) |
| `POST /orders` | user | Place an order (auth → throttle → risk gate → engine) |
| `DELETE /orders/:id` | user | Cancel a resting limit order |
| `GET /market/quote/:symbol`, `/market/bars/:symbol`, `/market/symbols` | user | Snapshot, chart history, symbol search |

Errors are always `{ "error": { "code", "message" } }`. A trading-rule refusal
is HTTP 422 with code `ORDER_REJECTED` and a human-readable reason.

### Phase 3 — market data and execution

**Feed.** `MarketDataService` merges provider ticks into one Level 1 quote per
symbol, reference-counts upstream subscriptions, and fans quotes out to the
WebSocket gateway (coalesced to 5 updates per second per symbol), the matching
engine, and a Redis hash the worker reads.

**WebSocket** (`ws://localhost:4000/ws`). The first message must be
`{type:"auth", token}`; then `subscribe` / `unsubscribe` symbols and follow a
`leaderboard`. The server pushes `quote`, the caller's own `order` updates, and
`leaderboard` refreshes.

**Matching engine** (`engine/matchingEngine.ts`). Execution rules:

| Order | Fills | Price |
| --- | --- | --- |
| Market buy | immediately | ask **+ $0.01** slippage |
| Market sell | immediately | bid **− $0.01** slippage |
| Limit that crosses the spread on arrival | immediately | as a market order, but never worse than the limit |
| Resting limit | on the first quote where the ask ≤ limit (buy) or bid ≥ limit (sell) | the limit price, no slippage |

**Orders are answered from memory.** The engine holds every account it trades
(cash, positions, working orders) in memory (`engine/ledger.ts`) and decides an
order there, in one thread, with nothing to wait for: the risk rules are re-run
against the live balances and the order, the position and the balances change
together before anything else can run. That is what makes concurrent orders
safe (two orders can never both spend the same buying power) and what makes an
order take a fraction of a millisecond.

Each decision is appended to a journal file before it is answered, and written
to Postgres a few milliseconds later by a background writer, many decisions per
transaction (`engine/store.ts`). If the process dies, the next start replays
whatever was journalled but not yet in the database; the database records how
far it has got in the same transaction as the rows, so nothing is applied twice
or missed. Screens that list orders and fills wait for the writer first, so
they always include what was just done.

**Risk management** (`middleware/risk.ts`, rules in `engine/risk.ts`). Before
an order reaches the engine it is refused if:

- the trader is not in the competition, or the competition is not running
- the symbol has no live quote (market orders also need a fresh one, which is what blocks them while the real market is closed)
- it sells more shares than are held, where the competition disables shorting
- it needs more buying power than is available

Buying power is `equity × leverage − gross exposure − reservations for resting
orders`. Orders that only reduce a position never need buying power, so a
trader can always get flat.

### Phase 4 — trading terminal

- **Layout** — account bar, watchlist, chart, order ticket, positions / open orders / history, leaderboard. Three columns on desktop; stacks and scrolls on a phone.
- **Chart** — history over REST, then the forming candle is built from the live WebSocket quotes. 1m / 5m / 15m / 1h. Lines mark your average price and working orders.
- **Order ticket** — Level 1 bid/ask with sizes (click a side to load its price), quantity, Market / Limit, Buy and Sell.
- **Positions** — average price, current price and unrealized P&L recalculated on every tick; one-click close.
- **Leaderboard** — top 10 by total equity from Redis, pushed over the WebSocket after each worker pass, with your own rank shown when you are outside the top 10.
- **Admin console** (`/admin`) — create traders and competitions, enrol traders.

### Phase 5 — live P&L and leaderboard worker

`backend/src/workers/leaderboard.worker.ts`, a separate process. Every 10
seconds, for each running competition, it loads all portfolios and positions,
reads the latest prices from the Redis quote cache, computes each portfolio's
NAV (`cash + Σ quantity × price`), persists equity and buying power to
Postgres in one statement, atomically replaces the competition's Redis sorted
set, and publishes the new top N. A Redis lock makes extra replicas harmless.
If Redis is ever flushed, the API rebuilds a board from Postgres on demand.

## The practice market

Until a market-data key is connected, and whenever you choose it, the platform
trades on its own market (`backend/src/market/model.ts`). It needs no account
and no network. **Its prices are not real-world prices**, and the terminal
labels it "Simulated market".

**It keeps the hours of the US stock exchanges.** It opens at 9:30 am and
closes at 4:00 pm New York time on trading days (7:00 pm to 1:30 am in India
for most of the year; see [Market hours](#market-hours)), with the same
holidays and early closes, and stands still in between: the terminal shows
"Market closed" and when it opens next. While it is closed:

- prices and charts do not move, and accounts are valued at the last close;
- a market order is refused, because there is nothing to trade against;
- a limit or stop order is accepted and waits for the opening bell.

Each session opens away from the last close, as real stocks do (the whole
market, each sector and each company get their own overnight move, a little
larger after a weekend). An order left waiting that the open has jumped past
trades at the opening price, not at its own: a buy limit at $236 when the stock
opens at $214 is filled at about $214. Charts hold trading minutes only.

To practise or test at any hour, set it to run around the clock instead: in
the app, **Market Data…** (or click the badge in the top bar) → *Practice market
hours* → *Around the clock*; on the web stack, `PRACTICE_MARKET_HOURS=always`
(which is what `.env.example` uses, so the test suites always have a moving
market). The default everywhere else is `exchange`.

It is built to behave like a market rather than a random number generator:

- **Mood.** The market as a whole is calm, steady, rallying, selling off or turbulent, and moves between them.
- **Sectors.** Stocks in a sector move together; sector trends rotate slowly. Index funds follow the market and their sectors.
- **Volatility clusters.** Quiet spells and stormy spells both persist.
- **Gaps.** Now and then a stock is abruptly re-priced.
- **It reacts to trading.** Buying lifts a price and selling presses it, more for bigger orders, and the push fades.
- **It remembers.** State and one-minute chart history are kept in Postgres, so prices and charts continue across restarts instead of starting over.

## Real-time prices

Out of the box prices come from the practice market. Real prices come from
[Alpaca](https://alpaca.markets), whose free plan includes real-time quotes
from the IEX exchange. You need your own (free) Alpaca account; the keys cannot
be created for you.

1. Create an account at https://app.alpaca.markets.
2. In the dashboard choose **Paper Trading**, then **API Keys → Generate**.
3. Give the keys to Gomer Trading:
   - **Desktop app:** click the **Simulated market** badge in the top bar (or *Gomer Trading → Market Data…*, ⌘,), paste both values, press **Test**, then **Save and Restart**. Keys that do not work are never saved.
   - **Web stack:** set `ALPACA_API_KEY` and `ALPACA_API_SECRET` in `.env` and restart `npm run dev`.

The badge in the top bar always says what you are looking at:

| Badge | Meaning |
| --- | --- |
| **Simulated market** | The built-in practice market. Not real prices. |
| **Real-time prices** | Live quotes are arriving from Alpaca. |
| **Market closed** | Connected, but nothing has traded for a few minutes: you are seeing the last session's prices. US stocks trade 9:30 am to 4:00 pm New York time on weekdays. Market orders are refused; limit orders rest until the open. |
| **Price feed problem** | Alpaca refused the connection. A banner says why (rejected keys, a feed your plan does not include, or the one-connection limit). |

Notes:

- The free `iex` feed streams at most 30 symbols and only reflects trading on the IEX exchange, so bid/ask can be wider than the national best. `sip` is the full-market feed and needs a paid Alpaca data plan.
- Alpaca allows **one live connection per account**. Running the desktop app and the web stack with the same keys at the same time leaves one of them with a "Price feed problem" until the other is closed; it then reconnects by itself.
- Keys are stored in plain text on your machine (`config.json` in the app's data folder, or `.env`), readable only by your user account. They are used to read prices; nothing is ever sent to Alpaca's order API.
- Alpaca is used for **market data only**. Its paper-trading order API is deliberately not used for execution: an Alpaca paper account is a single account, so it cannot hold a separate $100,000 balance per trader per competition. Execution, balances and risk are handled by this project's engine against Alpaca's quotes.

### Market hours

Real-time prices only move while the US market is open: 9:30 am to 4:00 pm New
York time, Monday to Friday. The terminal shows the next open or close in *your*
time zone, and the Admin console can fill a new competition's start and end
with the next session.

In India (IST) it is an evening session, and it shifts by an hour when the US
changes its clocks (India does not):

| While the US is on | Dates | Opens (IST) | Closes (IST) |
| --- | --- | --- | --- |
| Daylight time | second Sunday of March to first Sunday of November | 7:00 pm | 1:30 am |
| Standard time | the rest of the year (from 2 November 2026) | 8:00 pm | 2:30 am |

The calendar (`backend/src/market/usMarketHours.ts`) follows the exchanges'
rules: closed on weekends and the ten market holidays, and closing at 1:00 pm
New York time (11:30 pm IST) on the day after Thanksgiving and on Christmas Eve
and 3 July when those are trading days. It is tested against NYSE's published
2026 and 2027 calendars. It cannot know about unscheduled closures; the live
feed is the final word. The practice market keeps the same calendar unless it
is set to run around the clock.

Why a key at all: stock exchanges license their price feeds. Sterling, Alpaca
and every broker pay for them; there is no open, account-free connection to an
exchange. A data key is that licence at the smallest scale. If you later hold
your own agreement with an exchange or vendor, its feed plugs in at
`backend/src/market/provider.ts` in place of the Alpaca adapter.

Showing one account's real-time quotes to many traders (a public competition)
counts as redistribution, which the free plan does not allow: ask the data
provider for a plan that covers it before you run a large event on real prices.

**How this has been verified.** The integration is tested against a local
stand-in that speaks Alpaca's protocol (`backend/test/alpaca.test.ts`):
authentication, subscriptions, quotes and trades, snapshots, chart history,
rejected keys, dropped connections and the connection limit. The stand-in's
handshake and error responses were checked against Alpaca's real servers. What
has **not** been run is a full session with a real account, because that needs
your keys: the first time you connect, check that the watchlist prices match
another source.

## Staying up under load

The server is built to slow down gracefully rather than fall over:

- **It sheds load.** When the event loop falls behind, new API requests get an immediate `503` with `Retry-After` instead of piling up; prices keep streaming.
- **Sign-in has its own lane.** Password hashing runs on dedicated threads, a few at a time, with an orderly queue. A rush of sign-ins cannot take the processor or the database connections away from people who are already trading. Past the queue's limit, people are told to retry in a few seconds.
- **Nothing waits forever.** Database statements, idle transactions, HTTP requests and WebSocket handshakes all have timeouts; the connection pool is bounded; a sharp move that triggers hundreds of resting orders fills them a few at a time.
- **Limits per client.** Order rate per trader, WebSocket connections per trader and in total, request rate per address, and login attempts per trader ID.
- **It recovers.** An unexpected error ends the process cleanly; on start the journal is replayed and every balance and resting order is rebuilt from Postgres. The desktop app restarts a failed service by itself. For a server deployment run the API and worker under a supervisor (systemd, pm2 or a container restart policy).
- **It tells you how it is doing.** `GET /health` reports event-loop delay, the database pool (open / idle / waiting), and the server's own response times for trading requests and sign-ins.

`npm run loadtest` proves it. It signs in a crowd (300 traders for 30 seconds
by default; `TRADERS=600 SECONDS=60 npm run loadtest`), has each one stream
quotes, place orders and poll their account, and fails if the server errors,
drops connections, or gets any sampled account's cash wrong. A separate
"observer" process trades once a second and reports what one person experienced.

Measured on the development laptop (8 cores, with the test crowd, a browser and
the desktop app all running on the same machine):

| Crowd | Result |
| --- | --- |
| 150 traders | Orders answered in about 2 ms (95% under 20 ms). No errors, every sampled account exact. |
| 300 traders | Orders answered in about 2 ms (95% under 20 ms). Everyone signed in, no errors, no dropped connections, every sampled account exact. |
| 600 traders | Orders answered in about 18 ms (95% under 120 ms). No errors, no dropped connections, every sampled account exact. Two thirds of the crowd were told "busy, try again" once while all 600 signed in within the same few seconds, and got in on the retry. |

These are orders placed over HTTP from the trading terminal. Trading programs
on the bot gateway are answered in about a fifth of a millisecond; see
[`docs/gateway/README.md`](docs/gateway/README.md#latency-measured).

In every run, at every size, the server stayed up and the books stayed right.
Capacity is set by the machine: the engine is a single process (see below), so
a bigger crowd needs a faster server rather than more of them. Run the load
test on the real server, at the size you expect, before a large event.

## Known limits

- **One engine instance.** Accounts and resting orders live in the API process's memory (rebuilt from Postgres on start), so run a single API process, and change account rows only through it: never edit cash, positions or orders in the database while it is running. Scaling out would mean moving the feed and engine into their own service.
- **A power cut can lose the last fraction of a second.** Every order is journalled before it is answered, which survives the app or the server process crashing. The journal is forced to disk about four times a second, so if the machine itself loses power, orders answered in the last quarter of a second or so may be missing afterwards. The database is never left inconsistent.
- **Depth is modelled, not real.** Only the best bid and offer come from a feed; the levels behind them, which decide how a large order fills, are an estimate. Real Level 2 needs a paid exchange data licence.
- **Sharing from the desktop app depends on the Mac and on a free relay.** The link changes on every restart, the Mac must stay awake, and Cloudflare's quick tunnels carry about 100 traders at once with no uptime promise. A permanent address needs the server. The bundled `cloudflared` and Tailscale programs are the Homebrew builds for the macOS they were built on, so *sharing* needs that macOS version or newer even though the rest of the app runs on macOS 13 (set `CLOUDFLARED_PATH` / `TAILSCALE_DIR` to other builds before `npm run app:build` to change that).
- **Session tokens** are JWTs held in the browser's localStorage and valid for 12 hours. Changing or resetting a password, or deactivating the account, ends them at once.
- **No dividends, splits or borrow costs.** Commission is per share only (no minimum, no exchange fees). Limit and stop orders are good-till-cancelled and are cancelled when the competition ends.
- The practice market's prices are generated by the app. They are not real and say nothing about the actual market. It follows the exchanges' calendar and hours, but not pre-market or after-hours trading, and a market order sent while it is closed is refused rather than queued for the open.

## Going to production

- Set `NODE_ENV=production`, a strong `JWT_SECRET`, real database credentials, and `CORS_ORIGIN` to your site's origin.
- Build with `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` pointing at the public API (`https://` / `wss://`), then `npm run build`.
- Run `npm run db:migrate:prod -w backend`, then `npm start -w backend`, `npm run start:worker -w backend` and `npm start -w frontend` behind a TLS-terminating proxy (set `TRUST_PROXY=1`).
- In production the seed creates only the admin account, from `SEED_ADMIN_ID` / `SEED_ADMIN_PASSWORD`.
