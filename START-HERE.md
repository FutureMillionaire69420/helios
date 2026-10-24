# Start here: get the bot running (simple version)

**What this is:** a robot that watches one trader (Decu). When he buys a pump.fun coin, the robot buys
the same coin. It runs on your computer, and your phone gets a message when something happens.

**Two modes:**
- **PAPER** = pretend money. The robot acts as if it bought, so you can see if it *would* have made
  money. **Start here. No real money is used.**
- **LIVE** = real money. Only after paper mode has made money for several days.

> Honest warning: the test runs so far **lost** money (see TEST-RESULTS.md). Paper mode is how you
> find out whether it works before risking anything. Never use money you can't afford to lose.

---

## What you need (shopping list)

| Thing | Why | Cost |
|---|---|---|
| A Mac or Windows computer that can stay **on and plugged in** | the robot lives here | — |
| **Node.js** | the engine the robot runs on | free |
| **Helius** API key | the robot's eyes on the blockchain | free to start |
| **Solscan** API key | a second pair of eyes (optional at first) | paid plan |
| **ntfy** app on your phone | messages from the robot | free |

---

## Part 1: Set up pretend trading (about 20 minutes)

### Step 1. Install Node.js
1. Go to **https://nodejs.org**
2. Click the big **LTS** download button (version 22 or newer).
3. Open the downloaded file and click **Next / Continue** until it's done.

### Step 2. Put the robot on your computer
1. Download the zip file I sent you (`decu-bot.zip`).
2. Double-click it. You get a folder called **decu-bot**. Move it to your **Desktop**.
3. Open **decu-bot**, then open the **computer** folder inside it. All the buttons are in there.

### Step 3. Get your Helius key
1. Go to **https://dashboard.helius.dev** and sign up.
2. Find **API Keys** and copy your key (it looks like `1a2b3c4d-....`).

### Step 4. (Optional now) Get your Solscan key
Go to **https://solscan.io/apis**, pick a plan, and copy your API key. You can skip this and add it
later by running setup again.

### Step 4b. (Optional) PumpPortal key: a second way to see Decu's trades
On **https://pumpportal.fun**, create an API key. Put it in `PUMPPORTAL_API_KEY` (in `.env`, or in Render's Environment). Never put it in a file you share: the key can trade from the PumpPortal wallet linked to it. PumpPortal charges 0.01 SOL per 10,000 of Decu's trades it streams, taken from that linked wallet, so keep at least 0.02 SOL there.

### Step 5. Run setup
- **Mac:** right-click **setup-mac.command** → **Open** → **Open**.
  (If there's no Open button: System Settings → Privacy & Security → scroll down → **Open Anyway**.)
- **Windows:** double-click **setup-windows.bat**. If a blue box says "Windows protected your PC",
  click **More info** → **Run anyway**.

A black window opens and asks questions:
1. Paste your **Helius key**, press **Enter**.
2. Paste your **Solscan key** or just press **Enter** to skip.
3. It shows a **Dashboard password** and a **Phone alert topic**. **Write both down.**
4. It checks everything. Lines say **OK** or **FAIL**. In paper mode, "SKIP wallet checks" is normal.

### Step 6. Phone messages
1. Install the **ntfy** app (App Store / Google Play).
2. Tap **+**, type your **Phone alert topic** exactly, tap **Subscribe**.

### Step 7. Start the robot
- **Mac:** double-click **start-mac.command** (right-click → Open the first time).
- **Windows:** double-click **start-windows.bat**.

**Leave that window open.** Closing it stops the robot. If the robot crashes, it restarts itself
and your phone gets a message.

**Keep the computer awake:**
- **Mac:** keep it plugged in with the lid open. The robot stops the Mac from sleeping while it runs.
- **Windows:** Settings → System → Power → "When plugged in, put my device to sleep after" → **Never**.

### Step 8. Watch it
- On the same computer, open a web browser and go to **http://localhost:3000**. Paste your
  **Dashboard password** and press **Connect**.
- To see the score: double-click **status-mac.command** / **status-windows.bat**.

### Step 8b. Read the trade-study alerts
After every coin the robot buys, it watches the price **every second for 15 seconds** (then stops
touching that coin) and sends one alert:

| In the alert | Means |
|---|---|
| **FCAT** (main number) | the bot's own rule: bought as fast as possible, sold when Decu first sold, or 15 seconds after **Decu's** buy if he hadn't |
| **3CAT / 5CAT / 10CAT** | profit if it sold 3 / 5 / 10 seconds after buying |
| **BTSAB** | best time to sell after buying: the best second (0–15) and its profit |
| **PCAT** | profit if you'd bought at Decu's own price and sold when he sold |
| **entry … vs his price** | how much more the robot paid than Decu |
| **BAND** | the same trade if each buy were 10% of what Decu spent (he buys 2 SOL → 0.2 SOL) |
| **Every second** | profit % at each second, 0 to 15 |
| **Best fixed sell / take-profit / TP+stop** | the selling rule that would have made the most so far |

| **Notes** | what happened on this trade: how late, how much more than Decu it paid, what each rule would have done |
| **Brain** | the robot's own thinking: what it predicted before the result (right or wrong, and its score), which learned pattern the trade matched, the price shape, what your real exit rules did |
| **Patterns** | what the robot has learned so far (▲ = kind of trade that wins, ▼ = loses) |
| **Journey** | its level (Rookie → Learner → Analyst → Strategist → Veteran → Master) and the go-live checklist (x/4) |

**The robot also sends its own learning alerts:**
- **New pattern spotted / Pattern CONFIRMED / Pattern faded**: it noticed a kind of Decu trade that wins or loses more than the rest (for example "paid more than 70% above Decu → loses"), proved it with more trades, or found it was just luck.
- **Win / Losing streak**: 3 or more in a row, and what those trades had in common.
- **Learning report** every 10 trades and **Level up**: is it getting better, how often its predictions are right (compared with just guessing), the patterns it trusts, and the **advisor** (which max-pay limit, stop-loss and +gain gate would have made more). It never changes a setting by itself.
- **Daily digest**: the last 24 hours in one message.

Decu's Raydium LaunchLab / bonk.fun coins are ignored completely: no copy, no study, no alert.

**Two words used everywhere:**
- **Execution latency**: seconds from Decu's buy to the bot's buy. The alert's *Latency:* line splits it into steps (seen, decode, decide, build, send, land) and shows the part that is only SIMULATED in paper (1 s).
- **Entry premium**: how much more per token the bot paid than Decu, **price vs price** (fees are shown separately on the same line). The bot skips buys over **15%** (the entry-premium filter), in paper and live. If it can't get Decu's price or the current price, it does **not** buy. Every alert also shows what a **10%** and a **25%** limit would have done: `Filters: 10% SKIP · 15% (trading) TAKE · 25% TAKE`.
- **Holder money**: every alert has a line like `Holders (dev excluded) hold $900 in 412 wallets · dev holds 30.0% · mcap $12,000 → RISKY (needs $1,000 at this mcap)`. Your rule: the coins held by every wallet except the dev must be worth at least **$1,000 at a $10k market cap, $2,500 at $20k, $4,000 at $30k**. It only reports; it never changes a trade.

A Decu buy the bot did not take (filtered, 2 coins already open, daily cap, paused) is still studied and shown on the dashboard, so the research never hides the trades it missed. Skipped buys send no phone alert (`SKIPPED_ALERTS=false`; `report` = only those inside 25%, `true` = all), so your ntfy messages go to trades the bot made and to the charts.

**Speed:** fees follow the market for every buy and sell, capped at **0.003 SOL per side** (`FEE_MODE=max`: up to 0.001 SOL priority + 0.002 SOL tip). The bot builds both the buy AND the sell itself (no PumpPortal round trip). Each coin's sell is ready the moment it is bought, and selling everything also closes the coin's token account (about 0.002 SOL rent back per coin). The current block, "your transaction confirmed" and every price change of a held coin are **pushed** to the bot over the websocket, so it never waits for the next check.

**Paper tests of other exits** (on every trade, nothing changes for real): **c** = a -20% stop counted on your money, **d** = sell when the holders' money (dev excluded) falls behind the market cap. Notes and the dashboard compare each with your real rules on the same trades. The real stop-loss **always** sells.

**Limits:** at most **2 coins** open at once, at most **$600** of buys a day, no daily loss limit. New buys stop by themselves (sells never stop) if 3 buys fail in a row (10 min) or Helius stops sending data.

**Selling:** the bot sells on Decu's sell only once his sell is **confirmed** on-chain (about 0.4 s later), so a sell of his that fails can't make it sell. Buys still use the fastest path.

**Stop-loss alerts, in order:** STOP TRIGGERED → SELL SENT (live) → POSITION CLOSED (with the trigger vs the real fill). If prices can't be read 3 times in a row you get *Price checks failing*; after 6 it sells anyway. If a sell fails it retries at once; after 3 failures you get **CAN'T SELL** and it keeps trying.

**Solscan (a priority source):** while the bot is ON, Solscan watches Decu every 5 s while a coin is held or Helius is down, and every 60 s otherwise. It is also the first source for the SOL price (every 2 min). Hard cap: 2,500 requests a day. When the day's remaining requests run low, it slows down just enough to keep watching until midnight UTC. OFF uses no Solscan at all. The dashboard shows today's count.

**PumpPortal feed (second way to see Decu's trades):** with `PUMPPORTAL_API_KEY` set, PumpPortal pushes each of his trades too. If it is first, the bot copies his buy right away; Helius' copy of the same trade is ignored, so it never buys twice. His sells are still acted on only once confirmed. The dashboard counts which feed was first and by how many ms. Once per run, the bot also asks PumpPortal's builder for a sample buy (never signed or sent) and shows whether the safety check accepts it. PumpPortal charges **0.5% per trade it builds**, so the bot uses it only as a fallback.

**Analytics (dashboard + phone):** the dashboard's Analytics section shows every measurement as a chart: running profit, profit per trade and per day, drawdown, results and win rate by entry premium, speed (blocks after Decu) and results by speed, profit by exit, hold time vs result, the average price path after a buy, the best second to sell, the holder rule, where the profit goes, and fees. Tap a chart for exact values, or open "Numbers". Only trades the bot bought count. The charts use only the bot's own records, so they cost no Helius or Solscan credits. Once a day (when there are new trades) the 6 key charts are sent to your phone as ntfy pictures. You can also press "Send these charts to my phone". Chart messages are capped at 12 a day, so trade alerts always get through.

**Per-coin chart (phone):** right after each bought trade's alert, a second notification shows that coin's own chart. Its line is your profit % every second after the buy. 3CAT, 5CAT, 10CAT and the best second are marked and named on the time axis, and so are Decu's sell and the bot's exit. The stop-loss, the +15% gain gate and break-even are drawn as labelled lines. The header gives PCAT, BAND and the win rates. The text below reads the chart like a trader: what the price did, the exits ranked best to worst, whether the stop or gate was hit, the BAND results in SOL, the win rate of each exit, and how setups like this one did. Up to 60 a day.

**Bot power ON / OFF (dashboard, top):** OFF stops everything that uses your Helius and Solscan credits. The bot stops watching Decu, stops checking prices and stops all background lookups. The dashboard keeps working, and ON starts it all again. The choice is kept after restarts. In LIVE, OFF asks first if coins are still held, because their stop-loss can't run while it's off.

**Dashboard on your iPhone:** open the bot's address in Safari → Share → *Add to Home Screen*. It shows mode, balance, P&L, positions, entry premium, execution latency, why buys were skipped, the brain's level, and two red buttons: **EMERGENCY STOP** (no new buys) and **Sell everything**.

All of it is saved. Double-click **study** (or run `node copybot.mjs study`) any time, even with the
robot stopped, to see the full table: profit for every sell second, the top selling rules, and the
last 10 trades. After 3 days this tells you which selling rule to use.

### Step 9. Wait at least 3 days, then read the score
Double-click **status**. You'll see lines like:

```
his-sell+10s   120 trades   45 wins   -0.0800 SOL
```

- **his-sell+10s** = "if I sold 10 seconds after Decu sold". That's realistic for selling by hand.
- The last number is the pretend profit. **Minus = it lost money. Then don't go live.**
- Go live **only** if that number is **plus**, over **100 or more trades**.

---

## Part 2: Real money (only if Step 9 was profitable)

1. **Make a brand-new wallet.** In Phantom: tap your account → **Add / Connect Wallet** →
   **Create new account**. Never use your main wallet.
2. **Put a little SOL in it:** about **0.3 SOL** for day one (two copies of 0.1 SOL, plus fees).
3. **Copy its private key:** Phantom → Settings → Manage Accounts → (the new account) →
   **Show Private Key**. **Never show this to anyone. Never paste it in a chat (including this one).**
4. **Stop the robot** (close its window).
5. Double-click **go-live-mac.command** / **go-live-windows.bat**:
   - type **LIVE**, press Enter
   - paste the private key (you won't see it while pasting, that's normal), press Enter
   - check the wallet address it shows matches Phantom, type **yes**
   - it runs the go-live check. **The last line must say READY FOR LIVE.** It tests a real buy but
     does **not** send it.
6. Double-click **start** again. There is **no daily spending cap**: the robot buys every copy the wallet can pay for, so the SOL you put in the wallet is your limit.
7. Pick your trading style in the dashboard (two toggles, only one can be ON):
   - **Auto buy + auto sell**: the robot buys when Decu buys and sells **everything** the moment he
     first sells. **15 seconds after Decu's buy** (not the robot's): if the trade reached **+15%** by
     then it sells; if it never did, it keeps holding until Decu sells (10 minutes at most).
   - **In both styles: if the coin falls 20% from the robot's entry price (fees ignored), it sells everything at once (stop-loss).**
   - **Auto buy + manual sell**: the robot buys when Decu buys. When your phone says
     **"Decu SOLD a coin you hold"**, you sell that coin yourself in Phantom.
   - Both OFF = no new buys. Same from a terminal: `node copybot.mjs style auto|manual|off`.
8. Want to stop using real money? Double-click **back-to-paper**, then start again.

---

## If something goes wrong

| You see | Do this |
|---|---|
| "Node.js is not installed yet" | Do Step 1, then try again. |
| Mac: "cannot be opened" / "permission denied" | Right-click → Open. Still stuck: open **Terminal** and paste `chmod +x ~/Desktop/decu-bot/computer/*.command` then Enter. |
| "The bot stopped 5 times right after starting" | Read the red line just above it. Usually a missing or wrong key: run **setup** again. |
| Dashboard shows lots of "Too Many Requests" | Your Helius plan is too small. Upgrade it on dashboard.helius.dev. |
| No phone messages | Check the topic in the ntfy app is exactly the one setup showed. |
| Dashboard page won't load | The robot isn't running: double-click **start**. |
| "Trade outcome UNKNOWN" message | Do nothing and don't restart in a panic. The robot keeps checking and never buys twice. Look at the transaction link. |

## Safety rules
1. Only the **new** wallet goes in the robot. Never your main wallet.
2. Never share or screenshot your private key or the `.env` file.
3. Run **one** robot at a time.
4. Never delete `engine-live.json`. It's the robot's memory of real trades.

### Phantom note

For true unattended execution, Phantom itself cannot silently approve each server-side transaction. The bot therefore uses the burner account's Solana private key locally for autonomous signing, while the dashboard's **Connect Phantom** button verifies that the browser-connected Phantom account matches the configured burner address. Phantom documents `signAndSendTransaction` as a wallet-approved flow, and warns never to share a private key or recovery phrase.
