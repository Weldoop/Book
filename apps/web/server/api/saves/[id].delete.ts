import { removeSave } from "../../lib/session.ts";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const id = getRouterParam(event, "id") ?? "";
  const outcome = await removeSave(playDatabase(event), userId, id);
  if (!outcome.ok) {
    throw createError({
      statusCode: outcome.status,
      statusMessage: "Request failed",
      data: { error: outcome.error },
    });
  }
  return { ok: true as const };
});
