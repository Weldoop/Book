import type { IncomingMessage, ServerResponse } from "node:http";
import { serve } from "./http.ts";

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return serve(req, res, { env: process.env });
}
