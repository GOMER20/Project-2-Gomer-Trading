# HFT

HFT is the order book matching engine from the "Project 1 - Low Latency Order
Book" repository (github.com/GOMER20/Project-1-Low-Latency-Order-Book), built as
a program of its own. Gomer Trading starts it beside the trading server and
talks to it over a local socket; see `backend/src/hft/` for that side and the
"HFT" section of the main README for what it does here.

- `src/` is a copy of that repository's `include/lob/` and `hft/` at the commit
  named in `VERSION`. Do not edit it here: change it there, then copy it again
  with `npm run hft:sync`.
- `npm run hft:build` compiles it to `hft/bin/hft` for running from source
  (`npm run dev`, `npm run serve`). The desktop app's build compiles its own
  copy, for macOS 13 and later.

The engine is C++20 with no dependencies; building it needs only the Xcode
command line tools.
