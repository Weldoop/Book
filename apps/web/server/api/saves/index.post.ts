import { openGame } from "../../lib/session.ts";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const body = await readBody(event);
  const configId = body && typeof body === "object" ? (body as { configId?: unknown }).configId : undefined;
  return sendPlay(await openGame(playDatabase(event), userId, configId, storyModel()));
});
