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

## v3.6: the thinking brain

- **Ranks Bronze → Grandmaster** replace Rookie → Master.
  - Each rank needs a minimum number of bought trades, proven skill and profit on a $1000 paper bankroll.
  - Skill means win rate, predictions that beat guessing, and profit factor.
  - Failing your rank for 10 bought trades in a row drops one rank.
- **Paper decisions.**
  - The brain tunes the entry-premium cap (5–25%), the stop-loss (10–30%) and the gain gate (10–30%).
  - It changes only on walk-forward evidence: chosen on older trades, proven on newer unseen ones.
  - It moves one step at a time and judges each change after 20 trades. It undoes a change that did worse, and remembers not to try it again.
  - It can skip a paper buy it clearly expects to lose, but only once its predictions beat guessing.
  - `BRAIN_AUTOTUNE=false` and `BRAIN_VETO=false` turn these off.
- **Live:** the brain only suggests changes ("Brain suggests" alert). It never changes a live setting.
- **Brain note** after every bought trade (ntfy, 🧠, capped at `NTFY_BRAIN_PER_DAY` 60). It shows:
  - the rank and what the next rank needs
  - the brain's thinking
  - the **$10 mirror**: $10 bought at your real entry and sold the moment Decu sold, next to Decu's perfect $10
  - the **delay cost**, the network fees, and FCAT / PCAT / stop-gate at $10
  - a chart
- **Memory** is kept in `brain-memory-<mode>.json` next to the study journal. It holds ranks, decisions, tuning history and the versions the bot ran on.
- **Optional daily GitHub backup** to a `brain-backup-<mode>` branch (never main), set with `GITHUB_BACKUP_TOKEN`. An empty disk is restored from it at start.
- **Dashboard:** rank, brain rules, $10 mirror totals and the latest decisions.

## v3.6.1

- Goal: $1000 profit (`BRAIN_GOAL_USD`). Every brain note shows the progress; alerts fire at 25/50/75/100%.
- Brain notes and the dashboard list the patterns the memory bank trusts.

## v3.7: the paper-test pack

All of these are replayed on the bot's own recorded trades, side by side with what it really does. None of them skips a paper trade. The brain sends "Brain suggests" only when a version chosen on older trades also wins on newer ones it never saw (50+ trades).

- **Buy the dip:** wait for the price to fall 5 / 10 / 15% below Decu's price, giving up after 30 or 60 s or at his sell. Compared with buying now; both sell when he sells.
  - The study keeps reading the price every 2 s until 60 s after his buy (`DIP_WINDOW_SEC`), at most 8 trades at once.
  - These readings are saved as a "tail" line in the journal and merged back into the trade at load.
- **Break-even stop:** once a trade is up +10% / +20%, the stop moves to break-even on your money. It is also in the advisor's exit comparison.
- **First buy only:** Decu's first buys of a coin vs his later buys.
- **Market cap ceiling:** skip above $10k / 20k / 30k / 50k / 100k. Uses Decu's market cap at his own buy, taken from his trade's curve numbers; older trades use the coin's market cap.
- **Quick-flip guard:** a side test only. After he sells within 10 s, it scores what pausing his buys would have done.
- **Crowd counter / speed test by on-chain order:**
  - Counts the trades by others that landed on the curve between Decu's buy and yours: your place in line. In live this is exact; in paper it's estimated from the landing block. It takes one `getSignaturesForAddress` call per study, 3 s later (`CROWD_COUNT=false` turns it off).
  - Paper also records how much SOL others put in.
  - "crowd before you" is a new pattern. The speed report shows what each trade ahead of you costs and what being 100 ms faster (e.g. LaserStream) is worth a month.
- **New patterns:** "crowd before you" and "Decu buy #" (first / later).
- **Obsidian-ready findings:**
  - `second-brain-<mode>/machine/findings.md` has front matter and a table per test.
  - It can be downloaded from the dashboard ("Download brain findings") and is served at `/api/brain/findings.md`.

## v3.7.1: price checks that failed after every buy

- **The problem:** right after almost every buy, the price requests failed for about 10 seconds. The bot then sold "blind" (no price) in paper, and the phone filled with "Price checks failing" and "Trade FAILED (sell)" alerts.
- **Price from the live websocket first:** the study and the price watch now take a held coin's price from the curve the websocket pushes, so most price checks need no data request.
- **Fallback:** a request that fails now uses a push from the last 5 s (`PUSH_FALLBACK_MS`) instead of counting as "no price". Paper sells use it too.
- **Shared reads:** reads of the same coin's curve at the same moment share one request.
- **Fewer alerts:**
  - "Price checks failing" comes at most once per coin every 5 minutes (`PRICE_FAIL_ALERT_EVERY_SEC`).
  - Paper sells retried for want of a price are logged, not pushed to the phone; the one "CAN'T SELL" alert covers them.
  - Live failures still alert every time.
- **RPC health:** every Helius call is counted. Any minute with refused (HTTP 429), timed-out or failed requests is logged as one line, with the busiest methods. It's also shown in `/api/status`.

## v3.7.2: the real cause of "no price" — coins on PumpSwap

- **Found on the chain:** the coins with failing price checks ($PRESIDENT, $DCY, $carti, $HOOT…) had already finished their bonding curve and moved to PumpSwap. Decu's buy of $PRESIDENT went through PumpSwap (`pAMMBay…`), not the curve.
  - A finished curve never changes, so it can't give a price, and the websocket has nothing to push for it.
  - Every price then came from Jupiter's free quote API, about 3 requests a second while studying and holding, and Jupiter kept refusing or coming back empty. Those failures weren't Helius calls, so the RPC health log stayed silent.
- **The fix: PumpSwap pools are read straight from the chain through Helius.**
  - The bot finds pump.fun's own pool for the coin (it only accepts the pool if it holds this coin and SOL), then reads both vault balances in one request, so both come from the same block.
  - A coin known to have graduated isn't read on its curve again: one request per price.
  - Tested on the live chain: $PRESIDENT, $DCY and $carti priced on every try in about 60 ms; before, they returned nothing.
- **Websocket prices for PumpSwap coins:** both pool vaults are watched. A price is pushed only when both balances come from the same block and nothing changed for 120 ms (`POOL_PUSH_SETTLE_MS`), so a half-updated pair can never fake a crash and trip the stop-loss.
- **Pool prices stay out of the curve sell builder.** PumpSwap sells still go through PumpPortal, as before.
- **Jupiter only as the last resort,** for coins outside pump.fun's pools. Its failures are now counted in the per-minute health line: "prices: curve N, PumpSwap N, Jupiter N (N failed)".
- **Crowd counter:** for a PumpSwap coin, it counts the trades in its pool.
- `PUMPSWAP_FEE_PCT` (default: the curve's 1.25%, on the cautious side) sets the fee used in paper PumpSwap prices.

## v3.8: the second brain in Obsidian

- **Notes:** the bot writes its thinking as an Obsidian vault (plain markdown with front matter and [[links]]) on the Render disk, in `second-brain-<mode>/`:
  - `Home.md`: rank, goal, rules, days and the patterns it trusts.
  - One note per bought trade, `machine/trades/`: what it predicted and why, what happened, the $10 mirror, place in line and the patterns it matched (linked).
  - One note per day, `machine/daily/`: its numbers as front matter, so Obsidian can sort and query them, plus its trades and decisions.
  - One note per trusted pattern, `machine/patterns/`, with the trades that matched it.
  - `machine/decisions.md` (every decision) and `machine/findings.md` (the paper tests).
  - `human/` is yours: the bot never writes there, except its README the first time.
- **Rebuilt from the bot's own records:** at start, the newest 300 bought trades (`VAULT_BACKFILL`). Only notes whose content changed are written.
- **Download:** the dashboard has a "Download whole brain (Obsidian vault)" button (`/api/brain/vault.zip`).
- **GitHub sync (optional):** set `GITHUB_VAULT_TOKEN` and `GITHUB_VAULT_REPO` (owner/name of a PRIVATE repository just for the brain).
  - The changed notes go up as one commit every `VAULT_SYNC_MIN` (5) minutes; an empty repository is started automatically.
  - Obsidian's Git plugin pulls them.
  - The token is never logged, and `POST /api/brain/vault/sync` pushes now.

## v3.9: charts and a full analysis in every trade's brain note, and the profit missed on the delays

- **Every new bought trade's Obsidian note** gets five charts, saved as pictures in the vault (`machine/charts/`, so they show offline, in the zip and through the GitHub sync):
  1. The price path, every second, with 3/5/10CAT, the best second, the exit, Decu's sell, the stop and the gate.
  2. What the delay cost: $10 bought at Decu's price vs at your entry vs at every later second, all with the same exit.
  3. The $10 mirror: Decu's perfect $10 → the delay → yours → fees → result.
  4. Every exit strategy on this trade, best to worst, next to Decu's own price and the best second.
  5. This trade vs your last 30 trades and the winners among them.
- **The write-up in each note:**
  - Verdict, with its rank among all trades and the profit missed on the delay.
  - The delay step by step: detection, bot timing, place in line, premium, what each later second would have made, fees.
  - A table of every exit, the comparison with your history, and setups like this one (same premium band, market cap and Decu size).
  - Risk while held, and a table of every second.
- **Each day's note:** you vs Decu's price per trade (and what the delay took), plus the running total at $10 (Decu's price, you before fees, you after fees).
- **New note "Delays and missed profit"** (`machine/analysis/`), linked from Home:
  - The total profit the delays cost (SOL and $), and a running total with vs without the delay.
  - Missed per day, and averages by blocks after Decu, execution latency, place in line and entry premium.
  - Entry premium vs result for every trade.
  - Its charts redraw at most every `ANALYSIS_CHARTS_EVERY_MIN` (15) minutes.
- Charts are drawn by QuickChart (POST, only % / SOL / $ numbers are sent). A chart that can't be drawn keeps its last picture or links online. `NOTE_CHARTS=false` turns charts off.
- Older trades get the written analysis without charts.
- "Missed on the delay" = Decu's entry price result − yours with the same exit (the $10 mirror on newer trades, PCAT − FCAT on older ones; values beyond ±1000% are data errors and left out).

## v4.0: the new dashboard, the road to the Rolex

- **New look:** black, two-tone steel and gold, white highlights (GMT-Master "Zombie" colours).
  - On a phone the tabs sit at the bottom; on a computer they are a sidebar.
  - Three finishes in Bot → This device: Two-tone, Steel, Gold.
  - Gains are blue and losses red (checked for colour blindness); every chart has a tooltip and a "Numbers" table.
- **Home: the Rolex meter.** An original drawing of a GMT-style watch (no logo or brand name on it):
  - The gold ring inside the bezel fills with **live** profit toward `ROLEX_GOAL_USD` ($20,000). The silver ring is paper practice and never counts.
  - The GMT hand points at your progress and the date window shows the percent. The other hands keep the real time.
  - Next to it: live profit, milestones ($1K, $5K, $10K, $15K, $20K), still to go, pace a day (last 7 days), arrival date, and the practice meter.
- **Home: open coins.** Each held coin shows:
  - its live result and a gauge from the stop-loss to the gain gate;
  - cost, value now and best result, with pump.fun and Solscan links;
  - a **Sell now** button that sells all of that coin through the normal exit path, sell retries included. Live asks twice.
- **Home: the rest.** The trading style switch, the emergency stop, Decu's latest buys and the latest activity.
- **Trades:** every studied Decu buy, bought or skipped.
  - Filters: date (today, 7 days, 30 days, all, or a day picked in the calendar), won/lost, bought/skipped, a coin search, market cap, entry premium, delay, Decu's buy size, buyers ahead, the holder rule, his first buy only, and how it sold.
  - Totals, the running profit, a CSV of the rows in view, and each trade in full (per-second chart, notes and what the brain thought).
- **What-if tester:** what rules would have made on every studied buy, next to what the bot did. Nothing here changes how the bot trades.
  - Buy rules: premium cap, market cap min and max, Decu's buy size, delay, buyers ahead, Decu's recent activity, holder SAFE, first buy only, hours of the day.
  - Exit rules: take profit, stop loss, sell after N seconds.
  - The verdict compares the older 70% of trades with the newer 30%, and a table shows what each rule takes out.
  - "Find the best value" picks a value on the older trades and shows how it did on the newer ones.
- **Calendar:** profit per day for live (real) or paper (practice).
  - Blue days made money and red days lost; tap a day to see its trades.
  - Streaks, best and worst day, the running profit, and profit by weekday and by hour.
  - **What it takes to reach the Rolex:** time to the goal at each trade size, and the size needed for 3, 6 or 12 months.
- **Brain and Bot tabs:** the same information as before, as cards.
  - Brain: rank, rules, $10 mirror, tests, patterns, decisions, market caps, place in line, Obsidian downloads.
  - Bot: controls, wallets, settings, speed and fees, connections, pending trades, activity, downloads, analytics.
- **Wallets:** Solflare, Phantom, Backpack and any wallet that follows the Wallet Standard.
  - On a phone, "Open in Solflare" or "Open in Phantom" opens the dashboard inside the wallet app.
  - Connecting only reads the wallet's public address, to show it, check it against the bot's wallet and read its balance. The dashboard never asks a wallet to sign.
- **Sign in:** "Remember on this device".
- **Server:**
  - **Rolex ledger:** `rolex-goal.json` next to the engine state (Render: `/var/data/rolex-goal.json`). Paper and live share it, and it is filled at start from the closed-trade record. Settings: `ROLEX_GOAL_USD` (20000), `ROLEX_GOAL_NAME`, `GOAL_FILE`.
  - **New endpoints:**
    - `GET /api/trades`: compact rows, gzip, `?after=ms` for the newest only.
    - `GET /api/trade?mint=&time=`: one trade in full.
    - `GET /api/goal`: add `?entries=1` for the calendar.
    - `POST /api/sell/<mint>`: sell one coin.
    - `GET /api/wallet/balance?address=`: one read, cached 30 s.
  - `/api/status` adds the held coins with their live value, the settings, the leader, the SOL price, the timezone and the signer's public address.
  - The security policy now allows `data:` images (wallet icons); scripts stay same-origin only.
  - A missing page file now answers 404 instead of leaving the request open.
- **Tests:** `dashcalc.test.mjs`, `goal.test.mjs` and `dashboard.test.mjs` (199 tests in all).

## v4.1: ready to trade?, Decu's arbitrage bursts, clean tests

No trade setting changed.

- **Readiness (`/ready`), separate from `/health`.**
  - `/ready` answers 200 when the bot can trade safely and 503 when it can't, with only the names of the failing checks. It needs no token, so an outside uptime monitor can watch it.
  - Blocking checks: bot power, Decu's trades feed, every open coin priced within 30 s (`READY_PRICE_STALE_SEC`), new buys allowed (circuit breakers, stale data), disk writable, and the wallet balance (live).
  - Warnings only: Helius refusals or timeouts in the last minute, phone alerts failing, buying paused.
  - `/api/ready` (token) gives every check with its detail; `/api/status` carries it too.
  - Dashboard: "Not ready to trade" on Home, and the full checklist under Bot → Connections.
  - Phone: "Bot NOT READY to trade" after 2 minutes (`READY_ALERT_SEC`), then "Bot ready to trade again" when it recovers.
  - `/health` is unchanged and stays Render's health check: a restart can't fix stale data, and it can interrupt a sell.
- **Decu's arbitrage bursts no longer flood Helius.**
  - His wallet also runs arbitrage through his router: one transaction swapping across PumpSwap, Raydium CLMM and USDC, ending where it started.
  - On 2026-10-28 02:53 UTC about 100 came in 43 s. Downloading them all at once drew 243 Helius calls in a minute; 60 were refused, the bot's own fee checks among them.
  - A transaction that swaps on two or more venues is now downloaded 2 at a time (`ARB_DOWNLOADS`). None is skipped, and his one-venue trades never wait behind them.
  - Replaying that burst against a limit of 10 calls a second:
    - before: 424 calls, 101 refused;
    - now: 285 calls, 0 refused, and the queue still clears in 44 s.
  - Bot → Connections counts them.
- **Prices right after a coin graduates.**
  - A "no pool yet" answer for a coin's new PumpSwap pool used to be kept for 60 s. A coin that had just left its bonding curve could go unpriced for a minute, which caused the blind no-price sell of $Robotaxi.
  - Now the pool is looked up again after 1 s, then 2, 4… up to 60 s.
- **Jupiter price failures say why.** The rpc health line names the reason (rate limit, timeout, no route) and up to 3 of the coins.
- **Phone alert delivery is tracked** (last delivered, failures in a row) and shown in readiness.
- **Tests.**
  - `npm test` runs every test file in its own empty temporary folder (`test-guard.mjs`), deleted afterwards. Nothing is written into the project folder any more, and a `.env` there can't change what the tests see.
  - A test file that finishes but keeps running fails after 5 s, naming what is still open, instead of hanging the run. Each test also has a 2-minute limit (`--test-timeout`).
  - The guard found one leak: the bot's `stop()` left the 15 s studies, their price follow-ups and the notes writer running.
    - All three now stop with the bot.
    - `engine.test.mjs` finishes in about 1 s instead of 18 s, and the whole suite in about 14 s.
  - 203 tests, including one of Decu's real arbitrage transactions as a fixture (`fixtures/leader-arb-logs.json`).
- **`package-lock.json`** (no dependencies): a reproducible install.
- **Docs.**
  - `GO-LIVE.md` is rewritten for v4. It covers:
    - the real defaults: a $600 daily cap, the loss limit off, automatic exits;
    - the gates, and fees by trade size;
    - how to read paper results;
    - the canary and restart tests;
    - emergencies, recovery and monitoring;
    - a dated sign-off table.
  - `setup --live` and `START-HERE.md` no longer say "no daily spending cap": `DAILY_CAP_USD` (600) has applied all along.

## v4.1.1

- **No "NOT READY" page while the bot is OFF on purpose.**
  - Turned OFF with no coin held, the bot already sends "Bot OFF" at every start, so the readiness alert no longer pages for it. `/ready` still answers 503.
  - OFF with a coin held is still paged: that coin's stop-loss is blind.
- `READY_CHECK_MS` (15000): how often readiness is checked.

## v4.1.2

- **v4.1.1 still paged** once the bot had been OFF for 30 s.
  - The stopped feed also tripped the stale-data rule, so "New buys allowed" counted as a second problem.
  - Now, while OFF, only "Bot power" counts. The test runs with the stale-data rule on, as on the server.
