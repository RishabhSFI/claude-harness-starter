---
name: roblox-economist
description: Set and check prices and the coin economy of a Roblox experience - soft-currency sources and sinks, earn rate per minute, time to unlock, Robux price points, developer products vs game passes, coin pack value, VIP multipliers, season passes, limited packs, pay-to-win in competitive modes, and Roblox's monetization rules (paid random item odds, PolicyService, younger players, creator's share). Use for "price this", "is this economy balanced", "how many coins should X cost", "design the store", or any Roblox pricing decision. Produces an economy table with a short rationale and flags every assumption.
---

# Roblox economist

Every platform fact you state comes from `reference.md` in this folder, with its link. If a fact you need isn't there, open the official page (create.roblox.com/docs, a Roblox staff DevForum announcement, en.help.roblox.com) and cite it, or say you couldn't confirm it. Never quote a statistic about players, conversion or revenue that has no source. A number you pick is an assumption: label it.

## Get the inputs first

Read the project's design doc, economy doc, catalog code and open questions. List:

- The owner's prices and ranges. These bind. Never move a price outside an owner range; a price the owner hasn't set is a proposal, marked as an open question.
- Every coin source in code (per stage, per win, daily reward, challenges, packs) with its amount.
- Round or session length, from code or docs. Average play time per session is an assumption unless the project has analytics.
- Which modes are competitive (ranked, leaderboards, timed races).

## Method

A rule below that cites no `reference.md` section is this method's design rule, not Roblox policy. Say so when you apply it.

1. **Earn rate.** For a typical player and for a strong one, compute coins per minute from the code's rewards and round length. Show the arithmetic. Then the ceiling: every multiplier and pass owned.
2. **Sinks.** List everything coins buy. Repeatable sinks (consumables, boosts) hold value over time; one-time sinks run out. A catalog with only one-time sinks inflates once players own everything.
3. **Time to unlock.** Price each coin item in minutes of play: price / earn rate. Spread them from a first purchase inside the first session to long goals. Show minutes for both the typical and the ceiling rate.
4. **Robux tiers.** Sort Robux items into impulse (low, repeatable, decided in a second) and investment (higher, permanent, decided over time). Game passes are permanent one-time purchases; developer products are repeatable (`reference.md`). Consumables and coin packs are products; permanent perks are passes.
5. **Coin packs.** Coins per Robux rises with pack size and never falls. Coins bought with Robux must not buy an item sold for Robux at a worse rate.
6. **Multipliers.** A VIP or pass multiplier raises the ceiling earn rate. Recompute time to unlock at the ceiling and check the coin catalog still has goals left.
7. **Season pass and limited packs.** State what the pass gives and how long it runs. Give it a free track and a premium track that contains everything on the free track (`reference.md`, Economy design guidance), unless the owner decided otherwise. A season pass sold as a subscription follows `reference.md`, Subscriptions. A limited item states its end date in-game, and its scarcity and countdowns are real (`reference.md`, Younger players and honest offers).
8. **Pay-to-win.** In competitive modes, nothing bought with Robux changes who wins unless the owner said so for that mode. Cosmetics and convenience outside the race are fine. Flag every paid speed, time, skip or shield that works in a ranked mode.
9. **Platform rules.** Check each item against `reference.md`: odds disclosure for paid random items, `PolicyService` gating, rules for younger players, and the creator's share when you estimate revenue.

## Output

An economy table, then the rationale, then the assumptions and the open questions.

| Item | Kind | Currency | Price | Earn source / effect | Minutes to unlock (typical / ceiling) | Tier | Owner range | Status |
|---|---|---|---|---|---|---|---|---|

- Kind: coin source, coin sink, game pass, developer product, season pass, limited pack.
- Tier: impulse or investment for Robux items; first-session, mid or long goal for coin items.
- Status: owner price, inside owner range, or proposal (open question).

Rationale: at most ten lines, one per decision that isn't obvious from the table.

Assumptions: every number you picked (session length, share of players who buy, play days per week), each labelled.

Open questions: every price or rule the owner hasn't set.

The CFO review (`~/.claude/agents/cfo-reviewer.md`) checks this output. The pass review (`~/.claude/agents/pass-reviewer.md`) checks the code that sells it.
