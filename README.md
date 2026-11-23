# Winner Takes All — Dip-Reversion Pump.fun Bot

[![make.fun](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![Rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/airdropjepe45-svg/winner-takes-all-2/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![Reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/airdropjepe45-svg/winner-takes-all-2/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

A paper-trading bot for the [Winner Takes All — $5 Pump.fun Replay Sprint](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3) on make.fun. It trades 10 SOL of paper money on a 6-hour pump.fun replay; the best net PnL takes the whole pot.

## Strategy: buy the dip, but only once it is already bouncing

A bonding curve that ran up and then fell hard from its recent high tends to bounce
part of the way back, while a curve that just keeps falling does not. The bot buys
only when all of these hold:

- the price is **30–40% below its recent high** (a dip, not a collapse),
- it has already **recovered 5% from the dip low** (a bounce, not a fall),
- the curve is at least **300 slots old** and holds at least **12 SOL** of real reserve.

It buys in 0.1 SOL tranches (up to 1 SOL per position, adding while the dip holds
near the first entry), and sells everything on a **+30% take-profit**, a **−9%
stop-loss**, or after **600 slots held**. One entry per coin over the whole run —
re-entering the same coin after an exit lost money in grading, so a coin gets
exactly one shot.

Everything is a pure function of the batches the harness sends: no clock, no
randomness, no I/O beyond stdin/stdout, so the two graded executions produce
byte-identical action logs.

## Dev grade (local, process driver)

- **Net PnL +0.926 SOL** (90% interval −1.318…+3.326), 425 fills over 45 coins,
  45 round trips, win rate 35.6%, max drawdown 13.3%
- Guardrails met: 45 coins hold a round trip of at least 0.01 SOL, drawdown ok
- Stress (10 rebuilt copies of the dev window): median −2.27 SOL, 10 of 10 lost —
  the copies are built from trade blocks that destroy the dip→bounce edge by
  construction, so they show how much the dev score leans on this window's coins,
  not a forecast of the final window, which is real fresh data.
