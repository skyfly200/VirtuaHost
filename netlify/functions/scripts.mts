import type { Config, Context } from "@netlify/functions";
import { handleScripts } from "../../lib/handlers/scripts.js";

export default (req: Request, context: Context) => handleScripts(req, context.params.id);

export const config: Config = {
  path: ["/api/scripts", "/api/scripts/:id"],
};
