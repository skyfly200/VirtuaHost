import type { Config } from "@netlify/functions";
import { handleMcp } from "../../lib/handlers/mcp.js";

export default (req: Request) => handleMcp(req);

export const config: Config = {
  path: "/api/mcp",
};
