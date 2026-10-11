# ADR 0028: the play app keeps a save per person

Status: accepted (owner decision, 11 Oct 2026)

## Context

Phase 3 is a Nuxt chat for testers. The phone console stays; it holds one save in the browser and
one shared cap. Testers need their own saves, email sign-in, both books, a debug panel, and a way
to edit the last line and play it again. Supabase was listed for a later phase. The owner moved
the save store forward so the play app can do this, and left the hosted trial and the wizard where
they were.

## Decisions

`apps/web` is a Nuxt app. Sign-in is the Supabase email provider on the project named book: an
email and a password, with the confirmation link when the project asks for one. Saves, turns, and
charges live in that project. The browser cannot read or write those tables. The server checks the
caller's token and uses the secret key.

Each account can spend $5, across every save, for the life of the account. A turn that would start
at or over the cap does not start, and the save stays as it was. Editing the last line plays the
new line from the state before that turn. The money already spent on the replaced line stays spent.

The left side lists a new Uplands game, a new pirate game, and that person's saves. The right side
shows the last turn's context size, repairs, rollbacks, outcome, and cost. It does not show the game master's
private notes. Both panels open and close, including on a phone.

## Consequences

The phone console and its Vercel project are unchanged. The owner switched this from Google to the
email provider on the project named book. Confirmation links need the site origin on the redirect
list. The Phase 3 tester gate is still open: the app is the place they play, and the pass is still
that they continue unprompted.
