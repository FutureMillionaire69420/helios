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
- **Bot power ON / OFF** (dashboard). OFF stops every Helius and Solscan use:
  - Decu's websocket, the backup poll and the Solscan watcher
  - the push stream
  - the SOL price, fee and balance refreshes
  - price checks of held coins

  The dashboard stays up. The choice survives restarts. `BOT_POWER=on/off` on the server wins once when changed. In LIVE, OFF asks first while coins are held.
- **Backup poll:** while the websocket is healthy, it no longer asks Helius every 5 s (the answer was ignored). That's about 17,000 fewer Helius calls a day.
- **Faster buy path** (from seeing Decu's buy to "ready to send"):
  - The save file is written **once** before the send instead of five times. That one write holds the signed transaction, as before. The other steps save and log a moment later, while the bot waits on the network. Measured with a 690 KB state: 23 ms → 8 ms.
  - Paper builds like the live builder: the expected tokens come from Decu's own trade, with no network call (about 60 ms less in paper).
  - **Live:** the connection to Helius Sender is kept open with a free ping every 3 s, so a buy never waits for a new connection (about 50–150 ms).
  - On Render, the Salt Lake City Sender is used (closest to Oregon). The API key is never sent over plain http.
  - Decu's full transaction for a buy already acted on is fetched 0.5 s later. It can't exist sooner, so the earlier attempts only used credits and the connection.
  - The holder check runs only after the buy, in the background. It reads that coin's holders only, never their whole wallets.
- **Spreadsheet:** new columns for detect blocks, premium basis, fees, holder rule, and tests c and d.
- **Tests:** 120/120 pass. New tests cover:
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

## v3.3 (local sell builder, lower fees, Solscan credits)

**Local sell builder, integrated with the local buy builder:**
- **One sell desk for the whole run, never rebuilt per trade.** A coin is armed the moment it is bought, from the same trade context the buy used. Its sell accounts are worked out once and its token balance is watched. The coin is disarmed only when fully sold. After a restart, held coins are re-armed from the saved position.
- **Built inside the bot.** Every sell (stop-loss, the +15% gate, Decu's sell, sell-all) is pump.fun `sell` with the 14 IDL accounts plus pump.fun's extra accounts, exactly as pump.fun's own SDK 4.1.0 builds it. A cashback coin adds the user's volume account; every sell adds bonding-curve-v2 and a buyback fee recipient.
  - Minimum SOL out: the live curve price less `SELL_SLIPPAGE_PCT`.
  - The sell math matches Decu's real sell to the lamport.
- **No round trip before the safety simulation.** The price comes pushed (or one read), the token balance comes pushed, and the SOL balance is cached. The build takes about 0.13 ms and signing 0.16 ms.
- **Before:** a token-balance lookup, a fresh balance lookup and a PumpPortal round trip, about 0.3-0.7 s before the simulation.
- **Same safety check as every trade.** If it refuses the local sell, the same sell is tried without the account close, then PumpPortal. PumpPortal also sells coins that left the curve (PumpSwap) or aren't quoted in SOL.
- **Token account closed when the sell empties it** (`CLOSE_TOKEN_ACCOUNT`): the ~0.002 SOL rent comes back on every coin, about 2% of a 0.1 SOL trade.
- **Paper assembles the same sell on every paper exit** (never signed or sent), so the desk is proven before live money depends on it. The dashboard shows armed coins, builds, closes and fallbacks.

**Local buy fix:**
- pump.fun added a 4th argument to `buy_exact_sol_in` (`partial_fill`, IDL after Oct 11). The local buy now sends it (false = all or nothing). A program without the argument ignores the extra byte.

**Fees:**
- Capped at 0.001 priority + 0.002 tip = **0.003 SOL per side**, down from 0.008. The paper data showed max fees took a third to over half of the profit, while being faster didn't buy cheaper.
- Fee estimates are refreshed every 30 s instead of 10 s.

**Solscan credits** (the plan was burning ~1.6M CU a day, 16,195 requests of 100 CU, mostly the watcher polling every 5 s):
- The watcher polls every 10 min while Helius is healthy and nothing is held, every 30 s while coins are held, and every 15 s while the Helius websocket is down. It doesn't poll at all when the bot is off.
- A hard daily budget (`SOLSCAN_MAX_PER_DAY` 2500) is counted across restarts.
- The SOL price comes from Jupiter / DexScreener first; Solscan is last.
- Expected: about 500-600 requests a day (~60k CU, about 96% less).

**Helius credits:**
- Holder lookups only for bought coins and skipped ones inside 25%.
- The SOL price no longer uses Helius first.
- Blockhash refresh every 3 s instead of 2 s (live).
- Fee estimates every 30 s instead of 10 s.

**Found and fixed in the final review (before any live money):**
- **The safety check now reads a closed token account correctly.** The simulation returns a closed account as 0 lamports with no data, not as "missing" (checked in Solana's RPC source). Token-2022 coins, which are most new pump.fun coins, come back this way. The check used to call that an invalid account, so every full sell would have failed its first simulation and needed a second one.
- **A pushed token balance is not trusted across a websocket reconnect.** The server only pushes changes, so a change made while the socket was down would be missed. Until the next push the bot reads the chain instead. The same rule now applies to pushed prices: the exit rules poll until the next price push after a reconnect.
- **After a failed sell, the next try reads the balance from the chain.**
- **A failed buy disarms its sell and closes its token-account watch,** so subscriptions don't pile up.
- **Re-arming a held coin (a second ladder buy) keeps the newest price.** An older price from the trade event never replaces a newer pushed one.
- **Arming the sell is off the buy's critical path.** It runs while the buy's safety simulation waits on the network, still well before the buy lands.
- **The "enough SOL for the sell fees" check applies to both sell builders.** A short cached balance is read again before a sell is refused.
- **Faster address math.** The on-curve test used for every new coin's addresses is 4.8× faster: one exponentiation instead of two, with a shift-based reduction. It gives identical answers on 200,022 test inputs and matches pump.fun's published addresses. Building a buy for a new coin dropped from 4.2 ms to 1.0 ms (p95 from 8.2 ms to 1.8 ms).
- **A stray empty Solscan counter file is no longer written** when Solscan is off (it is also gitignored).

**Tests: 138/138.** New in the review:
- the closed account as the RPC really returns it
- the stale pushed balance after a reconnect
- the subscription re-acknowledgment time
- LIVE buy → sell desk (armed and watched before the buy is sent; sells with no lookups after landing)
- a failed buy disarming
- the SOL re-read for sell fees
- pump.fun's published addresses

Earlier v3.3 tests:
- sell accounts vs pump.fun's IDL
- sell math vs Decu's real sell
- the sell transaction
- the safety check accepting a sell that closes the account
- the buy's partial_fill
- the curve decoder
- the sell desk
- a LIVE end-to-end stop-loss sell (local, no PumpPortal, pushed balance, account closed, disarmed)
- the fallback chain
- the Solscan budget and schedule

## v3.4 (PumpPortal feed: a second way to see Decu's trades)

**PumpPortal live trade feed** (`PUMPPORTAL_API_KEY`):
- One socket to PumpPortal, subscribed to Decu's wallet only, so every buy and sell of his is pushed alongside the Helius websocket.
- If PumpPortal is first, the bot copies his bonding-curve buy right away. Helius' copy of the same trade is ignored, so a trade is never bought twice.
- His sells are still acted on only once confirmed, and PumpSwap buys still wait for the confirmed transaction, as before. The 15% filter and every safety check apply unchanged.
- If PumpPortal starts a buy before Helius has delivered his trade details, one chain read gets the coin's creator, flags, price and token program, so the bot still builds the buy itself (no PumpPortal round trip, no 0.5% fee).
- **Feed race on the dashboard:** for each trade both feeds saw, which was first and the median lead in ms. That is real data on whether PumpPortal beats Helius.
- OFF closes the feed; ON opens it again. Reconnects are slow (2 s doubling to 60 s) because PumpPortal bans clients that open many connections. The key is never logged or saved in a file, and it is hidden in every event.
- Cost: PumpPortal bills 0.01 SOL per 10,000 trades it streams, to the wallet linked to the key. That's only Decu's trades, a fraction of a cent a day. Keep at least 0.02 SOL in that wallet.

**PumpPortal builder check:**
- PumpPortal charges 0.5% on every trade its builder makes (its fee page). The bot builds its own buys and sells and uses PumpPortal only as a fallback, mainly to sell coins that graduated to PumpSwap.
- Once per run while ON, a few seconds after one of Decu's buys, the bot asks PumpPortal's builder for a sample 0.01 SOL buy of that coin. It is never signed or sent.
- The bot records every instruction (programs, SOL transfers with recipient and amount) and whether the safety check accepts it. The result is on the dashboard and in the log.
- If PumpPortal charges its fee as a separate SOL transfer, the safety check refuses it, so PumpPortal can't be the fallback in LIVE. The pre-live `check` command fails the same way, and its error now names the recipient and amount.

**Sell desk fix:** Decu's trade event doesn't say whether a coin is a cashback coin, and a cashback coin's sell needs one more account. A live sell now reads the curve first when that flag isn't known yet; usually the first price push already tells. Older curve accounts without the flag bytes count as not cashback.

**Safety check:** the instruction rules are now a separate function shared by the full check and the builder check, with no change to what they accept.

**Tests: 146/146.** New:
- the feed (subscription, parsing, slow reconnects, the key never logged)
- PumpPortal-first buys (paper and LIVE with one chain read and a local build)
- no double buy
- his sells waiting for confirmation
- PumpSwap and other wallets not fast-copied
- OFF closing the feed
- the builder check
- a cashback coin sold with its extra account

## v3.4.1 (Solscan as a priority source)
- SOL price: Solscan first (every 2 min), then Jupiter / DexScreener / Helius if it fails or the day's budget is nearly used.
- Watcher while ON: every 5 s while coins are held or the Helius websocket is down, every 60 s otherwise. It is never used while OFF.
- Hard cap stays at 2,500 requests a day. When what's left only covers the day's price checks plus one look every 2 min, it slows to that pace so it never goes blind before 00:00 UTC.

## v3.5 (analytics charts on the dashboard and the phone)
- New **Analytics** section on the dashboard. It has 10 headline numbers and 15 charts, each with tap-for-value tooltips and a "Numbers" table:
  - running profit, profit per trade, profit per day, drawdown
  - result and win rate by entry premium
  - blocks after Decu, and result by blocks
  - profit by exit, hold time vs result
  - price path after the buy (average and middle half)
  - best second to sell, holder rule, where the profit goes, fees per trade
- Charts are drawn in the page, with no outside requests.
- **Bought trades only:** skipped buys ("what if" studies) and missed-trade reports are left out.
- **Realized results:** a closed-trade ledger records every position the bot closes (cost, profit, exit reason, hold time). Until it has trades, the money charts use each study's FCAT x the buy size, and say so.
- **No data credits:** everything is built from records the bot already keeps.
- **Phone:**
  - A daily digest of the 6 key charts goes out as ntfy pictures (QuickChart images), sent only when there are new trades. A dashboard button sends it now.
  - The ntfy budget is counted per day across restarts. Chart messages are capped at 12 a day and stop early near the ntfy limit, so trade alerts always get through.
  - Skipped-buy alerts are off by default (`SKIPPED_ALERTS=false`).
- **Tests: 150/150.**

## v3.5.1 (a chart for every bought coin)
- After each bought trade's alert, a second ntfy notification carries that coin's own chart, deconstructed:
  - the profit % line second by second
  - 3CAT / 5CAT / 10CAT / best second marked and named on the time axis, along with Decu's sell and the bot's exit
  - the stop-loss (red), the gain gate and break-even as labelled lines
  - a header with every number: FCAT, entry premium, delay, 3/5/10CAT, best, worst, PCAT, BAND in SOL, and win rates
- Its text reads the chart like a trader:
  - the shape (spiked and faded, climbed late, never made money)
  - the exits ranked best to worst in % and SOL
  - PCAT vs what you paid
  - whether the stop-loss or gain gate was hit, and when
  - BAND results
  - the win rate and average of each exit over all bought trades
  - how setups with the same entry premium did
- Bought trades only. These charts have their own cap (`NTFY_TRADE_CHARTS_PER_DAY` 60) under the same ntfy reserve, and `COIN_CHARTS=false` turns them off.
- Checked by drawing the chart with the same chart library QuickChart uses (Chart.js 2.9.4).
- Tests 151/151.
