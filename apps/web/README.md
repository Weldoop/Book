# Play app

Nuxt chat for testers. Google sign-in, one Supabase save list per account, a $5 cap, Uplands and the pirate book. The phone console is a separate app.

## Server environment

Copy `.env.example` to `.env` in this directory, or export the same names in the shell that runs Nuxt.

`SUPABASE_SECRET_KEY` and `ANTHROPIC_API_KEY` stay on the server. The publishable key is the one the browser uses to sign in.

```bash
pnpm --filter @book/web dev
```

## Supabase project

Create a project, then run `supabase/migrations/20261011160000_play.sql` in the SQL editor. The tables have row level security and no policies, so the browser cannot read them. The server uses the secret key.

In Authentication, enable Google and paste the OAuth client id and secret from Google Cloud. Set the site URL to the Nuxt origin, and add `<origin>/auth/callback` to the redirect allow list. Google's authorized redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`.

## What a tester sees

The left side starts a book or opens a save. The right side is the last turn's context size, repairs, outcome, and cost. Private notes are not on that panel. Edit last line replays the new wording from the state before that turn. The replaced line's cost stays on the account.
