# helios

Decu copy bot (pump.fun) with Helius and Solscan as its data providers.

- Bot, setup and commands: [`computer/START-ON-COMPUTER.md`](computer/START-ON-COMPUTER.md)
- Going live checklist: [`GO-LIVE.md`](GO-LIVE.md)
- What was tested and found: [`TEST-RESULTS.md`](TEST-RESULTS.md)

```
cd computer
npm test               # 39 tests, no network
node copybot.mjs diagnose   # Helius vs Solscan health, parser cross-check, leader profile
node copybot.mjs check      # go-live preflight (never sends)
```
