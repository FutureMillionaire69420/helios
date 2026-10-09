# helios

Decu copy bot (pump.fun) with Helius and Solscan as its data providers.

**New here? Read [`START-HERE.md`](START-HERE.md): step-by-step setup with double-click files.**

- Bot, setup and commands: [`computer/START-ON-COMPUTER.md`](computer/START-ON-COMPUTER.md)
- Going live checklist: [`GO-LIVE.md`](GO-LIVE.md)
- Phantom burner setup: [`computer/START-ON-COMPUTER.md`](computer/START-ON-COMPUTER.md)
- What was tested and found: [`TEST-RESULTS.md`](TEST-RESULTS.md)

```
cd computer
npm test               # 58 tests, no network
node copybot.mjs diagnose   # Helius vs Solscan health, parser cross-check, leader profile
node copybot.mjs check      # go-live preflight (never sends)
```

Control a running bot (same as the dashboard buttons; uses DASHBOARD_TOKEN from .env):
```
node copybot.mjs alerts on|off   # phone alerts; LIVE unknown-outcome trades always alert
node copybot.mjs paper on|off    # paper mode only: off = no new paper buys
node copybot.mjs pause | resume  # new buys, any mode
node copybot.mjs status
```
