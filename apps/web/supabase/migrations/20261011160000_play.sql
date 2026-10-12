-- Play app. The browser never queries these tables.
-- Row level security is on and there are no policies, so the anon and
-- authenticated roles cannot read or write. The server uses the secret key.

create table public.saves (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  config_id text not null,
  title text not null,
  turn integer not null,
  ended boolean not null default false,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create index saves_user_updated_idx on public.saves (user_id, updated_at desc);

create table public.turns (
  id text primary key,
  save_id text not null references public.saves (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  input text not null,
  outcome text not null,
  record jsonb not null,
  state_before jsonb not null,
  cost_usd numeric not null check (cost_usd >= 0),
  lines jsonb not null,
  suggestions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index turns_save_created_idx on public.turns (save_id, created_at);

create table public.charges (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  save_id text,
  cost_usd numeric not null check (cost_usd >= 0),
  created_at timestamptz not null default now()
);

create index charges_user_idx on public.charges (user_id);

alter table public.saves enable row level security;
alter table public.turns enable row level security;
alter table public.charges enable row level security;

alter table public.saves force row level security;
alter table public.turns force row level security;
alter table public.charges force row level security;

revoke all on table public.saves from public, anon, authenticated;
revoke all on table public.turns from public, anon, authenticated;
revoke all on table public.charges from public, anon, authenticated;

grant all on table public.saves, public.turns, public.charges to service_role;
grant usage, select on sequence public.charges_id_seq to service_role;
