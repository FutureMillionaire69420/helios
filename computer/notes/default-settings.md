# Default settings (saved 2026-10-23, before the max-tip test)
Restore these on Render to undo the test:
- FEE_MODE=max
- PRIORITY_FEE_MAX_SOL=0.001
- TIP_MAX_SOL=0.002
- TIP_PERCENTILE=landed_tips_99th_percentile
- PAPER_LAND_MS=600
- MAX_PAY_ABOVE_DECU_PCT=15

# Max-tip test (2026-10-23)
- PRIORITY_FEE_MAX_SOL=0.003
- TIP_MAX_SOL=0.01
- PAPER_LAND_MS=500 (2026-10-23: simulates Helius LaserStream, ~100 ms faster detection than the 600 ms default)
