import { createClient } from "@supabase/supabase-js";
import { createProvider } from "@book/llm";
import type { LLMProvider } from "@book/schema";
import type { H3Event } from "h3";
import { SupabasePlayDb } from "../lib/supabase-db.ts";
import type { PlayView } from "../../shared/play.ts";
import type { PlayOutcome } from "../lib/session.ts";

function configured(event: H3Event): { url: string; publishable: string; secret: string } {
  const config = useRuntimeConfig(event);
  const url = config.public.supabaseUrl;
  const publishable = config.public.supabaseKey;
  const secret = config.supabaseSecretKey;
  if (!url || !publishable || !secret) {
    throw createError({
      statusCode: 500,
      statusMessage: "Not configured",
      data: { error: "Supabase URL, publishable key, and secret key are not set." },
    });
  }
  return { url, publishable, secret };
}

export function playDatabase(event: H3Event): SupabasePlayDb {
  const { url, secret } = configured(event);
  const client = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  return new SupabasePlayDb(client);
}

export async function requireUserId(event: H3Event): Promise<string> {
  const { url, publishable } = configured(event);
  const header = getHeader(event, "authorization") ?? "";
  const token = /^Bearer\s+(\S+)/i.exec(header)?.[1];
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: "Sign in", data: { error: "Sign in first." } });
  }
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    throw createError({ statusCode: 401, statusMessage: "Sign in", data: { error: "Sign in again." } });
  }
  return data.user.id;
}

export function storyModel(): LLMProvider {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw createError({
      statusCode: 500,
      statusMessage: "No model key",
      data: { error: "ANTHROPIC_API_KEY is not set on the server." },
    });
  }
  return createProvider("anthropic", process.env);
}

export function sendPlay(outcome: PlayOutcome): PlayView {
  if (!outcome.ok) {
    throw createError({
      statusCode: outcome.status,
      statusMessage: "Request failed",
      data: { error: outcome.error },
    });
  }
  return outcome.view;
}
