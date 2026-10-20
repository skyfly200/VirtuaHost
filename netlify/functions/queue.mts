import type { Config, Context } from "@netlify/functions";
import { handleQueue } from "../../lib/handlers/queue.js";

export default (req: Request, context: Context) => handleQueue(req, context.params.id);

export const config: Config = {
  path: ["/api/queue", "/api/queue/:id"],
};
