import type { Config, Context } from "@netlify/functions";
import { handleUploads } from "../../lib/handlers/uploads.js";

export default (req: Request, context: Context) => handleUploads(req, context.params.id);

export const config: Config = {
  path: ["/api/uploads", "/api/uploads/:id"],
};
