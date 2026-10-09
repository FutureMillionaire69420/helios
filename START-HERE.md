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
| **3CAT / 5CAT / 10CAT** | profit if it sold 3 / 5 / 10 seconds after buying |
| **BTSAB** | best time to sell after buying: the best second (0–15) and its profit |
| **PCAT** | profit if you'd bought at Decu's own price and sold when he sold |
| **entry … vs his price** | how much more the robot paid than Decu |
| **Every second** | profit % at each second, 0 to 15 |
| **Best fixed sell / take-profit / TP+stop** | the selling rule that would have made the most so far |

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
6. Double-click **start** again. Day one is limited to **0.2 SOL** of buys.
7. Pick your trading style in the dashboard (two toggles, only one can be ON):
   - **Auto buy + auto sell**: the robot buys when Decu buys and sells the same share when he sells.
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
