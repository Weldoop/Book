import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./http.ts";

/** Read-only snapshot copied next to the bundled function. */
export function bundledResumeDir(moduleUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "saves");
}

/**
 * Vercel has no writable disk. Point resume at the bundled snapshot and leave
 * `BOOK_CONSOLE_LOG` unset so a turn does not try to append.
 */
export function consoleEnv(
  env: Record<string, string | undefined>,
  moduleUrl: string = import.meta.url,
): Record<string, string | undefined> {
  if (env.BOOK_CONSOLE_LOG?.trim() || env.BOOK_CONSOLE_RESUME?.trim()) return env;
  return { ...env, BOOK_CONSOLE_RESUME: bundledResumeDir(moduleUrl) };
}

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return serve(req, res, { env: consoleEnv(process.env) });
}
