# ADR 0016: one purchase, two balances, and a place that is a place

Status: accepted (owner decision, 5 Oct 2026)

## Context

A one-dollar Uplands session on Haiku stayed playable, and the same session showed six bookkeeping
failures. Ordering one lager was priced as the milk, the pint, and the four-pack together, because
each of those names shares a word with the sentence, so the turn could not commit. The garden gloves
and shears were owned after the first sale (£45 became £32). Later turns restated the receipt, and
the engine bought them again until the bag held three of each. The £65 wage was added to the money
stat and also stored as 65 wallets, because Wallet is a catalog object and any quantity was legal.
"Go back out to Connor" was a trip to a place called Connor, and "walk into town" was a trip to a
place called town. A repair that came back as broken JSON ended the trip. A thread that said Monday
was stored as Wednesday 7 October, and a cancelled phone plan was opened again the same weekend.
The rent thread still said "Currently £6" after the rent had been paid.

## Decisions

### One mention, one item

A stretch of text names one catalog item. The longest name wins, so "pint of lager" is the pint.
A shared word does not select every item that contains it. "Lager" without a pack is the pint of
lager. A four-pack is named only when a pack is named. Milk is named when milk is named.

The game master tells the engine the purchase. The same delta carries `inventory.add` of that one
item and `stat.add` of its price as a negative amount on cash, or on the bank when the card pays.
The narration does not buy it. The worked example is those two ops. A second item needs its own pair.

### The bag is in the prompt

`Carrying` in ENGINE NOW is the bag from the whole save. A purchase stays on that line after the
turn has left the last six messages. The contract and the repair both say an item on that line is
already bought, so a later mention of the receipt is not a new sale.

### Already carried is not a new sale

If the player already holds at least as many as this sentence asks for, mentioning the item is not
a purchase. The delta must not `inventory.add` it or charge it again. "Another", or a count above
what they hold, is a new sale and still needs the price and the add. The engine does not invent
the remove or the payment.

### Cash and the bank are the balances

Uplands replaces the single money stat with two currency stats that still add up to £45: cash £15,
bank £30. Notes use `stat.add` on cash. The card uses `stat.add` on bank. The wallet stays one
object in the bag. A purchase may be paid from any currency stat the book defines. One
`inventory.add` of more than 12 of an object is rejected, and the repair is told to use `stat.add`
on the currency stats. Pirate keeps its own currency. A figure written inside a thread is not the
balance. ENGINE NOW is.

### A person is not a place

The travel check stays. A real named trip still has to end with `entity.move`, and a new place
still has to be created first. The engine still does not invent that move from the prose. A person
is not a destination. Town, outside, upstairs, downstairs, inside, and home are not destinations
unless the book names that place. "Go to the kitchen" and "walk to the warehouse" still count.

### An unreadable repair is asked again

When a delta repair is not valid JSON, the engine asks once more and includes a short example:
create the place if it is new, move the player, and set `at`. That ask is a format retry inside
the same repair. The engine still does not fill the operations in. If the second reply is also
unreadable, the turn continues through the existing rewrite.

### Monday is a Monday, and a finished matter stays finished for a while

If the thread text names a weekday, the due date falls on that weekday. A matter resolved in the
last 48 hours of story time cannot be opened again. After that, a new matter of the same kind can.
A resolved thread with no recorded time is left openable, so older saves are not stuck.

## Consequences

The catalog, the bag, and the two balances are checked in code. The game master is told the same
rules, including the JSON shape on a bad repair. Tests cover one lager, a second sale of gloves
already owned, Connor and "town", a stack of 65, the format retry, a Monday that is not a
Wednesday, and a resolved plan that stays closed for 48 hours. 405 tests pass.
