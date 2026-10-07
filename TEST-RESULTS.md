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
