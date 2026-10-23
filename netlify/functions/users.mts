import type { Config, Context } from "@netlify/functions";
import { handleUsers } from "../../lib/handlers/users.js";

export default (req: Request, context: Context) => handleUsers(req, context.params.name);

export const config: Config = {
  path: ["/api/users", "/api/users/:name"],
};
