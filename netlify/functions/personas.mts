import type { Config, Context } from "@netlify/functions";
import { handlePersonas } from "../../lib/handlers/personas.js";

export default (req: Request, context: Context) => handlePersonas(req, context.params.id);

export const config: Config = {
  path: ["/api/personas", "/api/personas/:id"],
};
