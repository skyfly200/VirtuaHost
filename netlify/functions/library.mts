import type { Config, Context } from "@netlify/functions";
import { handleLibrary } from "../../lib/handlers/library.js";

export default (req: Request, context: Context) => handleLibrary(req, context.params);

export const config: Config = {
  path: ["/api/library", "/api/library/:source/:kind/:name"],
};
