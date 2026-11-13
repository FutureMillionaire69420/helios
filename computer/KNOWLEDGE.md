# What we know beyond the code

Ultron's long-term memory for this bot. Read it before proposing any trading change. Update it when the
evidence changes, and keep it short: numbers, sources, and what to do with them.

**Evidence grades**
- **A:** the bot's own data (walk-forward paper tests, trade notes). This outranks everything else.
- **B:** plausible and checkable, but not yet tested on our data.
- **C:** anecdote, self-reported P&L or sponsored content.
- **X:** rejected, or not to be done at all.

## 1. How to read outside advice

Most trading videos are sponsored (terminal referral links with 25–35% cash back, Telegram bots, launchpads)
and survivorship-biased: the channels that blew up don't post. P&L screenshots are self-reported, and the
culture openly fakes them ("LAR a P&L"). Treat every claim as grade C until our own data agrees. A video
saying "this works" is a reason to **test** something, never a reason to **change** something.

## 2. What our own data says (grade A, as of 2026-11-13)

- **Copying Decu as-is loses.**
  - At his own entry price (PCAT) his trades made +6.1 SOL. Our copies (FCAT) made −0.4 SOL over 242 trades, at 0.1 SOL a trade.
  - Across his last 600 buys, copying every one would have averaged −10% to −17% a trade.
- **Fees are bigger than the edge.**
  - November: 63 trades, +$43.11 before fees on the $10 mirror, $51.24 in fees ($0.81 a trade, about 8%).
  - Current fees: FEE_MODE=max, priority up to 0.001 SOL plus tip up to 0.002 SOL, so up to 0.003 SOL per side.
  - A fixed fee hurts most at small sizes: about 6% of a 0.1 SOL trade, about 1.2% of a 0.5 SOL trade.
- **Speed is not the problem.**
  - 627 of 816 trades had nobody buying ahead, yet paid a median +43% over Decu's price.
  - The premium is Decu's own buy moving the curve, so a faster feed is worth about $0. Don't buy LaserStream.
- **Bigger Decu buys copy worse.** 1–2.5 SOL: 34 trades, 50% won, +0.10 SOL. 4+ SOL: 81 trades, 32% won, −0.50 SOL. That fits the self-impact idea.
  - The DIP/FCAT brains found the opposite on their filters: Decu's buy of at least $300 did better. This conflict is unresolved; settle it with a walk-forward test, not a rule.
- **What helped in paper tests** (SOL totals, before → after):

  | Test | Trades | Without | With | Notes |
  |---|---|---|---|---|
  | Buy the dip (15%, give up after 30 s) | 817 | −6.36 | −0.26 | closest to break-even |
  | Skip coins over $10k market cap | 1224 | −9.32 | −5.19 | |
  | Quick-flip guard (Decu sells within 10 s → pause 60 min) | 1552 | −10.77 | −8.60 | |

  Every "SUPPORTED" test still loses overall.
- **What didn't help:**
  - Break-even stop: no longer supported.
  - Copying only his first buy of a coin.
  - The holder-money rule: the coins a stricter version rejects did about 5 points *better*.
  - Every dip trigger the duel traders use.
  - The brain's predictions: no better than guessing the average (mean miss 20.4 vs 20.3 points).
  - **Early exit at 1 s when the first second falls** (tested 2026-11-13 on 232 per-second tables): it makes things worse, −0.70 → −0.71 to −0.78 SOL. Coins that dip in the first second often recover by second 15. Don't build it.
  - The DIP explorer's $150 minimum (−0.016 SOL a buy over 30 buys) and FCAT's $75 check (−0.012 a buy). Decu's small buys copy badly.
- **Where it wins and loses:**
  - Market cap under $6k: 50% won. $10–20k: 18% won.
  - Paying 0–15% over his price: 52% won.
  - Exiting at his sell is the worst exit: median −20%. When the leader sells, the copiers are the exit liquidity.
  - 00–03 UTC: 22 trades, 59% won. 16–19 UTC: 107 trades, 30% won. A hint, not proof.
- **Undone and not to be proposed again** before 200 more bought trades:
  - Premium cap 20% with stop −25% (undone Nov 3).
  - Premium cap 25% (undone Nov 2).
- **Helius:**
  - The Free plan has 1M credits a month and can't buy extra.
  - Since 2026-05-01 websocket data costs 2 credits per 0.1 MB, plus 1 per connection. Our meter only counts plain calls, which is why it read 304k when Helius cut us off on Nov 10 at 09:50 UTC.
  - The bot has seen nothing since, and keeps retrying about 190 calls a minute.

## 3. Memecoin knowledge from videos (graded)

**Bundle and rug checks** (B; most are cheap to measure, some cost Helius credits):
- No single holder (not the curve) should own over 4% of supply. Measure this *without Decu*: he is often the top holder right after his own buy. `holder0.top1Pct` exists, but it includes him.
- Bundle signs:
  - Top holders with near-identical SOL balances: one `getMultipleAccounts` call.
  - The same funding source and funding time across top holders: costly.
  - The same % held across holders.
  - Freshly created wallets in the top 10.
  - All top holders on the same terminal, or top holders whose recent trades overlap.
- Chart signs:
  - A dev buy that rockets to $10k in one candle.
  - A straight-up chart with no pullbacks, then one nuke.
  - Many equal-size bubbles on a bubble map.
  - Mixers now defeat bubble maps, so treat them as weak evidence.
- Other signs:
  - DEX paid at a $15–30k market cap: someone is protecting a big multi-wallet bag. Free to check via DexScreener.
  - Bot comments on the coin page ("all time high", "interesting").
  - Recent buys that are all bot-sized.
- Screen filters others use: dev ≤ 5–10%, insiders ≤ 20%, snipers ≤ 20%, and a minimum count of "pro traders" (buyers using terminals).

**Entries** (B):
- Don't top-blast. Buy dips: about 40% off on $20–40k coins; 35%, 50% or 65% after a new high on bigger ones.
- Wait for the first green candle; don't catch a falling knife. Fits our dip result. The untested variant is a dip followed by the first up-tick.
- Prefer community coins (an X community) over tweet coins. Prefer original ticker and art over copies.
- Derivatives top out at about a quarter of the main coin.
- More than 2 tracked "big flipper" wallets underneath you means you are their exit liquidity.

**Exits** (B):
- Sell the initial stake at 2x. Small accounts take the whole 2x.
- Scalp 30–50%. Leave when the chart chops sideways (bought up, sold off) without new volume.
- Sell into the big candle, where everyone else sells.
- Mental stop at −20%.

**Fees seen in videos** (C):
- Priority 0.00001 SOL, tip 0.0001 SOL, MEV protection off for small buys, slippage buy 20–35% / sell 50–70%.
- "Under $10 a trade you need +30% just to break even" matches our fee data.
- Note: Helius Sender needs a tip of at least 0.001 SOL; TIP_SOL=0 means a normal send.

**Market regime** (B/C):
- Night and EU hours have less competition.
- "When the market is dead, stop." Stop after about 5 losses in a row. Set a rough daily goal and stop after it.
- Risk 10–30% of the account per trade. Count P&L in SOL, not dollars.

**Psychology** (C):
- Treat SOL in a trading wallet as already spent.
- Don't compare yourself to big accounts.
- Revenge trading after losses is the main way small accounts die.

## 4. Never do (X)

- Launching or "dev'ing" coins for creator fees. Bundling or splitting buys to hide supply. Faking P&L. Paid engagement farming. These are manipulation, and the bot never does them.
- Copy-buying known influencer wallets or calls. Buying Mayhem-mode coins.
- Showing or pasting a private key, seed phrase or wallet export anywhere: not on a stream, not in chat. Streamers get drained this way.
- Candlestick-pattern trading (engulfing, doji, hammer…) on 15-second holds. It's untested and noise at this timescale. At most, use it as a "first green candle" confirmation inside the dip test.
- Polymarket 5-minute BTC bets. The video's manual trading lost 100%, and its copy-trading claims were sponsored. Out of scope.

## 5. How Ultron should work (from the AI-agent videos)

- **Automate only what is autonomous, recurring and reviewable** (ARR). One-off or judgment calls stay with the owner.
- **Before building, check goal, proof and steps** (GPS): a one-sentence goal, what "good" looks like, and steps written out.
- **Give every automated job a pass/fail test,** not "double-check your work". For the bot: `npm test`, smoke, walk-forward splits, "deploy live and logs free of 429s".
- **Use narrow agents:**
  - Scout: read-only data gathering.
  - Operator: acts within rules.
  - Advisor: the top 3 actions.
  - If a number can't be verified, write "unavailable". Never guess.
- **Run an accountability loop.** Keep the open decisions below; raise any that sit unanswered for days.
- **Turn corrections into rules,** saved here or in `CLAUDE.md`.
- **Watch for context rot.** Long chats make the model worse. When a session runs long, summarize into this file and start fresh.
- **Build skills from our own repeated work,** not downloaded packs. Plan before building. Keep one task per session.

## 6. Improvement backlog (ranked)

1. **Restore sight** (blocker):
   - Count websocket bytes in the Helius meter.
   - Back off on "max usage reached".
   - Subscribe to price streams only for coins we hold or test.
2. **Fees** (biggest lever, needs the owner's OK):
   - Paper what-if at lower fee levels and at larger sizes.
   - Then a tiny real landing test before any live change.
3. **Measured-only labels at zero extra credits:**
   - Largest holder excluding Decu over 4%.
   - Decu buy size (≥4 SOL) as a walk-forward test.
4. **Free regime features:**
   - pump.fun launch rate from the PumpPortal stream.
   - DexScreener "dex paid" flag.
   - Community vs tweet link in the coin's metadata.
   - Hour of day.
5. **Losing-streak pause side test** (5 losses in a row → pause 60 min), scored like the quick-flip guard.
6. **Dip with confirmation:** the dip test's variant that buys on the first up-tick after the dip.

## 7. Open decisions waiting on the owner

- Helius: check the dashboard for real usage and the reset date. Wait, upgrade, or use a new key?
- Build backlog item 1 now?
- B7 quick-flip guard as a real paper rule?
- Zip: the bot code (no keys) or the Obsidian vault?
- Turn off the 12-hour heartbeat? Delete the disabled Claude briefing for good?
- A8: remove Decu's address from public helios files?
- Per-area security audit?
