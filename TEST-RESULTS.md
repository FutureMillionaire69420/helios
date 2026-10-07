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
