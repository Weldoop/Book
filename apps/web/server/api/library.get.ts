import { library } from "../lib/session.ts";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  return library(playDatabase(event), userId);
});
