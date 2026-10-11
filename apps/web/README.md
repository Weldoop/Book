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

## Vercel

Use a new Vercel project. The phone console project, and the repo-root `vercel.json`, stay as they are.

- Root Directory: `apps/web`
- Include source files outside the Root Directory: on. The build installs the pnpm workspace and compiles the engine packages.
- Production branch: `cursor/phase3-nuxt-4962` until this app is on `main`. `main` does not contain `apps/web`.

`apps/web/vercel.json` sets the Nuxt framework, installs pnpm 10.33.3 from the repo root, and builds `@book/web`. Story turns use the same 60 second function limit as the phone console.

Set these before the first build. Nuxt copies them into the server config at build time:

- `SUPABASE_URL` — `https://ddosgjvegwvhxfkwzlfb.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY` — the publishable key
- `SUPABASE_SECRET_KEY` — the secret key
- `ANTHROPIC_API_KEY`

When the deployment has a host, set the Supabase site URL to `https://<host>` and add `https://<host>/auth/callback` to the redirect allow list.

## What a tester sees

The left side starts a book or opens a save. The right side is the last turn's context size, repairs, outcome, and cost. Private notes are not on that panel. Edit last line replays the new wording from the state before that turn. The replaced line's cost stays on the account.
