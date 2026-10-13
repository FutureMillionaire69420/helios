# Decu bot v3: changes

## A. Execution latency is measured stage by stage

- Every copy records these stages:
  - Decu's block and clock
  - when the bot saw it
  - decode, decision and build/sign
  - send (live)
  - landing, plus the block it landed in
- The websocket now passes the block number of Decu's trade.
- Paper records the simulated 1.0 s wait separately and estimates the landing block.
- Each trade alert has a `Latency:` line. The research panel and the `study` command show median and p95.
- `node bench.mjs` benchmarks the bot's own work: about 6 ms to build and sign.

## B. New wording

"Late by" is now **execution latency**, and "paid above Decu" is now **entry premium**. This applies to alerts, notes and the brain's patterns.

## C. Entry-premium filter

- **Live:** skips buys more than **60%** above Decu's price (`MAX_PAY_ABOVE_DECU_PCT`, default 60).
  - Local builder: enforced on-chain.
  - PumpPortal path: checked before signing, using a quote fetched at the same time as the transaction, so it adds no wait.
- **Paper:** buys everything (`PAPER_MAX_PAY_PCT`, default 0). Every alert says **TAKE** or **SKIP**, and summaries show the filtered total.

## D. Research and learning

- Every Decu buy the bot did **not** take is studied anyway and alerted as **SKIPPED**. This covers buys skipped by the filter, by pause, by the style being off, as too late, or because the buy failed.
- Totals for bought trades and for all Decu buys are kept apart.
- `/api/research` reports win rate, profit factor, max drawdown, entry premium, latency percentiles, skip reasons and the latest buys.
- New brain pattern: "blocks after Decu".
- The advisor is **walk-forward**: it chooses on the oldest 70% of trades and judges on the newest 30%. It says "SUPPORTED" only with 50+ trades and a gain on both parts. It never changes a setting.

## E. Exit comparison

The advisor compares these exits with a 1 s sell delay, using only past information:
- your current rules
- sell at 3, 5 or 10 s
- trailing stop 10% or 20%
- half at the +gain gate

Your current exit rules are unchanged.

## Also

- `DAILY_LOSS_LIMIT_SOL` (default 0 = off): no new buys for the rest of the day after closed trades lose that much.
- iPhone dashboard:
  - research panel and latest Decu buys (bought or skipped)
  - **EMERGENCY STOP** (no new buys)
  - **Sell everything**, which asks twice before selling
  - the spending line shows "(no cap)" and today's P&L
- `RESEARCH.md` has the latency vs. entry-premium study.
- Tests: 90/90 pass. New tests cover:
  - latency timing
  - studies of skipped buys
  - walk-forward accepting and rejecting changes
  - exit strategies with a sell delay
  - research numbers
  - the loss limit
  - the paper vs. live filter

## v3.1 (your choices after the review)

- **30% entry-premium filter, fail-closed.** No Decu price or no current price means no buy, in all three build paths (paper, local builder, PumpPortal). Paper uses the same filter, and skipped buys are still studied (no phone alert unless `SKIPPED_ALERTS=true`).
- **At most 2 coins open at once** (`MAX_OPEN_POSITIONS=2`): held coins plus buys in progress.
- **Daily spending cap of $600** (`DAILY_CAP_USD`), converted with Decu's own trade price, so no extra API call. Paper and live. No daily loss limit.
- **Decu's sell must be confirmed** before the bot sells (`FAST_PATH_SELLS=false`). Buys keep the fast path.
- **Stop-loss reliability:**
  - prices checked every 0.5 s, each check gives up after 1.5 s
  - 3 failed checks → alert; 6 failed checks → sell anyway
  - sells allow 35% slippage
  - a failed sell is retried 3 times at once, then **CAN'T SELL** is alerted and the bot keeps trying
- **Stop-loss alerts:** STOP TRIGGERED → SELL SENT (live) → POSITION CLOSED, comparing the trigger with the real fill.
- **Circuit breakers** (new buys only): 3 failed buys in a row → 10-minute pause. Helius websocket down for 30 s → no new buys until it is back.
- **Dashboard:** open coins out of the maximum, spending against the $ cap, and why buys are blocked.
- **Tests:** 97/97 pass (new: max positions, $ cap, breaker gate, confirmed-only sells, price-failure sell, sell retries and CAN'T SELL, close alerts).
