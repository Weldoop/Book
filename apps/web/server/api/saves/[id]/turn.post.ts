import { takeTurn } from "../../../lib/session.ts";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const id = getRouterParam(event, "id") ?? "";
  const body = await readBody(event);
  const input = body && typeof body === "object" ? (body as { input?: unknown }).input : undefined;
  return sendPlay(await takeTurn(playDatabase(event), userId, id, input, storyModel()));
});
