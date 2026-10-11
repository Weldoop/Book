# Play app

Nuxt chat for testers. Email sign-in, one Supabase save list per account, a $5 cap, Uplands and the pirate book. The phone console is a separate app.

## Server environment

Copy `.env.example` to `.env` in this directory, or export the same names in the shell that runs Nuxt.

`SUPABASE_SECRET_KEY` and `ANTHROPIC_API_KEY` stay on the server. The publishable key is the one the browser uses to sign in.

```bash
pnpm --filter @book/web dev
```

## Supabase project

The project is named book: `https://ddosgjvegwvhxfkwzlfb.supabase.co`, with the email provider. The play tables are already there. They have row level security and no policies, so the browser cannot read them. The server uses the secret key.

Hosted projects ask a new account to confirm its email. Set the site URL to the Nuxt origin, and add `<origin>/auth/callback` to the redirect allow list, so the confirmation link returns to this app. For local play that origin is `http://localhost:3000`.

## What a tester sees

The left side starts a book or opens a save. The right side is the last turn's context size, repairs, outcome, and cost. Private notes are not on that panel. Edit last line replays the new wording from the state before that turn. The replaced line's cost stays on the account.
