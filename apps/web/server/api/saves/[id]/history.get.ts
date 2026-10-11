import { readHistory } from "../../../lib/session.ts";
import type { HistoryPage } from "../../../../shared/play.ts";

export default defineEventHandler(async (event): Promise<HistoryPage> => {
  const userId = await requireUserId(event);
  const id = getRouterParam(event, "id") ?? "";
  const before = getQuery(event).before;
  const cursor = typeof before === "string" ? before : "";
  const outcome = await readHistory(playDatabase(event), userId, id, cursor);
  if (!outcome.ok) {
    throw createError({
      statusCode: outcome.status,
      statusMessage: "Request failed",
      data: { error: outcome.error },
    });
  }
  return outcome.page;
});
