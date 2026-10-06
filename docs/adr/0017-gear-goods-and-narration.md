# ADR 0017: gear, goods, and narration

Status: accepted (owner decision, 5 Oct 2026)

## Context

A purchase is already two operations: `inventory.add` of one catalog item, and `stat.add` of the
price. The bag in ENGINE NOW is the whole save. That still left three kinds of object looking the
same. A phone, a wallet, and a pair of shears are things the player keeps. A pint, a cob, and a
cask are used inside the scene. A carrier bag, a receipt, and a wage envelope exist only in the
sentence. The Haiku week stored the wage as 65 wallets because Wallet was a catalog object and any
quantity was legal. The engine must not read the prose and decide which of the three it is.

## Decisions

### The sheet classifies what the book already knows

Each catalog item is gear or a good. Gear has `keeps: true`: one of them, and the player keeps it.
A good leaves `keeps` unset and can be bought, eaten, drunk, or handed on. The world sheet prints
the id, the name, gear or good, and the price. The game master copies the id. The engine checks
that id. Uplands marks the phone, rucksack, wallet, licence, textbook, gloves, and shears as gear.
The pint, the milk, the cob, and the other shop goods stay goods. Pirate marks the weapons, the
spyglass, the chart, and the letter of marque as gear. The casks and the stores stay goods, so a
second cask is still a purchase.

### A new object enters the save only through item.create

Something named for the first time, which the save must remember, is `item.create` in this turn:
id, name, `keeps` true when it is gear, and a price when it is sold. The same delta then
`inventory.add`s it and, when it is sold, `stat.add`s the price. The next turn it is on the world
sheet. Creating an id the sheet already has is refused. The game master uses the existing id.

### A finished good leaves the bag in that turn

A good can come from the sheet or from `item.create` in this turn. The price is charged in that
turn. If it is eaten, drunk, or handed over before the scene ends, the same turn
`inventory.remove`s it. If the player is still holding it when the scene ends, it stays on
Carrying. Gear stays until it is actually lost. A second copy of gear is refused.

### No operation means narration

A bag, a receipt, or an envelope is not an item. Cash is `stat.add` on cash, or on the bank when
the card pays. The engine does not invent an operation from the sentence, and it does not guess
gear or a good from the words. An operation means the game master already chose.

Money stays on the currency stats. Gear and goods are never a way to store money. There is no
second bag.

## Consequences

The world sheet, the contract, the inventory rules, and the repair all say the same thing. Tests
cover a strimmer the save remembers and will not duplicate, a pint that is drunk in the turn it is
bought, a second pint that is still allowed, a carrier bag that never becomes a row, and a create
that repeats an id already on the sheet. 409 tests pass.
