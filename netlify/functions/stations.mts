import type { Config, Context } from "@netlify/functions";
import { handleStations } from "../../lib/handlers/stations.js";

export default (req: Request, context: Context) => handleStations(req, context.params.id, context.params.action);

export const config: Config = {
  path: ["/api/stations", "/api/stations/:id", "/api/stations/:id/:action"],
};
