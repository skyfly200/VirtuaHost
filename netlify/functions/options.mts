import type { Config } from "@netlify/functions";
import { handleOptions } from "../../lib/handlers/options.js";

export default (req: Request) => handleOptions(req);

export const config: Config = {
  path: "/api/options",
};
