import type { Config, Context } from "@netlify/functions";
import { handleSchedules } from "../../lib/handlers/schedules.js";

export default (req: Request, context: Context) => handleSchedules(req, context.params.id, context.params.action);

export const config: Config = {
  path: ["/api/schedules", "/api/schedules/:id", "/api/schedules/:id/:action"],
};
