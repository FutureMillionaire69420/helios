---
type: findings
mode: paper
updated: 2026-10-26T06:53:44.786Z
buy-the-dip: collecting
break-even: collecting
first-buy: collecting
mcap-cap: collecting
quick-flip: collecting
---

# What the brain has found

Paper tests replayed on the bot's own recorded trades, side by side with what it really does. A test is SUPPORTED only when the version chosen on older trades also wins on newer ones it never saw. Nothing here changes a trade on its own.

## Buy the dip · collecting

Wait for the price to fall below Decu's price before buying (vs buying now; both sell when he sells).

- Trades with data: 0 (chosen on 0, checked on 0)
- Verdict: not enough trades yet (0/50)
- Best on older trades: **5% dip, give up after 30 s**: +0.0000 SOL on older trades, +0.0000 SOL on newer ones (vs what the bot does now)

| version | all trades | older | newer |
|---|---|---|---|
| 5% dip, give up after 30 s | +0.0000 SOL (0 bought) | +0.0000 SOL | +0.0000 SOL |
| 5% dip, give up after 60 s | +0.0000 SOL (0 bought) | +0.0000 SOL | +0.0000 SOL |
| 10% dip, give up after 30 s | +0.0000 SOL (0 bought) | +0.0000 SOL | +0.0000 SOL |
| 10% dip, give up after 60 s | +0.0000 SOL (0 bought) | +0.0000 SOL | +0.0000 SOL |
| 15% dip, give up after 30 s | +0.0000 SOL (0 bought) | +0.0000 SOL | +0.0000 SOL |
| 15% dip, give up after 60 s | +0.0000 SOL (0 bought) | +0.0000 SOL | +0.0000 SOL |

## Break-even stop · collecting

Once a trade is up +10% / +20%, the stop moves to break-even on your money (vs your stop and gate).

- Trades with data: 10 (chosen on 7, checked on 3)
- Verdict: not enough trades yet (10/50)
- Best on older trades: **break-even after +10%**: +0.0000 SOL on older trades, +0.0000 SOL on newer ones (vs what the bot does now)

| version | all trades | older | newer |
|---|---|---|---|
| break-even after +10% | +0.0000 SOL | +0.0000 SOL | +0.0000 SOL |
| break-even after +20% | +0.0000 SOL | +0.0000 SOL | +0.0000 SOL |

## First buy only · collecting

Never copy Decu's later buys of a coin he already bought.

- Trades with data: 10 (chosen on 7, checked on 3)
- Verdict: not enough trades yet (10/50)
- Best on older trades: **copy only his first buy of a coin**: +0.0000 SOL on older trades, +0.0000 SOL on newer ones (vs what the bot does now)

| version | all trades | older | newer |
|---|---|---|---|
| copy only his first buy of a coin | +0.0000 SOL (0 skipped) | +0.0000 SOL | +0.0000 SOL |

| group | trades | won | avg FCAT |
|---|---|---|---|
| first buys | 10 | 10 | +25.9% |
| later buys | 0 | 0 | — |

## Market cap ceiling · collecting

Skip coins whose market cap at Decu's buy is above a ceiling.

- Trades with data: 0 (chosen on 0, checked on 0)
- Verdict: not enough trades yet (0/50)
- Best on older trades: **skip above $10k**: +0.0000 SOL on older trades, +0.0000 SOL on newer ones (vs what the bot does now)

| version | all trades | older | newer |
|---|---|---|---|
| skip above $10k | +0.0000 SOL (0 skipped) | +0.0000 SOL | +0.0000 SOL |
| skip above $20k | +0.0000 SOL (0 skipped) | +0.0000 SOL | +0.0000 SOL |
| skip above $30k | +0.0000 SOL (0 skipped) | +0.0000 SOL | +0.0000 SOL |
| skip above $50k | +0.0000 SOL (0 skipped) | +0.0000 SOL | +0.0000 SOL |
| skip above $100k | +0.0000 SOL (0 skipped) | +0.0000 SOL | +0.0000 SOL |

| group | trades | won | avg FCAT |
|---|---|---|---|

## Quick-flip guard (side test only) · collecting

After Decu sells within seconds, pause copying him. Scored on paper; it never skips a trade.

- Trades with data: 10 (chosen on 7, checked on 3)
- Verdict: not enough trades yet (10/50)
- Best on older trades: **sold within 10 s → skip his buys for 60 min**: +0.0000 SOL on older trades, +0.0000 SOL on newer ones (vs what the bot does now)

| version | all trades | older | newer |
|---|---|---|---|
| sold within 10 s → skip his buys for 60 min | +0.0000 SOL (0 skipped) | +0.0000 SOL | +0.0000 SOL |
| sold within 10 s → skip his buys for 30 min | +0.0000 SOL (0 skipped) | +0.0000 SOL | +0.0000 SOL |
| sold within 5 s → skip his buys for 60 min | +0.0000 SOL (0 skipped) | +0.0000 SOL | +0.0000 SOL |

## Crowd and speed

needs 3+ trades with a crowd count

