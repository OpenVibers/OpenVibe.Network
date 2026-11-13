-- phase: expand
-- What a deal costs (the owner, 11-13: "update the listings for deals"): the price of each offer in a
-- folded run of deals, the price it was before, and the shop that sells it (feed.item@1 1.1.0:
-- group.items[].price, .was and .store).
--
-- The feed's collector reads these from the source's own feed export (OpenVibe.Deals) and keeps them
-- here, so a card's group items can list them. They are facts about a public offer, not about a person.
--
-- Expand only: an older release never reads these columns, and nothing here changes an existing row.
ALTER TABLE feed_items ADD COLUMN IF NOT EXISTS price_amount double precision;
ALTER TABLE feed_items ADD COLUMN IF NOT EXISTS price_currency text COLLATE "C";
ALTER TABLE feed_items ADD COLUMN IF NOT EXISTS was_price double precision;
ALTER TABLE feed_items ADD COLUMN IF NOT EXISTS store_name text COLLATE "C";
