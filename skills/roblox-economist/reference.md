# Roblox platform rules for pricing and monetization

Each line paraphrases an official Roblox page, read on 2026-11-26. Most pages carry no date. Roblox changes these rules: open the page again before you hard-code a number from it. A fact that isn't here, or is marked not found, needs a new source before you rely on it.

## Developer products and game passes

- Developer products are repeatable purchases (currency, consumables). A one-time, permanent item belongs in a game pass. Price: 1 to 1 billion Robux. https://create.roblox.com/docs/production/monetization/developer-products
- Game passes are one-time Robux purchases that grant a permanent privilege. Repeatable items belong in developer products. https://create.roblox.com/docs/production/monetization/passes
- A minimum game pass price is not stated on the passes pages. Not found. The only figure there is 49 to 801 Robux, for a pass promoted while on sale.

## Receipts (developer products)

All from https://create.roblox.com/docs/production/monetization/developer-products and the `ProcessReceipt` entry at https://create.roblox.com/docs/reference/engine/classes/MarketplaceService

- Only one server script sets `MarketplaceService.ProcessReceipt` for the experience.
- Return `PurchaseGranted` only after the item is granted. Return `NotProcessedYet` otherwise. The page says the receipt is delivered again later, including the next time the user joins. The exact retry schedule is not stated.
- `PromptProductPurchaseFinished` does not confirm a purchase. Grant only in `ProcessReceipt`.
- Roblox keeps no per-user history of developer product purchases. The experience stores its own records.
- This skill's engineering rule, not the page's: save each receipt's `PurchaseId` in the same write as its grant, so a redelivered receipt is never granted twice.

## Pass ownership

From https://create.roblox.com/docs/production/monetization/passes

- Check with `MarketplaceService:UserOwnsGamePassAsync(userId, passId)`. It returns true during a free trial, so use `GetPassOwnershipAsync` and its `Owned` field before a permanent grant.
- `PromptGamePassPurchaseFinished` fires when the prompt closes, with the player, pass id and whether it was bought. It also fires true when a free trial starts, so confirm ownership before a permanent reward.
- The page says Roblox caches ownership internally and advises against saving "owns pass" in your own data.

## Creator's share

- Creators get 70% of the Robux spent on game passes and developer products in their experience. Roblox keeps 30% as the Marketplace Fee. https://create.roblox.com/docs/get-started/monetization
- Revenue estimates use the 70%, never the sticker price.

## Prices players see

- Managed (regional) pricing sets local prices between 30% and 100% of the default price. New items are enrolled by default and can opt out. https://create.roblox.com/docs/production/monetization/managed-pricing
- Store text that hard-codes a price can be wrong for a regional player. Read the price with `MarketplaceService:GetProductInfo`. https://devforum.roblox.com/t/introducing-regional-pricing-for-passes/3621382

## Subscriptions

- Experience subscriptions give a recurring monthly benefit while paid. Minimum Robux price 49. Check status on the server with `GetUserSubscriptionStatusAsync`. Creator share for Robux-priced subscriptions is 70%. https://create.roblox.com/docs/production/monetization/subscriptions

## Paid random items

From https://create.roblox.com/docs/production/monetization/paid-random-items

- A paid random item is a random outcome bought with Robux, or with a currency bought with Robux: prize wheels, loot chests, eggs, random upgrades, luck boosts. Indirect purchases count too (keys, spin tickets). A bundle that contains one counts as one.
- The odds of every outcome are shown as numbers before the purchase, and add up to 100%. An info icon alone is not enough.
- When `PolicyService` reports `ArePaidRandomItemsRestricted`, the player is not offered the paid random version. The page lists alternatives (a free path, a fixed disclosed order, a direct purchase).
- UK players under 18 get `ArePaidRandomItemsRestricted` set to true. https://devforum.roblox.com/t/update-on-paid-random-items-restriction-for-uk-users-under-18/3072183 (Roblox staff, 2024-07-16)

## PolicyService

- `GetPolicyInfoForPlayerAsync` yields and can error, so wrap it in `pcall` and fail closed. https://create.roblox.com/docs/reference/engine/classes/PolicyService
- That page's samples read `ArePaidRandomItemsRestricted` and `IsEligibleToPurchaseCommerceProduct`. The paid random items page adds `IsPaidItemTradingAllowed`: block trading of paid items when it is false. Other fields are not documented on these pages. Not found.

## Younger players and honest offers

- The monetization overview asks for transparent chance-based offers, discounts and urgency that are real (no false scarcity), `PolicyService` for regional and age rules, and no pushy sales language with minors. https://create.roblox.com/docs/production/monetization
- The Community Standards ban misleading metadata used to drive monetization, and removing purchased virtual content without notice. https://about.roblox.com/community-standards
- A dedicated Roblox rule on purchase pressure or deceptive monetization beyond these lines: not found.

## Economy design guidance

- Item descriptions are accurate. A season pass has a free track and a premium track, and the premium track is a superset. Non-payers still earn rewards. https://create.roblox.com/docs/production/game-design/monetization-foundations
- Plan sinks before adding sources. Estimate the expected value of an event's rewards before it runs. https://create.roblox.com/docs/production/game-design/balance-virtual-economies
