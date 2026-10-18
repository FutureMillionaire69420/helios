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

## v3.2 (speed, 15% filter, fees at the maximum, tests c and d, holder rule)

**Speed (every item measured in the bot):**
1. **SOL price in the background.** It is refreshed every 15 s and never looked up during a buy. This took about 170 ms per buy before, and once took 4.2 s.
2. **Confirmations are pushed.** The websocket says "confirmed" the moment it happens. Polling every 0.3 s stays on as the backup; it was 0.8 s before.
3. **Detection in exact blocks.** Each alert says "seen N blocks after his". The old seconds number was rounded by his whole-second clock.
4. **One entry premium:** the bot's price per token vs Decu's (price vs price). Fees show separately on the same line ("fees X SOL, Y% of the trade"). Old records keep the old (cost) basis.
5. **Filters side by side:** every alert shows `Filters: 10% … · 15% (trading) … · 25% …`. The dashboard compares them on the same trades.
6. **Fees at the top of the market** (`FEE_MODE=max`):
   - priority fee = the Helius estimate at VeryHigh
   - tip = Jito's 99th percentile of landed tips
   - refreshed every 10 s in the background
   - capped at 0.003 + 0.005 SOL per side (up to ~16% round trip on 0.1 SOL)
   - the safety check allows exactly the fee put in the transaction, never above the caps
7. **Prices pushed for exits.** Every change of a held coin's bonding curve arrives over the websocket and is checked at once, including the stop-loss. Polling every 0.5 s stays as the backup.
8. **Stop-loss alternatives in paper:**
   - test **c**: -20% counted on your money
   - test **d**: sell when the holders' money (dev excluded) falls behind the market cap

   The real stop always sells.
9. **Fair exit comparison:** every exit is compared with your rules on the same trades, chosen on older trades and checked on newer ones.
10. **Incomplete results are not zeros.** A trade without data for a test is left out and counted as such.
11. **Timing bug fixed:** a second build attempt starts with clean timings. An earlier attempt's stamps once made a buy look 111 s slow.

**Also:**
- **Holder money rule**, on every alert (SAFE / RISKY) and as a brain pattern. It counts the dollar value of the coins held by every wallet except the dev:
  - $1,000 at a $10k market cap
  - $2,500 at $20k
  - $4,000 at $30k

  The dev is the coin's creator, taken from Decu's own trade event. Set with `HOLDER_RULES`. Report only.
- **Skipped buys:** a phone alert only when the buy was inside 25% (`SKIPPED_ALERTS=report`).
- **Local build:** derived addresses are remembered. Building a buy for a new coin dropped from ~6 ms to ~3.5 ms, and to ~0.2 ms for a repeat.
- **`NTFY_TOKEN`:** an ntfy access token lifts the free daily alert limit.
- **Faster buy path** (from seeing Decu's buy to "ready to send"):
  - The save file is written **once** before the send instead of five times. That one write holds the signed transaction, as before. The other steps save and log a moment later, while the bot waits on the network. Measured with a 690 KB state: 23 ms → 8 ms.
  - Paper builds like the live builder: the expected tokens come from Decu's own trade, with no network call (about 60 ms less in paper).
  - **Live:** the connection to Helius Sender is kept open with a free ping every 3 s, so a buy never waits for a new connection (about 50–150 ms).
  - On Render, the Salt Lake City Sender is used (closest to Oregon). The API key is never sent over plain http.
  - Decu's full transaction for a buy already acted on is fetched 0.5 s later. It can't exist sooner, so the earlier attempts only used credits and the connection.
  - The holder check runs only after the buy, in the background. It reads that coin's holders only, never their whole wallets.
- **Spreadsheet:** new columns for detect blocks, premium basis, fees, holder rule, and tests c and d.
- **Tests:** 116/116 pass. New tests cover:
  - the push stream (reconnect and a stalled socket included)
  - the holder rule
  - tests c and d
  - the filter labels
  - a push-driven stop
  - max fees in paper P&L
  - exact blocks
  - fee caps
  - the non-blocking SOL price
  - pushed confirmation
  - the holder money (curve and dev excluded)
  - the dev taken from Decu's trade event
