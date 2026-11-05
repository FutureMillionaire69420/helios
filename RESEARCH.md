# Decu bot: execution latency vs. entry premium (research, 2026-10-12)

**Data:** every on-chain trade (from Solscan Pro) on Decu's 25 most recent SOL-bought pump.fun
coins, 2026-10-11, plus the bot's 10 paper studies. One block (slot) is about 0.4 s.

**Assumptions:**
- **Entry price:** the price paid by the first other buyer at or after a given block. That buyer's own size is included, so it is not a 0.1 SOL fill.
- **Exit price:** the first trade at or after 15 s.
- **Fees and price impact:** a flat 3%.

These are **estimates, not executed trades**. The sample is one day.

## 1. What the "1.7 s" in the paper alerts is

| Part | Size | Measured? |
|---|---|---|
| Decu's on-chain clock is whole seconds | 0–1 s (≈0.5 s on average) | rounding, not delay |
| Websocket notice + decode + decision | well under 1 s | yes (now shown per trade) |
| Paper "landing" wait (`PAPER_LAND_MS`) | **1.0 s** | **no: a fixed simulation** |
| Build + sign (local builder) | ~6 ms (`node bench.mjs`) | yes |
| Real send + landing | unknown | only in LIVE (now recorded per trade) |

So the 1.7 s is **not** a measured execution latency. From now on every alert has a `Latency:`
line with each stage, marks the simulated part, and counts **blocks after Decu**.

## 2. The price jumps in Decu's own block

In Decu's own block there were a median of **8 other buyers** (snipers and other copy bots in the same block).

| Bot buys at | ≈ time | Median entry premium | Over 60% | Copy all 25 (SOL) | With 60% filter (SOL) |
|---|---|---|---|---|---|
| block +1 | 0.4 s | +56% | 11/25 | −0.012 | +0.078 (14 kept) |
| block +2 | 0.8 s | +62% | 13/25 | −0.113 | +0.006 |
| block +3 | 1.2 s | +60% | 13/25 | −0.085 | +0.009 |
| block +5 (today) | 2.0 s | +61% | 13/25 | −0.039 | +0.070 (12 kept) |
| block +10 | 4.0 s | +59% | 12/25 | −0.019 | +0.068 |

**Answer:**
- Going from about 2 s to about 0.4 s, the practical limit for a bot reacting to his trade, changes the median premium only from 61% to 56%.
- Paying Decu's price would require landing in his exact block. That can't be done by reacting.
- **More spending on speed is not justified by this data.** Helius Pro is enough.

## 3. The entry-premium filter is the edge (walk-forward)

The threshold was chosen on the older 12 coins and tested on the newer 13, which it never saw.

| Max premium | Older 12 (SOL) | Newer 13, unseen (SOL) |
|---|---|---|
| none | −0.034 | −0.005 |
| **60%** | **+0.029** | **+0.041** |
| 70–75% | +0.032 | +0.031 |
| 100% | −0.013 | −0.001 |

The filter was positive on both halves. That is encouraging, but it rests on about 12 kept trades, so it is not proof.

## 4. Exits

Entry at block +5, all 25 coins / the 12 kept by the 60% filter:

| Exit | All 25 (SOL) | 60% filter (SOL) |
|---|---|---|
| +3 s | −0.022 | +0.010 |
| +5 s | −0.033 | +0.032 |
| +10 s | +0.048 | +0.088 |
| +15 s | −0.039 | +0.070 |

- Decu's first sell came **17–529 s** after his buy. He never sold inside 15 s.
- The +10 s exit looks best, but that is hindsight on one day. Nothing was changed.
- The brain now compares these exits walk-forward, with a 1 s sell delay, as trades accumulate.

## 5. No reliable signal yet

Decu's buy size, coin age, holders and market cap showed no reliable effect in this sample.

## Missing data (now collected automatically)

- Landing block and real send/land times of live buys.
- Executable buy and sell quotes for the bot's own size.
- Skipped buys: now studied anyway and marked SKIPPED.
- 300+ observations for a proper holdout. The advisor only calls a change "supported" with 50+ trades and a gain on both the older and newer parts.

## Roadmap (by evidence, not complexity)

1. Collect at least 50 paper and early live trades with the new latency and skipped-buy records.
2. Go live with the 60% filter and a small wallet. Compare live latency and blocks-after-Decu with paper.
3. Re-check the filter value and exit choice with the walk-forward advisor at 50, 100 and 300 trades.
4. Look at more speed spending only if live data shows a premium gap between block +1 and the block where the bot lands.
