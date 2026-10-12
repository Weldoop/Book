import { readSave } from "../../lib/session.ts";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const id = getRouterParam(event, "id") ?? "";
  return sendPlay(await readSave(playDatabase(event), userId, id));
});
