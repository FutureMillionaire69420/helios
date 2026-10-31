# Verification

## Original (Oct 7, 15:35)
22 automated tests and 2 demo runs passed (see git history of this file in the source zip).

## Review and upgrade (Oct 7, 16:50, Claude)
Read every file line by line. Network destinations are only Helius, PumpPortal, Jupiter, DexScreener,
ntfy and Solscan links; secrets are redacted from logs and the dashboard.

Fixed / changed:
1. Defaults now match the user's rules: fixed 0.1 SOL (proportional sizing gave 0.005–0.008 SOL buys,
   or skipped every buy with a 0.5 SOL paper wallet; fees were 25–40% of such trades), 1 SOL/day,
   AUTO_SELL=false, slippage 20%, paper wallet 1.65 SOL (~$200).
2. Manual-sell mode restored: with AUTO_SELL=false, his sell of a coin the bot holds raises a
   priority "Decu SOLD a coin you hold" phone alert (it was silently skipped).
3. Phone alerts (ntfy) restored for buys, sells, failures, unknown outcomes, pause/resume; paper/demo labelled.
4. Paper mode now measures profit: each paper position is valued 4 s and 5 s after the buy and
   0 s and 10 s after his sell (it previously never closed with AUTO_SELL=false).
5. `check` crashed (infinite recursion) when the websocket failed; fixed. It reported a fallback
   SOL price as "OK"; now requires a live price. A 403 from Helius Sender counted as OK; fixed.
6. `check` is now a go-live preflight (see GO-LIVE.md), including building + simulating a real buy without sending.

Result: 26/26 tests pass (4 new), both demo runs pass, preflight run offline catches all 11 deliberate
misconfigurations and sends nothing.

Still unverified here (this workspace can't reach Solana): live RPC, real PumpPortal builds, landing,
iPhone rendering. `node copybot.mjs check` on the real server is the first live verification.

## Helius + Solscan upgrade (Oct 7, 23:40, Claude)
Data source for every finding below: Decu's last 100 swaps from Solscan, checked transaction by
transaction against Helius.

Bugs found in live data and fixed:
1. **The bot could not see any of his trades.** All of his transactions are version 1, and the
   bot asked Helius for version 0, so every `getTransaction` failed. Now asks for version 1
   (`MAX_TX_VERSION`). The local signer refuses builder transactions newer than v0 instead of misreading them.
2. **Multi-hop buys were skipped.** A route leaves 1 raw unit of the intermediate coin in his wallet;
   the parser called that a two-coin trade and dropped a real 0.25 SOL buy. Dust is ignored now.
3. **The backup poller couldn't recover anything.** His address gets ~1000 transactions per 4 s
   (85% failed, sent by others). 20 pages of 100 covered ~8 s of a 300 s window and used up the
   rate limit. Helius poll now 1–3 pages of 1000; Solscan, which lists only his own swaps, covers the window.

Added:
- `solscan.mjs`: Solscan Pro v2 client, second watcher, multi-leg netting, leader profile, parser cross-check.
- Runtime: records which provider saw each trade first; alerts when Solscan catches one Helius missed;
  reports buys paid with PUMP tokens instead of dropping them silently; coin names in alerts.
- SOL price order: Solscan, Helius (DAS), Jupiter, DexScreener.
- `node copybot.mjs diagnose` (see GO-LIVE.md 3b). Dashboard shows provider status.

What the data shows about him (89 trades after netting route legs, 1.4 h, 11 coins; 2 not scored
because they started before the window): 6 of 9 in profit, +6.9 SOL. He opens with one large buy
(≈2 SOL, about $230–345) and adds smaller buys after it; there were no small test buys first. Median 104 s from that buy
to his first sell; 1 of 10 under 30 s, none under 10 s, so a copy landing 1–2 s after him is in time.
3 of 11 coins were PUMP-paired (he still pays SOL; whether PumpPortal can build those routes is unverified).
Before netting, Solscan's per-leg rows counted an intermediate coin as a trade and overstated his profit as +12.2 SOL.

Result: 39/39 tests (13 new, from real Solscan rows), both demo runs pass. Live against Helius:
parser matches Solscan on 89/89 swaps (30/91 before the fixes), websocket subscription acknowledged,
`check` and `diagnose` run. Not verified here: the Solscan API with a key (verified through the
Solscan connector instead), live sends, PumpPortal builds for PUMP-paired coins.

## Stability and setup (Oct 8, Claude)
Live 45-second paper run on the free Helius key, before and after:
- Before: 1,508 transactions mentioning his address in 45 s, each downloaded in full: **1,440 rate-limit
  errors**, every Helius call failing. Measured cause: ~26 successful transactions a second from one
  unrelated program (`Dhpy…`), none touching pump.fun, plus ~86 failed ones a second.
- After: websocket messages that never touch pump.fun or PumpSwap are skipped without a download
  (815 in 45 s); the Helius backup poll stands by while the websocket is healthy. **0 errors.**

Also:
- `node copybot.mjs start` supervises the bot: restarts after a crash (phone alert), stops after 5
  failures within a minute of starting, keeps a Mac awake. Crashes are logged to trades.log.
- RPC reads retry HTTP 429/5xx with backoff. Strangers' transactions are counted, not journaled;
  repeated errors write one event per 30 s. Duplicate keys older than 2 days are pruned from state;
  trades.log over 50 MB rotates at startup.
- `node copybot.mjs setup` (keys, dashboard password, ntfy topic, then check), `setup --live`
  (hidden key entry, address confirmation, no daily spending cap), `setup --paper`.
- Double-click files for Mac and Windows: setup, start, check, status, go-live, back-to-paper.
- `status` prints paper results per sell timing.

Result: 47/47 tests (8 new: supervisor crash-restart and give-up, setup wizard, RPC retry, pruning,
spam filtering, error throttling), both demo runs pass, live paper run clean.
Not tested here: the double-click files on real macOS/Windows (Linux sandbox), Windows sleep settings.


## Phantom/autonomous execution upgrade (Oct 8, Claude)

Added: explicit `PHANTOM_PRIVATE_KEY` alias for an unattended burner signer, optional `PHANTOM_WALLET_ADDRESS` safety check, a read-only `node copybot.mjs wallet` diagnostic, authenticated `/api/wallet`, and a dashboard **Connect Phantom** button that verifies the browser wallet address without receiving or displaying secrets. The existing live executor already builds, locally signs, simulates, broadcasts and confirms PumpPortal transactions; this upgrade makes the Phantom/burner setup explicit without attempting to bypass Phantom's user approval model.

Result: **49/49 tests pass** and both smoke runs pass. Live chain execution was intentionally not triggered during verification.

## Merge of the Phantom/auto-copy upload (Oct 9, Claude)
Merged the uploaded auto-copy switch and Phantom wallet checks onto the current code, keeping the
fix for the check after setup. Two fixes to the upload: auto copy defaulted to OFF, which skipped
every buy (paper mode recorded nothing); and state files saved before the switch existed also read
as OFF. `AUTO_COPY` now defaults to true; old state takes the configured value.
Wallet 3mFW…TX1P is a valid address with 0 SOL (Helius, Oct 9). Result: 51/51 tests.

## Two trading toggles (Oct 9, Claude)
Auto copy OFF used to stop buying entirely. Now the dashboard has two exclusive toggles:
"Auto buy + auto sell" and "Auto buy + manual sell" (SOLD alert, sell in Phantom); both OFF = no new
buys, held coins keep their selling style. CLI: `style auto|manual|off`. 52/52 tests; checked live on a demo bot.

## Trade study (Oct 9, Claude)
Each bot buy (paper or live) is re-priced every second for exactly 15 s (Helius bonding-curve read,
Jupiter after graduation), then never again. Saved to study-<mode>.jsonl; one alert per coin with
3CAT/5CAT/10CAT, BTSAB, PCAT, entry gap vs Decu, every-second curve, coin holders/mcap/age (Solscan),
and the best fixed-second, take-profit and TP+stop rules over all studied trades.
`node copybot.mjs study` reads the journal offline. Solscan watcher polls every 5 s.
Safety: price calls time out at 2.5 s, max 5 coins studied at once, read-only.
Verified live: 16 Helius price reads in 15.1 s on a real pump.fun coin, then stopped. 58/58 tests.

## BAND (Oct 9, Claude)
Study alerts and totals add BAND: each trade sized at BAND_PCT (10%) of Decu's SOL spend, using the
same % curve (bigger buys move the price more, so real results would be somewhat worse). 58/58 tests.

## Fastest buy, FCAT exit rule, watchdog (Oct 11, Claude)
- Fast path: the websocket subscribes at "processed" and the bot buys straight from Decu's pump.fun
  trade event in the logs, without waiting for confirmation or downloading the transaction
  (~0.5-1.5 s sooner). Decoder verified on his real trades of 2026-10-11 (token amounts match Solscan).
  The full path still runs and is deduplicated.
- Auto-sell style: sell 100% at his first sell (also from the fast path); if he hasn't sold 15 s after
  the bot's buy, sell anyway (MAX_HOLD_SEC). Resumes after restart. Manual-sell style unchanged.
- FCAT = that rule, measured on the bot's real entry; now the headline of every study alert and summary.
- Watchdog: phone alert if the Helius websocket is down 2+ min or Solscan 5+ min, and when they recover;
  "bot healthy" check-in every 12 h.
- Render check (Oct 11): Solscan backup polled ~3,000 times in 4.5 h with 3 transient 504s; Decu made no
  trades after the deploy (his last was 07:19 UTC), so no live copy yet.
Result: 64/64 tests (6 new, from his real logs), both demo runs pass.

## Local fast-buy builder (Oct 11, Claude)
- Live buys are built inside the bot (pumpbuild.mjs) from Decu's own trade event: no PumpPortal round
  trip, blockhash and wallet balance kept fresh in the background, so the buy waits only for the safety
  simulation. Falls back to PumpPortal automatically (graduated coins, missing data, any error).
- Instruction: pump.fun `buy_exact_sol_in` from pump.fun's on-chain IDL, plus two newer accounts the IDL
  lacks (bonding-curve-v2 PDA, buyback fee recipient), matched against real successful transactions.
  Simulated against live coins: accounts, token-account creation and the buy instruction all accepted up
  to the buyback requirement, which is now included; the final simulation is the `check` step below.
- Bug fixed in the original code: the associated-token program address had a one-character typo
  (…qW4x… instead of …qW5x…). Every live buy's safety check derived the wrong token account and
  would have refused the trade.
- Price math predicts his real fill to 0.000001%. Full safety check + simulation still run on every buy.
- `node copybot.mjs check` (with PRIVATE_KEY) now builds a local buy with your wallet and fully
  simulates it on-chain without sending: it must say OK before going live.
Result: 69/69 tests (5 new), both demo runs pass. Local building only runs in LIVE mode.

## Exit rules: stop-loss and +15% gate (Oct 11, Claude)
Every held coin is priced once a second. Down 15% at any moment -> sell everything (both styles).
Auto-sell style at 15 s: reached +15% by then -> sell; never reached it -> hold until Decu sells,
with a 10-minute limit. His sell always exits at once. Coins still held after a restart are watched
again. Phone alert for each rule. 72/72 tests (exit rules tested on his real logs), demo runs pass.

## Gap alerts, organic stop, max-pay guard, memory bank (Oct 12, Claude)
- Bug found from the live gap alerts: Decu also trades Raydium LaunchLab (bonk.fun) coins through his
  FLASHX router; those logs have no pump.fun program, so the websocket filter dropped them and only the
  Solscan backup saw them. The filter now passes every venue/router he uses; the spam still does not.
- Gap alerts now say what the trade was (side, coin, SOL, venue, how late, what the bot did), are
  grouped into one phone message per 20 s, and are not raised in the first 90 s after a restart.
- Stop-loss -20% measured from the bot's entry price (fees ignored).
- MAX_PAY_ABOVE_DECU_PCT guard (off by default): paper refuses, live local builds enforce on-chain.
- Every study alert carries the bot's notes on the trade and a memory bank (FCAT by Decu buy size,
  lateness, price paid above Decu, coin age, hour); `study` prints the whole bank.
- Safety check: its two network reads run in parallel (one round trip less, same checks).
- His reference buy is now the first one big enough to copy (fixes "Decu bought 0.000 SOL").
Result: 77/77 tests, both demo runs pass.
