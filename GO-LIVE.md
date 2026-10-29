# Going live with real money (v4.2)

**This guide changes nothing.** The bot keeps trading exactly as it is set until you change a setting yourself.

A "READY FOR LIVE" line, a green readiness check, or a finished checklist is not permission to spend money. Going live is your decision, written in the sign-off table at the end.

## Where things stand: NO-GO (checked 2026-10-28)

- **Paper results.** 46 closed trades.
  - Net **−0.017 SOL** after fees.
  - Before fees: +0.306 SOL. Fees: 0.323 SOL.
  - Win rate 46%. Worst drop from a high point: −0.28 SOL.
- **Paper isn't testing the live rules.** Paper was using the brain's tuned rules (25% premium limit, −25% stop). Live would use your settings (15% and −20%).
- **Untested live.** No live buy or sell has ever run.
- **2026-10-29: paper now matches live** (see "Reading paper results"). Count paper trades only from then.
- **The bot is OFF** (since 2026-10-28 06:43 UTC, from the dashboard). No paper trades are made until you turn it on: Bot → Controls → Power ON.

Update this section at every review, with the date.

## The gates

All must pass, in this order.

1. **Tests.**
   - `npm test` passes and exits on its own: 206 tests, about 15 s.
   - It leaves no files in the project folder.
   - `npm run smoke` passes.
2. **Data providers.**
   - On the server, `node copybot.mjs diagnose` shows no WARN lines.
   - Dashboard → Bot → Connections shows Helius with 0 refused calls.
   - `/ready` answers 200 for a whole day (see Monitoring).
3. **Profit evidence.**
   - At least **100 closed paper trades over at least 3 separate days**.
   - Positive **after fees**.
   - Judged at the rules live will use (see "Reading paper results").
4. **Preflight.** `node copybot.mjs check` prints `READY FOR LIVE` with the live settings in place. It builds and simulates a real buy but does not send it.
5. **Canary.**
   - First, the landing-speed test: real landing times, no coins, fees only (see "The landing-speed test").
   - Then one smallest-size live trade, bought and sold, checked on Solscan.
   - Then the restart test (see "The canary").
6. **Operations.** Rehearse these once:
   - Emergency stop.
   - Sell one coin.
   - Sell all.
   - A phone alert arriving.
   - A restart with a coin held.
7. **Sign-off.**
   - Independent review (Victor).
   - Your written approval, dated.

## The money: fees by trade size

Every trade pays on the buy **and** on the sell, whatever its size:

- **Network fees.** With `FEE_MODE=max`, each side pays a priority fee and a tip, each capped.
  - Priority fee: Helius's "VeryHigh" estimate.
  - Tip: Jito's top-1% landed tip, so the trade lands fast.
  - The code's default caps are 0.001 + 0.002 SOL per side.
  - **Your Render service sets higher caps:** `PRIORITY_FEE_MAX_SOL` 0.003 + `TIP_MAX_SOL` 0.01. One side can cost up to **0.013 SOL**, so up to 0.026 SOL per round trip.
  - On paper the average was about **0.0035 SOL per side**, 0.007 per round trip.
- **pump.fun's trading fee.** About 1.25% per side (2.5% per round trip), taken inside the price.
- **Slippage and delay.** The price moves while your copy lands. On 2026-10-28 the median buy landed 26% above Decu's price.

Costs below assume SOL at $100. They come before slippage.

| Trade size | About | Network fees, typical (0.007 SOL) | Network fees, worst case at your caps (0.026 SOL) | Typical, with pump.fun's 2.5% |
|---|---|---|---|---|
| 0.01 SOL | $1 | 70% | 260% | ~72% |
| 0.05 SOL | $5 | 14% | 52% | ~16.5% |
| **0.1 SOL** (`BUY_SOL` now) | $10 | 7% | 26% | ~9.5% |
| 0.25 SOL | $25 | 2.8% | 10% | ~5.3% |
| 0.5 SOL | $50 | 1.4% | 5.2% | ~3.9% |
| 1 SOL | $100 | 0.7% | 2.6% | ~3.2% |

A trade must gain more than this just to break even. At 0.1 SOL, paper's price moves earned about +6.6% per trade and fees took about 7%.

**Trades of $1 can't work.**

## Reading paper results

**Since 2026-10-29, paper is set to match live** (Render → Environment). Live settings are unchanged.

| Setting | Paper now | Before | Why |
|---|---|---|---|
| `BRAIN_AUTOTUNE` | `false` | on | paper uses your rules (15% premium cap, −20% stop, +15% gate), as live does |
| `BRAIN_VETO` | `false` | on | the brain no longer skips paper buys; live never does |
| `PAPER_UNLIMITED` | `false` | `true` | no money, no buy, as in a real wallet |
| `PAPER_BALANCE_SOL` | `3` (about $300) | — | the money you plan to put in the live wallet: applied once when it changes, then paper trades move it |
| `PAPER_LAND_MS` | `1000` | 500 | each paper trade fills at the real market price 1.0 s after the bot acts |

Count only paper trades from that day. Older ones used the brain's rules (25% premium cap, −25% stop); dashboard → **What-if** can replay those at your rules.

**What paper measures on real data:**
- The bot sees Decu's trade in the same block.
- Its own work takes about 1 ms on the fast path, and about 0.6 s when it has to download the transaction.
- Prices, fees, the slippage limit and the entry-premium filter are applied as live would apply them.

**What paper still can't copy:**
- **The real landing time.** Paper assumes 1.0 s. Measure it with the landing-speed test below and set `PAPER_LAND_MS` to the median it reports.
- **Failed trades.** A real buy can fail: the price moved past the slippage limit, or it never landed. A failed one still pays its priority fee; paper skips those buys at no cost.
- **PumpPortal's 0.5% fee.** For coins the bot can't build itself (PumpSwap coins), live uses PumpPortal's builder, which takes 0.5%. Paper doesn't charge it.

**What a live wallet needs.** For each open coin:
- `BUY_SOL` × (1 + `SLIPPAGE_PCT`/100)
- plus fees, about 0.007 SOL (up to 0.026 at your caps)
- plus token-account rent, about 0.002 SOL (returned when the coin is fully sold)

Keep `MIN_SOL_RESERVE` (0.02 SOL) on top. At 0.1 SOL and 2 open coins, that is about **0.28 SOL**.

The Rolex meter counts **live** profit only. Paper is the practice meter.

## The landing-speed test

How long a real transaction from your bot takes to land, measured with real transactions but no coins.

In Render → your service → **Shell**:

```
node copybot.mjs landtest              # shows the cost, sends nothing
node copybot.mjs landtest --yes        # sends 10
node copybot.mjs landtest --count 5 --yes
```

- **What it sends.** Each transaction does nothing except pay the priority fee and tip a buy would pay right now, sent through Helius Sender like a buy. No coin is bought or sold.
  - The bot refuses to sign anything with any other account in it.
- **What it reports.** For each one: how many blocks after sending it landed, and how many milliseconds until it was seen and confirmed. Then the median and the worst, against paper's `PAPER_LAND_MS`.
- **What it costs.** It spends **real SOL** from the wallet in `PHANTOM_PRIVATE_KEY`, even while the bot is in paper mode.
  - Each one costs a buy's fee and tip: about 0.0035 SOL typical, at most 0.013 at your caps.
  - 10 cost about 0.035 SOL, at most 0.13.
  - It shows the cost first and refuses if the wallet can't cover the maximum.
- **When to run it.** At a busy time (when Decu trades), on a few different days. Then set `PAPER_LAND_MS` to the median "seen after", rounded up to the next 100 ms.

## Settings and their defaults

The service uses what Render → Environment says. A value set there overrides the default below.

`render.yaml` holds only the blueprint's starting values.

| Setting | Default | What it does |
|---|---|---|
| `DRY_RUN` | `true` | `false` = real trades |
| `BUY_SOL` (`SIZING_MODE=fixed`) | 0.1 | SOL per copy |
| `MAX_OPEN_POSITIONS` | 2 | coins held at once |
| `DAILY_CAP_USD` | **600** | at most $600 of buys a day (0 = no dollar cap) |
| `DAILY_CAP_SOL` | 0 | optional SOL cap on top (0 = none) |
| `DAILY_LOSS_LIMIT_SOL` | **0 (off)** | stops new buys for the day after losing this much |
| `MIN_SOL_RESERVE` | 0.02 | never spends below this |
| `MAX_PAY_ABOVE_DECU_PCT` | 15 | skips a buy priced more than 15% above Decu's; also skips when a price is missing |
| `MIN_LEADER_BUY_USD` | 50 | ignores Decu's smaller buys |
| `PUMP_ONLY` | `true` | pump.fun and PumpSwap coins only |
| `STOP_LOSS_PCT` | 20 | sells everything if the coin falls 20% from your entry; applies in both styles |
| `GAIN_GATE_PCT` / `MAX_HOLD_SEC` | 15 / 15 | auto style: 15 s after Decu's buy, sells if the coin reached +15%; otherwise holds until he sells |
| `SELL_ALL_ON_LEADER_SELL` | `true` | auto style: sells everything at his first sell |
| `HOLD_LIMIT_SEC` | 600 | auto style: sells after 10 minutes whatever happens |
| `PRICE_FAIL_SELL` | 6 | after 6 failed price checks in a row, sells anyway: a coin that can't be priced may be crashing |
| `BUY_FAIL_BREAKER` | 3 | after 3 failed buys in a row, no new buys for 10 minutes |
| `STALE_DATA_SEC` | 30 | no new buys while Decu's feed has been down this long |
| `SLIPPAGE_PCT` / `SELL_SLIPPAGE_PCT` | 20 / 35 | how far the price may move on a buy and on a sell |
| `FEE_MODE` | `max` | market fees, capped as above; `fixed` uses `PRIORITY_FEE_SOL` + `TIP_SOL` instead |

**Trading style** is set on the dashboard:

- **Auto buy + auto sell**: the bot sells with the exit rules above.
- **Auto buy + manual sell**: you sell when the "Decu SOLD a coin you hold" alert arrives. The stop-loss still applies.
- **Both off**: no new buys.

## What going live changes

These are your decision. Nothing here is set for you.

Make the changes in Render → Environment. Saving restarts the bot.

| Setting | Live value | Why |
|---|---|---|
| `DRY_RUN` | `false` | real trades |
| `ENGINE_STATE_FILE` | `/var/data/engine-live.json` | the bot refuses to start live on the paper state |
| `STUDY_FILE` | `/var/data/study-live.jsonl` | keeps the live journal and brain apart from paper |
| `DASHBOARD_TOKEN` | a new value of 24+ characters | the current one was pasted in a chat |
| `PHANTOM_PRIVATE_KEY` / `PHANTOM_WALLET_ADDRESS` | your pump.fun wallet (see "Using your pump.fun wallet") or a **new** wallet, holding only what you can lose | the current bot wallet's key was pasted in a chat |

**For the canary days, tighten the limits.** For example:

- `BUY_SOL` 0.05. The fees, about 0.007 SOL per round trip (up to 0.026 at your caps), are the price of the test.
- `MAX_OPEN_POSITIONS` 1
- `DAILY_CAP_USD` 20
- `DAILY_LOSS_LIMIT_SOL` 0.05

Keep the trading wallet in Phantom or Solflare on your phone, so you can sell by hand at any time.

Connecting it to the dashboard only reads its address and balance. The dashboard never asks a wallet to sign.

## Using your pump.fun wallet

pump.fun has no login a bot can trade through. A pump.fun account is a Solana wallet, and the bot trades with a wallet's key. To have the bot trade your pump.fun money, it needs that wallet's key.

**You do this yourself, in Render. Never paste a key into a chat.**

1. **Find the address.** On pump.fun, open your profile; the address is under your name.
2. **Get the private key.**
   - If you log in with Phantom or Solflare, the key is in that app. In Phantom: Settings → Manage Accounts → the account → Show Private Key.
   - If you log in with email or Google, pump.fun made the wallet for you. Look in pump.fun's settings for exporting the wallet's private key.
3. **Set it in Render → Environment.**
   - `PHANTOM_PRIVATE_KEY`: that key.
   - `PHANTOM_WALLET_ADDRESS`: that address.
   - Both must come from the same wallet, or the bot refuses to start and the dashboard goes down. If that happens, put the old values back.
4. **Save.** The bot restarts. Dashboard → Bot → Wallets shows the address, and its **pump.fun** button opens that profile.

**What it means:**
- **In paper,** nothing is spent from it, except by the landing-speed test.
- **In live** (`DRY_RUN=false`), the bot can spend everything above 0.02 SOL in it, at most $600 of buys a day. Set `DAILY_LOSS_LIMIT_SOL` before going live.
- **Your own coins are safe from its sells.** The bot only sells coins it bought, and never more than it bought. Coins you already hold, even of the same coin, are never sold by it.
- **Trading by hand in the same wallet is allowed.** The bot may then find less SOL than it expected; that buy just fails.
- **The key lives on Render.** Anyone who gets into your Render account can take everything in that wallet.
  - Keep in it only what you're willing to lose.
  - A second Phantom or Solflare account just for the bot is safer. Connect it to pump.fun, and pump.fun shows its coins the same way.

## The canary: first live trades

1. **Wait until the bot is ready.** After the live settings restart the bot, Home must show no "Not ready to trade" banner, and `https://<your-dashboard-address>/ready` must answer 200.
2. **Let it buy.** Leave the style on **Auto buy + auto sell**. The bot copies Decu's next buy that passes the rules.
3. **Check the buy.** Open it on Solscan when the buy alert arrives. SOL out should be `BUY_SOL` plus fees, and the coin should be in the wallet.
4. **Check the automatic sell.** Let the exit rules sell it. On Solscan: SOL came back, the coin is gone, and the token account was closed (rent back).
5. **Check the manual sell.** On the next trade, press the coin's **Sell** button (Home → open coins) as soon as it's bought.
6. **Compare.** The dashboard's numbers for both trades should match Solscan. The Rolex meter now shows live entries.
7. **Restart test.** With one coin held, restart the service from the Render dashboard. When it's back:
   - the coin is listed and priced;
   - readiness is green;
   - its exit rules still apply.

Raise the size only after these pass, and only once live fills match what paper predicted.

## Emergencies

| Situation | Do this |
|---|---|
| Stop new buys now | Dashboard → **Emergency stop**. Coins held keep their stop-loss and exit rules. |
| Sell everything now | Dashboard → **Sell all**. Live: real sells, at up to 35% slippage. |
| Sell one coin | Its **Sell** button (Home → open coins) |
| "CAN'T SELL" alert | The bot keeps retrying. If it persists, sell in Phantom or Solflare. |
| "Bot NOT READY to trade" alert | Bot → Connections names the failing check. A coin with no price has a blind stop-loss: sell it by hand if it doesn't recover. |
| Dashboard or Render down | Sell in Phantom or Solflare. |
| Back to paper | Sell the live coins first: paper mode doesn't manage them. Then in Render → Environment: `DRY_RUN=true`, `ENGINE_STATE_FILE=/var/data/engine-paper.json`, `STUDY_FILE=/var/data/study-paper.jsonl`. |

**Don't turn Power OFF while coins are held.** OFF stops the price checks, so the stop-loss can't fire. Readiness shows "Bot power" as blocking.

## Recovery after a crash or restart

- **What survives.** State is saved on the Render disk (`/var/data`). On restart the bot:
  - reloads the state;
  - re-checks every transaction it had signed, so it never buys twice;
  - puts each held coin back under its price checks.
- **Check after every restart.**
  - Home: the open coins are listed and priced.
  - Bot → Connections: every check OK.
  - `/ready`: 200.
- **Refusals are protection, not bugs.** The bot refuses to start when the state file belongs to the other mode or to another wallet. Fix the setting; don't delete the file.
- **Never delete `engine-live.json` while coins are held.** The bot would forget them. Sell them first.
- **Disk snapshots.** Render keeps a daily snapshot of the disk. Restore one only with the bot stopped. A restored state can miss trades made after the snapshot, so compare it with the wallet on Solscan.

## Monitoring

- **`/health`** answers "is the process running?". Render's health check stays on it.
  - Don't point Render's check at `/ready`.
  - A restart can't fix stale data, and it can interrupt a sell.
- **`/ready`** answers **200** when ready. Otherwise it answers **503** with the names of the failing checks (no details, no secrets).
  - Point an outside uptime monitor at `https://<your-dashboard-address>/ready`.
  - Alert when a 503 lasts more than 2 minutes.
- **What `/ready` checks.** Blocking checks:
  - Bot power.
  - Decu's trades feed: the Helius websocket. If only the backup poll is running (within 60 s), this is a warning instead.
  - Open coins priced: each within 30 s (`READY_PRICE_STALE_SEC`).
  - New buys allowed: no circuit breaker and no stale data.
  - Disk writable.
  - Wallet balance covers one buy (live only).

  Warnings only:
  - Helius: 10+ calls refused or 5+ timeouts in the last minute.
  - Phone alerts: 3+ failed sends in a row, or no topic set.
  - Buying paused (Emergency stop, or both styles off).

  The dashboard shows them all under Bot → Connections. With the token, `/api/ready` gives the details.
- **Phone alerts.**
  - "Bot NOT READY to trade" after 2 minutes not ready (`READY_ALERT_SEC`).
  - "Bot ready to trade again" when it recovers.
  - No page while you keep the bot OFF on purpose with no coins held. `/ready` still answers 503 then. OFF with a coin held is paged: that coin's stop-loss is blind.
  - Alerts can fail themselves (ntfy daily limit, network). `NTFY_TOKEN` lifts the free limit.
- **Helius rate limit.** Decu's wallet also runs arbitrage: one transaction swapping across several venues, about 100 in 43 s on 2026-10-28. These are downloaded 2 at a time (`ARB_DOWNLOADS`), so a burst can't use up the Helius limit. His normal trades never wait behind them.

## Running on a computer instead of Render

- **Switch to live.** Double-click `go-live-mac.command` / `go-live-windows.bat`, or run `node copybot.mjs setup --live`.
  - It asks for the wallet key without showing it.
  - It sets `DRY_RUN=false` and the live state file.
  - It then runs `node copybot.mjs check`.
- **Back to paper.** `back-to-paper-*` or `node copybot.mjs setup --paper` switches back.
- **Same caps.** The daily caps above apply on a computer too.

## What protects your money

- **Every live transaction is checked before sending.**
  - The only SOL that can leave is the buy itself (up to `BUY_SOL` plus slippage), the tip, and fees.
  - Transfers to any other address, token transfers and approvals are refused.
  - One pump.fun trade per transaction, then a full simulation must match.
- **Limits on buying.**
  - One buy per coin.
  - The wallet reserve.
  - The daily caps.
  - The circuit breakers.
  - The Emergency stop button.
- **Crash safety.** Signed transactions are saved before sending. After a crash the bot re-checks them instead of buying twice.

## Sign-off

Add a row for each gate as it's checked. Never delete old rows.

| Date | Gate | Evidence | By | Result |
|---|---|---|---|---|
| 2026-10-28 | 3. Profit evidence | 46 paper trades, −0.017 SOL after fees; paper rules differ from live | Claude | **FAIL: NO-GO** |
| 2026-10-29 | 1. Tests | `npm test` 204/204 in ~15 s, exits on its own, leaves no files; `npm run smoke` 2/2 | Claude | PASS |
| | 2. Data providers | | | |
| | 4. Preflight | | | |
| | 5. Canary | | | |
| | 6. Operations | | | |
| | 7. Independent review (Victor) | | | |
| | 7. Your written approval | | you | |
