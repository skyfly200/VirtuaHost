import type { Config, Context } from "@netlify/functions";
import { handleOauth } from "../../lib/handlers/oauth.js";

export default (req: Request, context: Context) => handleOauth(req, context.params.provider, context.params.action);

export const config: Config = {
  path: ["/api/oauth/:provider", "/api/oauth/:provider/:action"],
};
