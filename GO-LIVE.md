# Going live with real money: checklist

Do these in order. Don't skip a step because an earlier one passed.

## 1. Paper results first (DRY_RUN=true)
- Run the bot in paper mode for **at least 3 trading days** with Decu active.
- Dashboard (`/api/status` → `paper`) shows profit per sell timing:
  `buy+4s`, `buy+5s` (sell 4–5 s after your buy) and `his-sell+0s`, `his-sell+10s` (sell after he does).
- **Only go live if the timing you will actually use is positive over 100+ trades.**
  Hand-selling realistically means `his-sell+10s` or slower. `buy+4s`/`buy+5s` needs automatic selling.
- What the Solscan paper tests found on 2026-10-06/07 (sell 4–5 s after buy): 61 trades, 16 wins, −0.133 SOL.
  Selling 8–15 s after he sold: 62 trades, 11 wins, −0.263 SOL. Neither was profitable.

## 2. Wallet
- Use a **separate trading wallet** that holds only what you can lose. Never your main wallet.
- Fund it with at least: copies you want per day × ~0.125 SOL + 0.02 SOL reserve.
  (0.1 buy + 20% slippage room + 0.001 tip + 0.0005 priority fee + fees.)
- The key goes ONLY in `.env` on the computer/server or Render's secret settings. Never in chat.

## 3. Settings (`.env` or Render Environment)
| Setting | Value | Why |
|---|---|---|
| `DRY_RUN` | `false` | real trades |
| `PRIVATE_KEY` | your trading wallet key | signing happens locally |
| `ENGINE_STATE_FILE` | `engine-live.json` (Render: `/var/data/engine-live.json`) | the bot refuses to mix paper and live state |
| `DASHBOARD_TOKEN` | 24+ random characters | required for live |
| `HELIUS_API_KEY` | your key | fast detection + Helius Sender |
| `NTFY_TOPIC` | your topic | buy / SOLD / failure alerts |
| `SIZING_MODE` / `BUY_SOL` / `DAILY_CAP_SOL` | `fixed` / `0.1` / `1` | your rules |
| `AUTO_SELL` | `false` | you sell by hand from the SOLD alert |
| `SLIPPAGE_PCT` | `20` | 10% failed often on his coins |

## 4. Preflight: must print "READY FOR LIVE"
```
node copybot.mjs check
```
With the key set, this builds a **real 0.1 SOL buy**, adds the tip, signs it and runs the full safety
simulation. It **does not send it**. Every line must say OK. It checks:
RPC, his wallet history, live SOL price, websocket subscription, wallet balance vs one copy,
Helius (not public RPC), phone alert, dashboard token, live state file, the full buy path, Helius Sender.

## 5. First live day: smallest possible
- Set `DAILY_CAP_SOL=0.2` (2 copies) for day one. Watch every alert and check each transaction on Solscan.
- Raise to 1 SOL only after the real fills match what paper mode predicted.

## What protects your money
- Every live transaction is checked before sending: the only SOL that can leave is the buy itself
  (max BUY_SOL + slippage), the tip, and fees. Transfers to any other address, token transfers and
  approvals are refused. One pump.fun trade per transaction, then a full simulation must match.
- Daily cap, per-coin once rule, wallet reserve, pause button (stops new buys) on the dashboard.
- Signed transactions are saved before sending; after a crash the bot re-checks them instead of buying twice.
