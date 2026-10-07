# Decu copybot v2 — start here

This version has durable recovery, a mobile dashboard, phone alerts and a strict safety check on every real trade. It defaults to PAPER mode (no wallet secret needed).

**Defaults now follow your rules:** fixed 0.1 SOL per copy (`SIZING_MODE=fixed`), 1 SOL per day, pump.fun only, his buys of $50+, first buy per coin, and **AUTO_SELL=false**: the bot never sells; you get a priority "Decu SOLD a coin you hold" alert and sell by hand. Proportional sizing and mirrored auto-sells are still available but not recommended (see GO-LIVE.md for why).

## What runs where

Node.js 22+ runs the bot on a computer or server. Your iPhone opens its dashboard in Safari. Closing Safari does not stop a server-hosted bot. This ZIP is not a native iOS app; opening it in Files does not run Node.js. This development workspace is not permanent hosting.

## Try the synthetic demonstration

Install Node.js 22+, extract this ZIP, and open a terminal in the computer folder.

```
npm test
npm run smoke
npm run demo
```

Open http://localhost:3000 on that computer. DEMO generates a buy, a 25% sell, and a full remaining exit. It never connects to a blockchain or wallet. Stop with Ctrl+C. The smoke command performs two process runs and verifies persisted state, API authentication, and controls.

## Watch Decu using pretend trades

1. Copy .env.example to .env.
2. Enter your HELIUS_API_KEY. Leave PRIVATE_KEY empty and DRY_RUN=true.
3. Generate a dashboard token:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

4. Set DASHBOARD_TOKEN to the result. It is a password, separate from your wallet key.
5. Run npm run check, then npm start. Check exits nonzero if a connection check fails.
6. Open http://localhost:3000 and enter your dashboard token. It is kept only in page memory; re-enter it after reopening.

The dashboard refreshes every two seconds. It shows signals, skips, positions, pending/unresolved transactions, and errors. Pause buys leaves exits enabled. State is engine-paper.json; the journal is trades.log.

The new paper engine starts with PAPER_BALANCE_SOL, uses live quotes to estimate fills and fees, and checks buy slippage. It does not guarantee real fills or model every fee/rent/failure. Legacy report/backtest/export commands still handle v1 files; the dashboard is the source for v2 results. v1 ntfy notifications and its multiple delayed paper-exit scenarios are not part of the new engine.

## Open it on your iPhone over home Wi-Fi

1. Stop the bot; set DASHBOARD_HOST=0.0.0.0; restart.
2. Find the computer's local IPv4 address in network settings.
3. Connect the iPhone to the same private Wi-Fi.
4. Open http://COMPUTER-IP:3000 in Safari, replacing COMPUTER-IP. Localhost on the iPhone means the iPhone itself.
5. Enter the dashboard token. If blocked, allow Node.js through the computer firewall on the private network.
6. Safari → Share → Add to Home Screen (menu placement varies by iOS).

Keep the computer awake. Private-network HTTP is for paper/demo use; use HTTPS or a private VPN before remote/live use. Do not forward this port publicly.

## Run when your computer and iPhone are off

Use a continuously running server with persistent storage. See HOSTING-IPHONE.md and render.yaml. No server has been deployed for you. The blueprint creates a paid service if you deploy it; review costs first.

## Real trades: after paper and route checks

Run only one bot instance. Stop the previous local/Render bot. Verify LEADER_WALLET yourself; its address was inherited from your upload, not independently authenticated as Decu's identity.

Use a separate funded trading wallet. Put PRIVATE_KEY only in local/server secrets, never in the dashboard/chat/repository. Set DRY_RUN=false. A dashboard token at least 24 characters long is required. Production must use HTTPS.

The live adapter builds with PumpPortal, validates instructions and simulated balances, signs locally, and submits through Helius Sender/configured RPCs. Actual buy/sell routes must be checked against current on-chain behavior using your own small amounts. No funded on-chain trade was executed during this repair.

Unsupported programs/instructions are refused rather than blindly signed. A migrated coin on an unsupported venue can require a manual exit. EXECUTOR=pumpportal is required in v2; Jupiter remains a quote/backtest source. Never bypass the guard to force a failing route.

State is separate by mode. Preserve engine-live.json through redeploys. Corrupt state and another wallet's state cause refusal. An old state.json containing live copied coins causes refusal of blind migration; reconcile old holdings and pending signatures before adopting v2. Do not delete state to clear errors.

## Rules and limits

(Only with SIZING_MODE=proportional, not the default.) Buy = your spendable SOL × leader trade SOL / leader native SOL before the trade × COPY_MULTIPLIER. MAX_BUY_SOL and the remaining daily principal allowance cap it. Spendable SOL excludes MIN_SOL_RESERVE, pending reservations, and a fee/rent buffer. SIZING_MODE=fixed uses BUY_SOL instead. Missing pre-balance, unsupported multi-mint buys, or stable-funded buys are skipped. This mirrors native SOL allocation, not his entire portfolio.

(Only with AUTO_SELL=true, not the default.) Sells mirror the leader's percentage sold using integer token arithmetic, capped by your filled tracked position and actual available balance. If you manually move bot tokens or trade the same mint from this wallet, reconcile state first.

Detection uses confirmed transactions, adding delay. The v1 processed-log fast path and speculative prebuild do not drive v2 trades. Polling replays bounded recent history including recent exits after restart. Buys older than MAX_SIGNAL_AGE_SEC and sells older than MAX_SELL_SIGNAL_AGE_SEC are skipped. Longer downtime requires manual position review.

A confirmation timeout stays UNRESOLVED. Recovery checks signature/blockhash and can resend identical bytes. Never send a new replacement just because confirmation timed out. Known failures release principal reservations; fees already spent remain costs. Sales do not replenish the daily buy allowance.

Default tip 0.001 SOL plus priority fee 0.0005 SOL per transaction can make very small copies expensive. Paper gains do not establish profitability.

## Troubleshooting

Read the exact skip/error reason in Activity. Connection shows last successful poll. For subscription/RPC failures, check Helius key, rate limits, and network. For unresolved transactions, inspect the signature link and wait for recovery. Unsupported instructions/simulation failures require adapter review, not disabled validation. Stop all trading by terminating the process/service; Pause buys stops only new buys, while pending sends may already be submitted.

References:
https://pumpportal.fun/local-trading-api/trading-api/
https://www.helius.dev/docs/sending-transactions/sender
https://render.com/docs/disks
https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios
